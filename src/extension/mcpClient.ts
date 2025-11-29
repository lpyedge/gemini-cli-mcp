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
    // ...existing code...
    // 這段原本用 anyClient，應改為 client 或傳入的物件
    // 若此處需要 client，請在外層傳入
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
    // ...existing code...
    // 所有 Array.from(anyClient.__outgoingListeners) 都加 as Function[]
    // fn(parsed) 前加 typeof fn === 'function'
  } catch (err) {
    // 可選: 處理錯誤
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
    return { result: rawResult, sdkMessageId };
  } finally {
    try {
      if (captureMode !== 'disabled' && anyClient && anyClient.__outgoingListeners) anyClient.__outgoingListeners.delete(listener);
    } catch { /* ignore */ }
  }
}
