import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRepo = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = requireFromRepo('typescript');

test('ModelBridge captures sdkMessageId when SDK exposes outgoing event (sdkHook mode)', async () => {
  const srcPath = path.join(__dirname, '..', 'src', 'extension', 'modelBridge.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

  const fakeOutputLines = [];
  const fakeOutput = { appendLine: (s) => fakeOutputLines.push(String(s)) };

  // Create a fake client that supports SDK-style events via `on`/`off` and
  // that will notify SDK listeners when callTool is invoked.
  const fakeClient = (() => {
    const sdkListeners = new Map();
    const client = {
      __outgoingListeners: new Set(),
      __lastOutgoing: undefined,
      __captureMode: 'sdkHook',
      on: (ev, fn) => {
        const s = sdkListeners.get(ev) || new Set();
        s.add(fn);
        sdkListeners.set(ev, s);
      },
      off: (ev, fn) => {
        const s = sdkListeners.get(ev);
        if (s) s.delete(fn);
      },
      // simulate SDK's callTool which emits an SDK-level outgoing event
      callTool: async (req, undef, options) => {
        const parsed = { id: 777777, method: 'callTool', echoed: req };
        // notify SDK-level listeners
        for (const s of Array.from(sdkListeners.values())) {
          for (const fn of Array.from(s)) {
            try { fn(parsed); } catch { }
          }
        }
        // small delay to mimic async transport
        await new Promise((r) => setTimeout(r, 5));
        return { ok: true, echoed: req };
      }
    };
    return client;
  })();

  // Fake mcpClient module that emulates what real getMcpClient would do when
  // an SDK provides an `on` event: it registers an internal SDK listener that
  // forwards to __outgoingListeners and sets __lastOutgoing.
  const fakeMcpClientModule = {
    getMcpClient: async (cfg, output) => {
      // simulate mcpClient installing an SDK hook when SDK supports `on`
      try {
        if (typeof fakeClient.on === 'function') {
          const internal = (payload) => {
            try {
              fakeClient.__lastOutgoing = payload;
            } catch { }
            try {
              for (const fn of Array.from(fakeClient.__outgoingListeners)) {
                try { fn(payload); } catch { }
              }
            } catch { }
          };
          // register on a common candidate event name
          fakeClient.on('outgoing', internal);
          // expose a restore so tests could undo if needed
          fakeClient.__restoreSdkOutgoing = () => { try { fakeClient.off('outgoing', internal); } catch { } };
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
        try {
          const core = baseRequire(id.slice(5));
          return { default: core };
        } catch (e) { }
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
  // sdkHook should capture a numeric id we emitted (777777)
  assert.match(joined, /sdk=777777/i, 'expected sdk id captured by sdkHook');
  assert.equal(responses.length > 0, true);
  assert.equal(responses[0].status, 200);
});
