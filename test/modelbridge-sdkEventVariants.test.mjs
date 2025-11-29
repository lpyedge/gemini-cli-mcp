import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRepo = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = requireFromRepo('typescript');

test('ModelBridge captures sdkMessageId when SDK emits messageSent (sdkHook mode)', async () => {
  const srcPath = path.join(__dirname, '..', 'src', 'extension', 'modelBridge.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

  const fakeOutputLines = [];
  const fakeOutput = { appendLine: (s) => fakeOutputLines.push(String(s)) };

  // fake client that supports on/off and will emit 'messageSent'
  const fakeClient = (() => {
    const listeners = new Map();
    const client = {
      __outgoingListeners: new Set(),
      __lastOutgoing: undefined,
      __captureMode: 'sdkHook',
      on: (ev, fn) => {
        const s = listeners.get(ev) || new Set();
        s.add(fn);
        listeners.set(ev, s);
      },
      off: (ev, fn) => {
        const s = listeners.get(ev);
        if (s) s.delete(fn);
      },
      callTool: async (req, undef, options) => {
        const parsed = { id: 123321, method: 'callTool', echoed: req };
        // notify SDK-level listeners
        for (const s of Array.from(listeners.values())) {
          for (const fn of Array.from(s)) {
            try { fn(parsed); } catch { }
          }
        }
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, echoed: req };
      }
    };
    return client;
  })();

  const fakeMcpClientModule = {
    getMcpClient: async (cfg, output) => {
      try {
        if (typeof fakeClient.on === 'function') {
          const internal = (payload) => {
            try { fakeClient.__lastOutgoing = payload; } catch { }
            try { for (const fn of Array.from(fakeClient.__outgoingListeners)) { try { fn(payload); } catch { } } } catch { }
          };
          // register on the 'messageSent' event
          fakeClient.on('messageSent', internal);
          fakeClient.__restoreSdkOutgoing = () => { try { fakeClient.off('messageSent', internal); } catch { } };
        }
      } catch { }
      fakeClient.__captureMode = cfg?.modelBridge?.captureSdkMessageId || 'sdkHook';
      return { client: fakeClient, transport: {} };
    },
    callTool: async (client, name, args, options) => {
      const res = await fakeClient.callTool({ name, arguments: args ?? {} }, undefined, options);
      const sdkMessageId = fakeClient.__lastOutgoing?.id ?? undefined;
      return { result: res, sdkMessageId };
    }
  };

  const captureMode = process.env.GEMINI_CAPTURE_MODE || 'sdkHook';
  const fakeConfigModule = {
    readConfig: () => ({ modelBridge: { enabled: true, stdioPath: undefined, allowedTools: [], allowOrchestrator: false, requestTimeoutMs: 60000, captureSdkMessageId: captureMode }, geminiPath: 'node', maxWorkers: 1, maxQueue: 10 })
  };

  function makeRequire() {
    const baseRequire = createRequire(srcPath);
    return function (id) {
      if (typeof id === 'string' && id.startsWith('node:')) {
        try { const core = baseRequire(id.slice(5)); return { default: core }; } catch (e) { }
      }
      if (id === './mcpClient' || id === '../extension/mcpClient') return fakeMcpClientModule;
      if (id === './configUtils' || id === '../extension/configUtils') return fakeConfigModule;
      if (id === './orchestrator' || id === '../extension/orchestrator') return { runOrchestrator: async () => ({ success: true }) };
      if (id === './types' || id === '../extension/types') return {};
      return baseRequire(id);
    };
  }

  const exports = {};
  const module = { exports };
  const func = new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled);
  func(module.exports, makeRequire(), module, srcPath, path.dirname(srcPath));

  const { ModelBridge } = module.exports;
  assert.ok(ModelBridge, 'ModelBridge exported');

  const bridge = new ModelBridge(fakeOutput);
  const payload = { toolName: 'tests.run', args: { some: 'arg' } };
  const responses = [];
  const responder = { respond: (status, body) => responses.push({ status, body }) };

  await bridge.executeToolRequest(payload, fakeConfigModule.readConfig().modelBridge, responder);

  const joined = fakeOutputLines.join('\n');
  assert.match(joined, /req=\w+/i, 'expected a bridge request id logged');
  assert.match(joined, /sdk=123321/i, 'expected sdk id captured from messageSent');
  assert.equal(responses.length > 0, true);
  assert.equal(responses[0].status, 200);
});

test('ModelBridge does not capture numeric sdkMessageId when capture mode is disabled', async () => {
  const srcPath = path.join(__dirname, '..', 'src', 'extension', 'modelBridge.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

  const fakeOutputLines = [];
  const fakeOutput = { appendLine: (s) => fakeOutputLines.push(String(s)) };

  const fakeClient = {
    __outgoingListeners: new Set(),
    __lastOutgoing: undefined,
    __captureMode: 'disabled',
    on: () => {},
    off: () => {},
    callTool: async (req) => {
      // emit an id, but since capture is disabled, bridge should not observe it
      const parsed = { id: 999999, method: 'callTool' };
      try { for (const fn of Array.from(fakeClient.__outgoingListeners)) { try { fn(parsed); } catch { } } } catch { }
      return { ok: true, echoed: req };
    }
  };

  const fakeMcpClientModule = {
    getMcpClient: async (cfg, output) => {
      // do NOT register any SDK-level forwarding; mimic disabled capture
      fakeClient.__captureMode = 'disabled';
      return { client: fakeClient, transport: {} };
    },
    callTool: async (client, name, args, options) => {
      const res = await fakeClient.callTool({ name, arguments: args ?? {} }, undefined, options);
      const sdkMessageId = fakeClient.__lastOutgoing?.id ?? undefined;
      return { result: res, sdkMessageId };
    }
  };

  const fakeConfigModule = {
    readConfig: () => ({ modelBridge: { enabled: true, stdioPath: undefined, allowedTools: [], allowOrchestrator: false, requestTimeoutMs: 60000, captureSdkMessageId: 'disabled' }, geminiPath: 'node', maxWorkers: 1, maxQueue: 10 })
  };

  function makeRequire() {
    const baseRequire = createRequire(srcPath);
    return function (id) {
      if (typeof id === 'string' && id.startsWith('node:')) {
        try { const core = baseRequire(id.slice(5)); return { default: core }; } catch (e) { }
      }
      if (id === './mcpClient' || id === '../extension/mcpClient') return fakeMcpClientModule;
      if (id === './configUtils' || id === '../extension/configUtils') return fakeConfigModule;
      if (id === './orchestrator' || id === '../extension/orchestrator') return { runOrchestrator: async () => ({ success: true }) };
      if (id === './types' || id === '../extension/types') return {};
      return baseRequire(id);
    };
  }

  const exports = {};
  const module = { exports };
  const func = new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled);
  func(module.exports, makeRequire(), module, srcPath, path.dirname(srcPath));

  const { ModelBridge } = module.exports;
  assert.ok(ModelBridge, 'ModelBridge exported');

  const bridge = new ModelBridge(fakeOutput);
  const payload = { toolName: 'tests.run', args: { some: 'arg' } };
  const responses = [];
  const responder = { respond: (status, body) => responses.push({ status, body }) };

  await bridge.executeToolRequest(payload, fakeConfigModule.readConfig().modelBridge, responder);

  const joined = fakeOutputLines.join('\n');
  assert.match(joined, /req=\w+/i, 'expected a bridge request id logged');
  // Ensure no numeric sdk id captured when disabled
  assert.doesNotMatch(joined, /sdk=\d+/i, 'expected no numeric sdk id when capture disabled');
  assert.equal(responses.length > 0, true);
  assert.equal(responses[0].status, 200);
});
