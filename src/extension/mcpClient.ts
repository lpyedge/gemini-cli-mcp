import * as vscode from 'vscode';
import path from 'node:path';
declare const require: any;
const Client: any = require('@modelcontextprotocol/sdk/client').Client;
const StdioClientTransport: any = require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport;

let cached: { client: any; transport: any } | undefined;

function sanitizeEnv(rawEnv: NodeJS.ProcessEnv) {
  const env: Record<string, string> = {};
  Object.keys(rawEnv || {}).forEach((k) => {
    const v = rawEnv[k];
    // More invasive: if the SDK exposes a protocol-level send function,
    // wrap it to synchronously capture outgoing JSON messages including
    // the protocol-assigned numeric message id. This is more intrusive
    // but more reliable than transport-level heuristics.
    try {
      const protocol = anyClient._protocol || anyClient.protocol || anyClient._protocol;
      if (protocol) {
        const sendFn = protocol._send || protocol.send || (protocol._transport && protocol._transport.send) || (protocol._transport && protocol._transport.write);
        if (typeof sendFn === 'function') {
          const keyAndObj: { obj: any; key: string }[] = [];
          if (protocol._send && typeof protocol._send === 'function') keyAndObj.push({ obj: protocol, key: '_send' });
          if (protocol.send && typeof protocol.send === 'function') keyAndObj.push({ obj: protocol, key: 'send' });
          if (protocol._transport && typeof protocol._transport.send === 'function') keyAndObj.push({ obj: protocol._transport, key: 'send' });
          if (protocol._transport && typeof protocol._transport.write === 'function') keyAndObj.push({ obj: protocol._transport, key: 'write' });

          const invasiveRestorers: Array<() => void> = [];
          for (const { obj, key } of keyAndObj) {
            const orig = obj[key];
            const wrapped = function (payload: any) {
              try {
                const raw = typeof payload === 'string' ? payload : (payload && payload.toString ? payload.toString() : String(payload));
                const m = raw.match(/\{[\s\S]*?\}/);
                if (m) {
                  try {
                    const parsed = JSON.parse(m[0]);
                    // record last outgoing parsed message for callers
                    try { anyClient.__lastOutgoing = parsed; } catch { }
                    if (anyClient.__outgoingListeners) {
                      for (const fn of Array.from(anyClient.__outgoingListeners)) {
                        try { fn(parsed); } catch { }
                      }
                    }
                  } catch { /* ignore JSON parse */ }
                }
              } catch { /* ignore */ }
              return orig.apply(this, arguments as any);
            };
            obj[key] = wrapped;
            invasiveRestorers.push(() => { obj[key] = orig; });
          }
          // attach restore to client for debugging/cleanup
          anyClient.__restoreProtocolOutgoing = () => {
            for (const r of invasiveRestorers) {
              try { r(); } catch { }
            }
          };
        }
      }
    } catch { /* ignore invasive wrap errors */ }
    if (v !== undefined && v !== null) env[k] = String(v);
  });
  return env;
}

export async function getMcpClient(cfg: any, output?: vscode.OutputChannel) {
  if (cached) return cached;
  const workspaceRoot = cfg.taskCwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const extensionPath = vscode.extensions.getExtension('lpyedge.gemini-cli-mcp')?.extensionPath || process.cwd();
  const serverEntry = path.join(extensionPath, 'server', 'dist', 'index.js');
  if (output) output.appendLine(`mcpClient: serverEntry=${serverEntry}`);

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
  tAny.stdout?.on && tAny.stdout?.on('data', (c: any) => output?.appendLine(`[server stdout] ${String(c)}`));
  tAny.stderr?.on && tAny.stderr?.on('data', (c: any) => output?.appendLine(`[server stderr] ${String(c)}`));

  const client = new Client({ name: 'vscode-mcp-client', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } });
  await client.connect(transport);
  // Install outgoing-message capture depending on configured capture mode.
  try {
    const anyClient: any = client;
    if (!anyClient.__outgoingListeners) anyClient.__outgoingListeners = new Set();

    const captureMode = cfg && cfg.modelBridge && cfg.modelBridge.captureSdkMessageId ? cfg.modelBridge.captureSdkMessageId : 'bestEffort';
    anyClient.__captureMode = captureMode;

    // If disabled, skip installing any hooks.
    if (captureMode === 'disabled') {
      if (output) output.appendLine('mcpClient: sdk message-id capture disabled by config');
    } else {
      // Try to prefer a stable SDK-provided hook (if the SDK exposes one).
      let sdkHookRegistered = false;
      const sdkUnregisters: Array<() => void> = [];
      try {
        const possibleEvents = ['outgoing', 'outgoingMessage', 'messageSent', 'message:sent', 'send'];
        for (const ev of possibleEvents) {
          try {
            if (typeof anyClient.on === 'function') {
              const listener = (payload: any) => {
                try {
                  // If SDK provides structured payloads, use them directly.
                  let parsed = payload;
                  if (typeof payload === 'string') {
                    const m = payload.match(/\{[\s\S]*?\}/);
                    if (m) parsed = JSON.parse(m[0]);
                  }
                  if (parsed) {
                    try { anyClient.__lastOutgoing = parsed; } catch { }
                    if (anyClient.__outgoingListeners) {
                      for (const fn of Array.from(anyClient.__outgoingListeners)) {
                        try { fn(parsed); } catch { }
                      }
                    }
                  }
                } catch { /* ignore listener errors */ }
              };
              // try registering; some SDKs expose `on`/`off`, others provide `removeListener`.
              try {
                anyClient.on(ev, listener);
                sdkUnregisters.push(() => { try { if (typeof anyClient.off === 'function') anyClient.off(ev, listener); else if (typeof anyClient.removeListener === 'function') anyClient.removeListener(ev, listener); } catch { } });
                sdkHookRegistered = true;
                if (output) output.appendLine(`mcpClient: registered SDK hook event='${ev}'`);
                break;
              } catch { /* ignore individual event registration errors */ }
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      // If we didn't find an SDK hook and the mode allows, install the
      // existing best-effort transport/protocol wrappers as a fallback.
      if (!sdkHookRegistered && captureMode === 'bestEffort') {
        if (output) output.appendLine('mcpClient: no SDK hook found — installing best-effort transport/protocol wrappers');
        const notifyListeners = (parsed: any) => {
          try {
            for (const fn of Array.from(anyClient.__outgoingListeners)) {
              try { fn(parsed); } catch { /* ignore listener errors */ }
            }
          } catch { /* ignore */ }
        };

        const tryWrap = (obj: any) => {
          if (!obj) return null;
          const sendKey = typeof obj.send === 'function' ? 'send' : (typeof obj.write === 'function' ? 'write' : null);
          if (!sendKey) return null;
          const original = obj[sendKey];
          obj[sendKey] = function (payload: any) {
            try {
              const raw = typeof payload === 'string' ? payload : (payload && payload.toString ? payload.toString() : String(payload));
              const m = raw.match(/\{[\s\S]*?\}/);
              if (m) {
                try {
                  const parsed = JSON.parse(m[0]);
                  notifyListeners(parsed);
                } catch { /* ignore parse errors */ }
              }
            } catch { /* ignore */ }
            return original.apply(this, arguments as any);
          };
          return () => { obj[sendKey] = original; };
        };

        const candidates = [transport, (anyClient && anyClient.transport), (anyClient._transport), (anyClient._protocol && anyClient._protocol.transport), (anyClient._protocol && anyClient._protocol._transport)];
        const restorers: Array<() => void> = [];
        for (const c of candidates) {
          try {
            const r = tryWrap(c);
            if (r) restorers.push(r);
          } catch { /* ignore */ }
        }
        anyClient.__restoreOutgoing = () => {
          for (const r of restorers) {
            try { r(); } catch { /* ignore */ }
          }
        };

        try {
          const protocol = anyClient._protocol || anyClient.protocol || (anyClient && anyClient._protocol);
          if (protocol && typeof protocol.request === 'function') {
            const origRequest = protocol.request.bind(protocol);
            protocol.request = function (...args: any[]) {
              const one = (parsed: any) => {
                try {
                  if (parsed && (parsed.id !== undefined || parsed.requestId !== undefined)) {
                    if (!anyClient.__lastOutgoing) anyClient.__lastOutgoing = parsed;
                  }
                } catch { /* ignore */ }
              };
              try {
                if (!anyClient.__outgoingListeners) anyClient.__outgoingListeners = new Set();
                anyClient.__outgoingListeners.add(one);
                const res = origRequest(...args);
                if (res && typeof res.then === 'function') {
                  return res.finally(() => { try { anyClient.__outgoingListeners.delete(one); } catch { } });
                }
                try { anyClient.__outgoingListeners.delete(one); } catch { }
                return res;
              } catch (err) {
                try { anyClient.__outgoingListeners.delete(one); } catch { }
                throw err;
              }
            };
          }
        } catch { /* ignore protocol wrap errors */ }
      } else if (sdkHookRegistered) {
        // expose an API to restore sdk-registered listeners
        anyClient.__restoreSdkOutgoing = () => {
          for (const u of sdkUnregisters) {
            try { u(); } catch { }
          }
        };
      }
    }
  } catch (err) {
    // best-effort only; swallow any installation errors
    if (output) output.appendLine(`mcpClient: outgoing hook installation error: ${String(err)}`);
  }
  cached = { client, transport };
  return cached;
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
    // Normalize return shape: earlier code expected either rawResult or { result, sdkMessageId }
    return { result: rawResult, sdkMessageId };
  } finally {
    try {
      if (captureMode !== 'disabled' && anyClient && anyClient.__outgoingListeners) anyClient.__outgoingListeners.delete(listener);
    } catch { /* ignore */ }
  }
}
