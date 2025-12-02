import * as vscode from 'vscode';
import net from 'node:net';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readConfig } from './configUtils';
import { ModelBridgeConfig } from './types';
import { getMcpClient, callTool } from './mcpClient';
import { runOrchestrator } from './orchestrator';
import { logger } from './logger';
import { getLatestStatusSnapshot } from './mcpClient';


interface BridgeResponder {
  respond(status: number, body: unknown): void;
}

function genRequestId() {
  return `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}
function safeJson(value: unknown) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function sha1(input: string) {
  return crypto.createHash('sha1').update(input).digest('hex');
}

function normalizeWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function defaultSocketPath() {
  const workspaceRoot = normalizeWorkspaceRoot();
  const fp = workspaceRoot ? sha1(workspaceRoot).slice(0, 8) : sha1(process.cwd()).slice(0, 8);
  if (process.platform === 'win32') {
    return String.raw`\\.\pipe\gemini-mcp-${fp}`;
  }
  if (workspaceRoot) {
    return path.join(workspaceRoot, '.vscode', 'gemini-mcp', `bridge-${fp}.sock`);
  }
  return path.join(os.tmpdir(), `gemini-mcp-${fp}.sock`);
}

async function tryConnectOnce(socketPath: string, timeout = 200) {
  return new Promise<void>((resolve, reject) => {
    const s = net.connect(socketPath, () => {
      s.destroy();
      resolve();
    });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('connect timeout'));
    }, timeout);
    s.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function startStdioBridge(cfg: any, onConnection?: (socket: import('node:net').Socket, cfg?: any) => void) {
  const chosen = defaultSocketPath();
  let socketPath = chosen;
  if (process.platform !== 'win32') {
    const dir = path.dirname(socketPath);
    try {
      await fsPromises.mkdir(dir, { recursive: true });
    } catch {}
  }

  if (process.platform !== 'win32' && fs.existsSync(socketPath)) {
    try {
      await tryConnectOnce(socketPath, 200);
      logger.info('modelBridge: existing active socket', { socketPath });
      return { server: null as any, path: socketPath, active: true };
    } catch (e) {
      try { fs.unlinkSync(socketPath); } catch (err) {
        logger.warn('modelBridge: failed to remove stale socket', { socketPath, error: String(err) });
      }
    }
  }

  const server = net.createServer((socket) => {
    if (typeof onConnection === 'function') {
      try {
        onConnection(socket, cfg);
        return;
      } catch (e) {
          logger.warn('modelBridge: onConnection handler threw', String(e));
      }
    }
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!raw) continue;
        try {
          const payload = JSON.parse(raw);
            logger.info('[stdio bridge request] ' + JSON.stringify(payload).slice(0,2000));
        } catch (err) {
          logger.warn('[stdio bridge] json parse error', String(err));
        }
      }
    });
    socket.on('error', (err) => logger.warn(`ModelBridge stdio client socket error: ${String(err)}`));
  });

  let attempts = 0;
  const maxAttempts = 3;
  while (true) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
          server.removeAllListeners('error');
          resolve();
        });
      });
      break;
    } catch (err: any) {
      attempts += 1;
      const msg = String(err && err.message);
      if (msg && msg.toLowerCase().includes('eaddrinuse') && attempts < maxAttempts) {
        try {
          await tryConnectOnce(socketPath, 200);
          logger.info('modelBridge: socket in use by active server', { socketPath });
          return { server: null as any, path: socketPath, active: true };
        } catch {
          try { fs.unlinkSync(socketPath); } catch {}
          socketPath = socketPath + `.${process.pid}`;
          continue;
        }
      }
      throw err;
    }
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(socketPath, 0o600); } catch (err) { logger.warn('modelBridge: chmod failed', { socketPath, error: String(err) }); }
  }

    try {
      // Do not write status.json on the extension side. Use MCP notifications
      // (server -> extension) as the authoritative channel for status. Record
      // the socket path in-memory and log it so users can see it in the Output.
      const workspaceRoot = normalizeWorkspaceRoot();
      try {
        const snapshot = getLatestStatusSnapshot();
        if (snapshot && snapshot.stdioPath) {
          logger.info('modelBridge: server already reports stdioPath', { serverStdioPath: snapshot.stdioPath });
        }
      } catch {}
      logger.info('modelBridge: socket available (in-memory)', { socketPath });
    } catch {}

  server.on('close', () => {
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(socketPath); } catch {}
    }
    logger.info('modelBridge: server closed and cleaned', { socketPath });
  });

  logger.info('modelBridge: listening', { socketPath });
  return { server, path: socketPath, active: false };
}

export async function stopStdioBridge(server: net.Server | null, socketPath?: string) {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (socketPath && process.platform !== 'win32') {
    try { fs.unlinkSync(socketPath); } catch {}
  }
  logger.info('modelBridge: stopped');
}


export class ModelBridge implements vscode.Disposable {
  private stdioServer?: net.Server;
  private stdioListener?: string;
  private activeCalls: Map<string, { tool: string; startedAt: number; timedOut?: boolean; controller?: AbortController }> = new Map();
  private concurrentLimit = 4;
  private currentConcurrent = 0;
  private pendingQueue: Array<() => void> = [];
  constructor() {}

  async start() {
    await this.stop();
    const cfg = this.getBridgeConfig();
    if (!cfg.enabled) {
      logger.info('ModelBridge: disabled via configuration.');
      return;
    }

    try {
        const res = await startStdioBridge(cfg, (socket) => this.handleStdioConnection(socket, cfg));
      if (res && res.server) {
        this.stdioServer = res.server;
        this.stdioListener = res.path;
        logger.info(`ModelBridge: stdio bridge listening on ${res.path}`);
      } else if (res && res.active) {
        logger.info(`ModelBridge: stdio bridge detected active listener at ${res.path}`);
      }
    } catch (error) {
      logger.warn(`ModelBridge: failed to start stdio bridge: ${String(error)}`);
    }
  }

  async stop() {
    // stop stdio server
    if (this.stdioServer) {
      await stopStdioBridge(this.stdioServer, this.stdioListener).catch(() => {});
      this.stdioServer = undefined;
      this.stdioListener = undefined;
    }
  }

  async restart() {
    await this.start();
  }

  dispose() {
    void this.stop();
  }

  private getBridgeConfig(): ModelBridgeConfig {
    const cfg = readConfig();
    return cfg.modelBridge;
  }

  

  private handleStdioConnection(socket: net.Socket, cfg: ModelBridgeConfig) {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!raw) {
          continue;
        }
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch (error) {
          this.writeStdioResponse(socket, undefined, 400, { error: 'invalid_json', message: String(error) });
          continue;
        }
        const responder = this.createStdioResponder(socket, payload.id ?? payload.requestId);
        // no token/auth checks in local stdio mode
        const type = payload.type ?? (payload.toolName ? 'callTool' : 'health');
        void this.dispatchStdioCommand(type, payload, cfg, responder);
      }
    });
    socket.on('error', (error) => {
      logger.warn(`ModelBridge: stdio client error ${String(error)}`);
    });
  }

  private async dispatchStdioCommand(type: string, payload: any, cfg: ModelBridgeConfig, responder: BridgeResponder) {
    switch (type) {
      case 'health':
        responder.respond(200, { ok: true });
        break;
      case 'callTool':
        await this.executeToolRequest(payload, cfg, responder);
        break;
      case 'orchestrate':
        await this.runOrchestrator(cfg, responder);
        break;
      default:
        responder.respond(400, { error: 'unknown_command', command: type });
    }
  }

  private async executeToolRequest(payload: any, cfg: ModelBridgeConfig, responder: BridgeResponder) {
    const toolName = payload.toolName as string | undefined;
    const requestId = payload.id ?? payload.requestId ?? genRequestId();
    if (!toolName) {
      responder.respond(400, { id: requestId, error: 'tool_required' });
      return;
    }
    if (cfg.allowedTools.length > 0 && !cfg.allowedTools.includes(toolName)) {
      responder.respond(403, { id: requestId, error: 'tool_not_allowed', tool: toolName });
      return;
    }
    try {
      const config = readConfig();
      const cached = await getMcpClient(config);
      const client = (cached && cached.client) ? cached.client : undefined;
      if (!client) {
        responder.respond(503, { id: requestId, error: 'mcp_unavailable' });
        return;
      }
      // acquire concurrency slot
      await this.acquireSlot();
      this.activeCalls.set(requestId, { tool: toolName, startedAt: Date.now() });
      logger.info(`[req=${requestId}] start tool=${toolName}`);
      try {
        const timeoutMs = (cfg as any).requestTimeoutMs ?? 120000; // default 2min
        const controller = new AbortController();
        // attach controller so we can abort on demand / mark timed out
        const entry = this.activeCalls.get(requestId) || { tool: toolName, startedAt: Date.now() };
        entry.controller = controller;
        this.activeCalls.set(requestId, entry);

        const callRes = await callTool(client, toolName, payload.args ?? {}, { signal: controller.signal, timeout: timeoutMs });
        const result = (callRes && typeof callRes === 'object' && 'result' in callRes) ? callRes.result : callRes;
        logger.info(`[req=${requestId}] done tool=${toolName}`);
        responder.respond(200, { id: requestId, success: true, response: safeJson(result) });
      } catch (error) {
        const errAny = error as any;
        const msg = String(errAny?.message ?? errAny ?? 'unknown');
        const isTimeout = msg.toLowerCase().includes('request timed out') || msg.toLowerCase().includes('timeout');
        if (isTimeout) {
          // mark as timed out and abort the controller (this will trigger SDK cancellation notification)
          const callInfo = this.activeCalls.get(requestId);
            if (callInfo) {
            callInfo.timedOut = true;
            try { callInfo.controller?.abort(new Error('local-timeout')); } catch { /* ignore */ }
            logger.warn(`[req=${requestId}] timeout tool=${toolName}`);
          }
          responder.respond(504, { id: requestId, error: 'tool_timeout', message: msg });
        } else {
          const code = 'tool_failed';
          logger.warn(`[req=${requestId}] error tool=${toolName} message=${msg}`);
          responder.respond(500, { id: requestId, error: code, message: msg });
        }
      } finally {
        this.activeCalls.delete(requestId);
        logger.info(`[req=${requestId}] cleaned tool=${toolName}`);
        this.releaseSlot();
      }
    } catch (error) {
      const msg = String((error as any)?.message ?? error ?? 'unknown');
      const code = msg === 'timeout' ? 'tool_timeout' : 'tool_failed';
      const status = msg === 'timeout' ? 504 : 500;
      responder.respond(status, { id: requestId, error: code, message: msg });
    }
  }

  private acquireSlot(): Promise<void> {
    return new Promise((resolve) => {
      if (this.currentConcurrent < this.concurrentLimit) {
        this.currentConcurrent++;
        resolve();
        return;
      }
      this.pendingQueue.push(() => {
        this.currentConcurrent++;
        resolve();
      });
    });
  }

  private releaseSlot() {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
    const next = this.pendingQueue.shift();
    if (next) next();
  }

  private async runOrchestrator(cfg: ModelBridgeConfig, responder: BridgeResponder) {
    if (!cfg.allowOrchestrator) {
      responder.respond(403, { error: 'orchestrator_disabled' });
      return;
    }
    try {
      const config = readConfig();
      await runOrchestrator(config);
      responder.respond(200, { success: true });
    } catch (error) {
      responder.respond(500, { error: 'orchestrator_failed', message: String(error) });
    }
  }

  private createStdioResponder(socket: net.Socket, requestId?: string): BridgeResponder {
    return {
      respond: (status, body) => this.writeStdioResponse(socket, requestId, status, body)
    };
  }

  private writeStdioResponse(socket: net.Socket, requestId: string | undefined, status: number, body: unknown) {
    const payload = { id: requestId, status, body };
    socket.write(`${JSON.stringify(payload)}
`);
  }

  // token/auth removed for local stdio mode
}
