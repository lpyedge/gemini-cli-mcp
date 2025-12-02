import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireFromRepo = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ts = requireFromRepo('typescript');

test('ModelBridge should log bridge req id and sdk message id when call-tool invoked', async () => {
  // Load the TypeScript source and transpile to CommonJS for test evaluation
  const srcPath = path.join(__dirname, '..', 'src', 'extension', 'modelBridge.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const transpiled = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

  // Prepare stubs for ./mcpClient and ./configUtils
  const fakeOutputLines = [];
  const fakeOutput = { appendLine: (s) => fakeOutputLines.push(String(s)) };

  // Fake client that will notify outgoing listeners with a synthetic SDK id
  const fakeClient = {
    __outgoingListeners: new Set(),
    callTool: async (req, undef, options) => {
      // simulate transport sending an outgoing JSON containing id
      const parsed = { id: 424242, method: 'callTool' };
      // notify listeners (as our hooks would have wrapped)
      for (const fn of Array.from(fakeClient.__outgoingListeners)) {
        try { fn(parsed); } catch {}
      }
      // simulate a small delay then return a result
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, echoed: req };
    }
  };

  const fakeMcpClientModule = {
    getMcpClient: async (cfg, output) => ({ client: fakeClient, transport: {} }),
    callTool: async (client, name, args, options) => {
      // delegate to fakeClient.callTool and surface sdkMessageId if present
      const res = await fakeClient.callTool({ name, arguments: args ?? {} }, undefined, options);
      const sdkMessageId = fakeClient.__lastOutgoing?.id ?? undefined;
      return { result: res, sdkMessageId };
    }
  };

  const captureMode = process.env.GEMINI_CAPTURE_MODE || 'bestEffort';
  const fakeConfigModule = {
    readConfig: () => ({ modelBridge: { enabled: true, stdioPath: undefined, allowedTools: [], allowOrchestrator: false, requestTimeoutMs: 60000, captureSdkMessageId: captureMode }, geminiPath: 'node', maxWorkers: 1, maxQueue: 10 })
  };

  // custom require that resolves local stubs for relative imports used by transpiled code
  function makeRequire() {
    const baseRequire = createRequire(srcPath);
    return function (id) {
      if (id === 'vscode') return { workspace: { workspaceFolders: [] }, Disposable: class {}, window: {} };
      if (typeof id === 'string' && id.startsWith('node:')) {
        // TypeScript transpiled imports like `import os from 'node:os'` expect a
        // `{ default: <module> }` shape. Provide that.
        try {
          const core = baseRequire(id.slice(5));
          return { default: core };
        } catch (e) {
          // fallback
        }
      }
      if (id === './mcpClient' || id === '../extension/mcpClient') return fakeMcpClientModule;
      if (id === './configUtils' || id === '../extension/configUtils') return fakeConfigModule;
      if (id === './logger' || id === '../extension/logger') return { logger: { info: (m, o) => fakeOutput.appendLine(String(m) + (o ? ' ' + JSON.stringify(o) : '')), warn: (m, o) => fakeOutput.appendLine(String(m) + (o ? ' ' + JSON.stringify(o) : '')) } };
      if (id === './orchestrator' || id === '../extension/orchestrator') return { runOrchestrator: async () => ({ success: true }) };
      if (id === './types' || id === '../extension/types') return {};
      return baseRequire(id);
    };
  }

  // Evaluate the transpiled module in a CommonJS-like wrapper
  const exports = {};
  const module = { exports };
  const func = new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled);
  func(module.exports, makeRequire(), module, srcPath, path.dirname(srcPath));

  const { ModelBridge } = module.exports;
  assert.ok(ModelBridge, 'ModelBridge exported');

  // Instantiate bridge and invoke executeToolRequest (private) via bracket access
  const bridge = new ModelBridge(fakeOutput);

  // Prepare payload and responder
  const payload = { toolName: 'tests.run', args: { some: 'arg' } };
  const responses = [];
  const responder = { respond: (status, body) => responses.push({ status, body }) };

  // Call the private method
  await bridge.executeToolRequest(payload, fakeConfigModule.readConfig().modelBridge, responder);

  // Verify output logs include req= and sdk= markers
  const joined = fakeOutputLines.join('\n');
  assert.match(joined, /req=\w+/i, 'expected a bridge request id logged');
  assert.match(joined, /sdk=(?:\d+|unknown)/i, 'expected sdk id or unknown logged');

  // And ensure responder received success
  assert.equal(responses.length > 0, true);
  assert.equal(responses[0].status, 200);
});
