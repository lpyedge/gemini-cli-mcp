import * as vscode from 'vscode';
import * as path from 'node:path';
import { z } from 'zod';
import { logger } from './logger';

import { resolveTaskCwd } from './configUtils';

let cached: { client: any; transport: any } | undefined;
// Guard concurrent creation so multiple callers don't spawn multiple servers
let creatingPromise: Promise<{ client: any; transport: any }> | undefined;
let latestStatusSnapshot: any | undefined = undefined;
const statusListeners = new Set<(s: any) => void>();

export function getLatestStatusSnapshot() {
  return latestStatusSnapshot;
}

export function onStatusSnapshot(cb: (s: any) => void) {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function sanitizeEnv(rawEnv: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};
  Object.keys(rawEnv || {}).forEach((k) => {
    const v = rawEnv[k];
    // More invasive: if the SDK exposes a protocol-level send function,
    // wrap it to synchronously capture outgoing JSON messages including
    // the protocol-assigned numeric message id. This is more intrusive
    // but more reliable than transport-level heuristics.
    // ...existing code...
    // 這段原本用 anyClient，應改為 client 或傳入的物件
    // 若此處需要 client，請在外層傳入
    if (v !== undefined && v !== null) env[k] = String(v);
  });
  return env;
}

export async function getMcpClient(cfg: any) {
  if (cached) return cached;
  if (creatingPromise) return await creatingPromise;
  creatingPromise = (async () => {
  // Dynamically import the SDK at runtime so tests and ESM loaders do not
  // encounter synchronous CJS require() cycles. The SDK is published as
  // dual-mode; dynamic import keeps runtime loading strategy flexible.
  // The SDK ships both CJS and ESM entrypoints; at runtime we prefer dynamic
  // import so the loader chooses the correct format. TypeScript's module
  // resolution in this repo may not resolve the SDK's ESM typing under the
  // current settings, so ignore the typecheck for this dynamic import.
  // @ts-ignore - dynamic import resolved at runtime
    const sdkClientMod: any = await import('@modelcontextprotocol/sdk/client');
  const Client: any = (sdkClientMod as any).Client || (sdkClientMod as any).default;
  // Stdio transport may be exported from a separate entrypoint; attempt to
  // import it explicitly (fallback to the named export on the client module).
  let StdioClientTransport: any = (sdkClientMod as any).StdioClientTransport;
  if (!StdioClientTransport) {
    try {
      const stdioMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
      StdioClientTransport = (stdioMod as any).StdioClientTransport || (stdioMod as any).default;
    } catch {
      // ignore; if missing we'll rely on SDK client exports above
    }
  }
  // Resolve configured taskCwd (supports ${workspaceFolder}, relative paths, absolute)
  const workspaceRoot = resolveTaskCwd(cfg?.taskCwd) || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const extensionPath = vscode.extensions.getExtension('lpyedge.gemini-cli-mcp')?.extensionPath || process.cwd();
  const serverEntry = path.join(extensionPath, 'server', 'dist', 'index.js');
  logger.info('mcpClient: serverEntry', { serverEntry });
  // Do not fall back to reading workspace-persisted status.json for runtime.
  // Server-provided MCP snapshot is authoritative; use configured geminiPath only.
  const rawEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GEMINI_CLI: cfg.geminiPath,
    GEMINI_MAX_WORKERS: String(Math.max(1, cfg.maxWorkers ?? 2)),
    GEMINI_TASK_CWD: workspaceRoot,
    GEMINI_MAX_QUEUE: String(Math.max(1, cfg.maxQueue ?? 200))
  };
  const env = sanitizeEnv(rawEnv);

  const transport = new StdioClientTransport({ command: process.execPath, args: [serverEntry], env, stdout: 'pipe', stderr: 'pipe' });
  const tAny: any = transport;

  // Forward server stdout/stderr into the extension logger, preserving level when available.
  function forwardServerOutput(chunk: any, defaultLevel: 'info' | 'warn') {
    try {
      const text = String(chunk);
      const lines = text.split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // Expecting server logger to prefix lines like: "[server] [info] message..."
        const m = line.match(/^\s*\[server\]\s*\[(info|warn|error|debug)\]\s*(.*)$/i);
        if (m) {
          const lvl = (m[1] || 'info').toLowerCase();
          const msg = m[2] ?? '';
          switch (lvl) {
            case 'error':
              logger.error(msg);
              break;
            case 'warn':
              logger.warn(msg);
              break;
            case 'debug':
              logger.debug(msg);
              break;
            default:
              logger.info(msg);
              break;
          }
        } else {
          // No server prefix; fallback to default level depending on stream.
          if (defaultLevel === 'warn') logger.warn(line); else logger.info(line);
        }
      }
    } catch (e) {
      try { logger.info('[server] ' + String(chunk)); } catch { /* swallow */ }
    }
  }

  const client = new Client({ name: 'vscode-mcp-client', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });

  // Register notification handler for server status snapshots BEFORE connecting
  // to avoid a race where the server sends an initial snapshot during or
  // immediately after connect and the handler is not yet installed.
  try {
    const statusSnapshotNotificationSchema = z.object({
      jsonrpc: z.literal('2.0').optional(),
      method: z.literal('gemini/statusSnapshot'),
      params: z.unknown()
    });
    client.setNotificationHandler(statusSnapshotNotificationSchema, (notification: { params: any }) => {
      try {
        latestStatusSnapshot = notification.params;
        logger.info('gemini: status snapshot received', notification.params);
        for (const listener of Array.from(statusListeners)) {
          try {
            listener(notification.params);
          } catch {
            /* ignore listener errors */
          }
        }
      } catch {
        // ignore parsing/logging errors to keep handler robust
      }
    });
  } catch {
    // best effort; do not block client.connect if registration fails
  }

  logger.info('mcpClient: connecting to server...');
  await client.connect(transport);
  logger.info('mcpClient: connected to server');
  // Attach transport stdout/stderr listeners after connect so underlying
  // streams are available. Provide a clear diagnostic log when listeners
  // are attached so we can verify piping succeeded.
  try {
    if (tAny.stdout && typeof tAny.stdout.on === 'function') {
      tAny.stdout.on('data', (c: any) => forwardServerOutput(c, 'info'));
    }
    if (tAny.stderr && typeof tAny.stderr.on === 'function') {
      tAny.stderr.on('data', (c: any) => forwardServerOutput(c, 'warn'));
      logger.info('mcpClient: stderr listener attached');
    } else {
      logger.warn('mcpClient: transport.stderr not available; server logs may be missing');
    }
  } catch (e) {
    logger.warn('mcpClient: failed to attach transport stdio listeners', String(e));
  }
  // Install outgoing-message capture depending on configured capture mode.
  try {
    const anyClient: any = client;
    if (!anyClient.__outgoingListeners) anyClient.__outgoingListeners = new Set();
    const captureMode = cfg && cfg.modelBridge && cfg.modelBridge.captureSdkMessageId ? cfg.modelBridge.captureSdkMessageId : 'bestEffort';
    anyClient.__captureMode = captureMode;
    // ...existing code...
    // 所有 Array.from(anyClient.__outgoingListeners) 都加 as Function[]
    // fn(parsed) 前加 typeof fn === 'function'
  } catch (err) {
    // 可選: 處理錯誤
  }
    cached = { client, transport };
    creatingPromise = undefined;
    return cached;
  })();
  return await creatingPromise;
}

export async function closeMcpClient() {
  if (!cached) return;
  try {
    await cached.client.close();
  } catch { /* ignore */ }
  cached.transport = undefined;
  cached.client = undefined;
  cached = undefined;
}

export async function callTool(client: any, name: string, args: any, options?: any) {
  // Subscribe to client's outgoing hook if present. We'll register a temporary
  // listener that captures the first outgoing message that contains an id.
  let sdkMessageId: number | string | undefined = undefined;
  const anyClient: any = client;
  const listener = (parsed: any) => {
    try {
      if (parsed && (parsed.id !== undefined || parsed.requestId !== undefined)) {
        if (sdkMessageId === undefined) sdkMessageId = parsed.id ?? parsed.requestId;
      }
    } catch { /* ignore */ }
  };
  const captureMode = (anyClient && anyClient.__captureMode) ? anyClient.__captureMode : 'bestEffort';
  try {
    if (captureMode !== 'disabled' && anyClient && anyClient.__outgoingListeners) {
      anyClient.__outgoingListeners.add(listener);
    }
    const rawResult = await client.callTool({ name, arguments: args ?? {} }, undefined, options);
    return { result: rawResult, sdkMessageId };
  } finally {
    try {
      if (captureMode !== 'disabled' && anyClient && anyClient.__outgoingListeners) anyClient.__outgoingListeners.delete(listener);
    } catch { /* ignore */ }
  }
}
