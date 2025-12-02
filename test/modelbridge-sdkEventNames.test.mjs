import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRepo = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = requireFromRepo('typescript');

const EVENT_NAMES = ['message:sent', 'messageSent', 'outgoingMessage'];

for (const [idx, evName] of EVENT_NAMES.entries()) {
  test(`ModelBridge captures sdkMessageId for SDK event name '${evName}'`, async () => {
    const srcPath = path.join(__dirname, '..', 'src', 'extension', 'modelBridge.ts');
    const src = fs.readFileSync(srcPath, 'utf8');
    const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

    const fakeOutputLines = [];
    const fakeOutput = { appendLine: (s) => fakeOutputLines.push(String(s)) };

    const uniqueId = 400000 + idx;

    // Fake client that registers SDK listeners on different event names.
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
          const parsed = { id: uniqueId, method: 'callTool', echoed: req };
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
            fakeClient.on(evName, internal);
            fakeClient.__restoreSdkOutgoing = () => { try { fakeClient.off(evName, internal); } catch { } };
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
        if (id === 'vscode') {
          return { workspace: { workspaceFolders: [] }, Disposable: class {}, window: {} };
        }
        if (typeof id === 'string' && id.startsWith('node:')) {
          try { const core = baseRequire(id.slice(5)); return { default: core }; } catch (e) { }
        }
        if (id === './mcpClient' || id === '../extension/mcpClient') return fakeMcpClientModule;
        if (id === './configUtils' || id === '../extension/configUtils') return fakeConfigModule;
        if (id === './logger' || id === '../extension/logger') return { logger: { info: (m, o) => fakeOutput.appendLine(String(m) + (o ? ' ' + JSON.stringify(o) : '')), warn: (m, o) => fakeOutput.appendLine(String(m) + (o ? ' ' + JSON.stringify(o) : '')) } };
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
    assert.match(joined, new RegExp(`sdk=${uniqueId}`), `expected sdk id ${uniqueId} captured for event ${evName}`);
    assert.equal(responses.length > 0, true);
    assert.equal(responses[0].status, 200);
  });
}
