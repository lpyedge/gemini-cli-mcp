import * as vscode from 'vscode';
import http, { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from './configUtils';
import { ModelBridgeConfig } from './types';
import { getMcpClient, callTool } from './mcpClient';
import { runOrchestrator } from './orchestrator';

const STDIO_DEFAULT_PATH = os.platform() === 'win32'
  ? String.raw`\\.\pipe\gemini-mcp-bridge`
  : path.join(os.tmpdir(), 'gemini-mcp-bridge.sock');

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

function parseRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const buffers: Buffer[] = [];
    req.on('data', (chunk) => buffers.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(buffers).toString('utf8')));
    req.on('error', reject);
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function respondNotFound(res: ServerResponse) {
  respondJson(res, 404, { error: 'not_found' });
}

function respondUnauthorized(res: ServerResponse) {
  respondJson(res, 401, { error: 'unauthorized' });
}

export class ModelBridge implements vscode.Disposable {
  private httpServer?: http.Server;
  private stdioServer?: net.Server;
  private stdioListener?: string;
  private activeCalls: Map<string, { tool: string; startedAt: number; timedOut?: boolean; controller?: AbortController; sdkMessageId?: number | string }> = new Map();
  private concurrentLimit = 4;
  private currentConcurrent = 0;
  private pendingQueue: Array<() => void> = [];

  constructor(private output: vscode.OutputChannel) {}

  async start() {
    await this.stop();
    const cfg = this.getBridgeConfig();
    if (!cfg.enabled) {
      this.output.appendLine('ModelBridge: disabled via configuration.');
      return;
    }

    const tasks: Promise<void>[] = [];
    if (cfg.mode === 'stdio' || cfg.mode === 'both') {
      tasks.push(this.startStdio(cfg));
    }
    if (cfg.mode === 'http' || cfg.mode === 'both') {
      tasks.push(this.startHttp(cfg));
    }

    await Promise.all(tasks.map((p) =>
      p.catch((error) => this.output.appendLine(`ModelBridge: failed to start ${cfg.mode} bridge: ${String(error)}`))
    ));
  }

  async stop() {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
      this.output.appendLine('ModelBridge: HTTP bridge stopped.');
      this.httpServer = undefined;
    }
    if (this.stdioServer) {
      await new Promise<void>((resolve) => this.stdioServer?.close(() => resolve()));
      this.output.appendLine('ModelBridge: stdio bridge stopped.');
      this.stdioServer = undefined;
    }
    if (this.stdioListener && os.platform() !== 'win32') {
      try {
        fs.unlinkSync(this.stdioListener);
      } catch {
        // ignore
      }
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

  private async startHttp(cfg: ModelBridgeConfig) {
    const host = '127.0.0.1';
    this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res, cfg));
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.httpServer?.once('error', onError);
      this.httpServer?.listen(cfg.httpPort, host, () => {
        this.httpServer?.off('error', onError);
        this.output.appendLine(`ModelBridge: HTTP bridge listening on http://${host}:${cfg.httpPort}`);
        resolve();
      });
    });
  }

  private async startStdio(cfg: ModelBridgeConfig) {
    const listener = cfg.stdioPath || STDIO_DEFAULT_PATH;
    if (os.platform() !== 'win32') {
      try {
        if (fs.existsSync(listener)) {
          fs.unlinkSync(listener);
        }
      } catch (error) {
        this.output.appendLine(`ModelBridge: failed to clear socket ${listener}: ${String(error)}`);
      }
    }
    this.stdioServer = net.createServer((socket) => this.handleStdioConnection(socket, cfg));
    this.stdioListener = listener;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.stdioServer?.once('error', onError);
      this.stdioServer?.listen(listener, () => {
        this.stdioServer?.off('error', onError);
        this.output.appendLine(`ModelBridge: stdio bridge listening on ${listener}`);
        resolve();
      });
    });
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse, cfg: ModelBridgeConfig) {
    if (!cfg.enabled) {
      respondJson(res, 503, { error: 'bridge_disabled' });
      return;
    }
    if (!this.verifyHttpToken(req, cfg)) {
      respondUnauthorized(res);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      respondJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST') {
      respondNotFound(res);
      return;
    }
    const body = await parseRequestBody(req);
    let payload: any = {};
    if (body && body.trim().length) {
      try {
        payload = JSON.parse(body);
      } catch (error) {
        respondJson(res, 400, { error: 'invalid_json', message: String(error) });
        return;
      }
    }
    switch (url.pathname) {
      case '/call-tool':
        await this.executeToolRequest(payload, cfg, {
          respond: (status, body) => respondJson(res, status, body)
        });
        break;
      case '/orchestrate':
        await this.runOrchestrator(cfg, {
          respond: (status, body) => respondJson(res, status, body)
        });
        break;
      default:
        respondNotFound(res);
    }
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
        if (!this.verifyStdioToken(payload, cfg)) {
          responder.respond(401, { error: 'unauthorized' });
          continue;
        }
        const type = payload.type ?? (payload.toolName ? 'callTool' : 'health');
        void this.dispatchStdioCommand(type, payload, cfg, responder);
      }
    });
    socket.on('error', (error) => {
      this.output.appendLine(`ModelBridge: stdio client error ${String(error)}`);
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
      const cached = await getMcpClient(config, this.output);
      const client = (cached && cached.client) ? cached.client : undefined;
      if (!client) {
        responder.respond(503, { id: requestId, error: 'mcp_unavailable' });
        return;
      }
      // acquire concurrency slot
      await this.acquireSlot();
      this.activeCalls.set(requestId, { tool: toolName, startedAt: Date.now() });
      this.output.appendLine(`[req=${requestId}] start tool=${toolName}`);
      try {
        const timeoutMs = (cfg as any).requestTimeoutMs ?? 120000; // default 2min
        const controller = new AbortController();
        // attach controller so we can abort on demand / mark timed out
        const entry = this.activeCalls.get(requestId) || { tool: toolName, startedAt: Date.now() };
        entry.controller = controller;
        this.activeCalls.set(requestId, entry);

        const callRes = await callTool(client, toolName, payload.args ?? {}, { signal: controller.signal, timeout: timeoutMs });
        // callTool may return { result, sdkMessageId } (best-effort). Normalize.
        const possibleSdkId = (callRes && typeof callRes === 'object' && 'sdkMessageId' in callRes) ? callRes.sdkMessageId : undefined;
        const result = (callRes && typeof callRes === 'object' && 'result' in callRes) ? callRes.result : callRes;
        const entry2 = this.activeCalls.get(requestId);
        if (entry2 && possibleSdkId !== undefined) {
          entry2.sdkMessageId = possibleSdkId as any;
          this.activeCalls.set(requestId, entry2);
        }
        this.output.appendLine(`[req=${requestId}] done tool=${toolName} sdk=${possibleSdkId ?? 'unknown'}`);
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
            this.output.appendLine(`[req=${requestId}] timeout tool=${toolName} sdk=${callInfo.sdkMessageId ?? 'unknown'}`);
          }
          responder.respond(504, { id: requestId, error: 'tool_timeout', message: msg });
        } else {
          const code = 'tool_failed';
          this.output.appendLine(`[req=${requestId}] error tool=${toolName} sdk=${(this.activeCalls.get(requestId)?.sdkMessageId) ?? 'unknown'} message=${msg}`);
          responder.respond(500, { id: requestId, error: code, message: msg });
        }
      } finally {
        this.activeCalls.delete(requestId);
        this.output.appendLine(`[req=${requestId}] cleaned tool=${toolName}`);
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
      await runOrchestrator(config, this.output);
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

  private verifyHttpToken(req: IncomingMessage, cfg: ModelBridgeConfig) {
    if (!cfg.authToken || cfg.authToken.trim().length === 0) {
      return true;
    }
    const header = (req.headers['x-gemini-mcp-token'] ?? req.headers['authorization'] ?? '') as string;
    const normalized = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
    return normalized === cfg.authToken.trim();
  }

  private verifyStdioToken(payload: any, cfg: ModelBridgeConfig) {
    if (!cfg.authToken || cfg.authToken.trim().length === 0) {
      return true;
    }
    const provided = (payload.token ?? payload.authToken ?? payload.authorization ?? '') as string;
    const normalized = provided.startsWith('Bearer ') ? provided.slice(7).trim() : provided.trim();
    return normalized === cfg.authToken.trim();
  }
}
