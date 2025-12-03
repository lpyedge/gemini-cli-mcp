import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This test reads the repository mcp.json, writes it into a temporary workspace,
// loads the manifest via loadMcpManifest, and invokes each registered tool handler.
// It attempts to run the real `gemini` binary if available in PATH; if not, the
// tests are skipped.

test('manifest tools invoke Gemini CLI (integration, skips if gemini missing)', async (t) => {
  // quick check: is `gemini` available?
  const gemCheck = spawnSync('gemini', ['--version'], { stdio: 'pipe' });
  if (gemCheck.error || gemCheck.status !== 0) {
    t.skip('`gemini` binary not found in PATH; skipping manifest CLI integration tests');
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-cli-'));
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    // Read repository mcp.json and write a copy into the tmp workspace
    const repoMcpPath = path.resolve(path.join(__dirname, '..', '..', '..', 'mcp.json'));
    const repoMcpRaw = await fs.readFile(repoMcpPath, 'utf8');
    await fs.writeFile(path.join(tmp, 'mcp.json'), repoMcpRaw, 'utf8');

    // write a sample source file used by some tools
    const sampleCode = `function add(a, b) {\n  return a + b;\n}\n`;
    await fs.writeFile(path.join(tmp, 'sample.js'), sampleCode, 'utf8');

    // import the manifest manager (TypeScript source via ts-node/esm loader used by test runner)
    const manifestManagerPath = path.resolve(path.join(__dirname, '..', '..', '..', 'server', 'src', 'gemini', 'manifestManager.ts'));
    const { loadMcpManifest } = await import(manifestManagerPath + '');

    // fake server to capture registered tools
    const registered = {};
    const server = {
      registerTool(name, meta, handler) {
        registered[name] = { meta, handler };
      },
      hasTool(name) { return false; }
    };

    // real runGeminiCliCommand that spawns the 'gemini' binary
    function runGeminiCliCommand(args, opts = {}) {
      return new Promise((resolve, reject) => {
        const proc = spawn('gemini', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (b) => (stdout += String(b)));
        proc.stderr.on('data', (b) => (stderr += String(b)));
        proc.on('error', (e) => reject(e));
        proc.on('close', (code) => resolve({ stdout, stderr }));
        if (opts.stdin) proc.stdin.end(opts.stdin);
        else proc.stdin.end();
        if (opts.timeoutMs) setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs);
      });
    }

    // load manifest into our fake server
    await loadMcpManifest({ workspaceRoot: tmp, server, runGeminiCliCommand, manifestToolTimeoutMs: 60_000 });

    // Ensure some tools were registered
    const toolNames = Object.keys(registered);
    assert.ok(toolNames.length > 0, 'Expected at least one tool to be registered from the manifest');

    // helper: simple invocation wrapper that logs and returns parsed result if possible
    async function invokeHandler(toolName, input) {
      const h = registered[toolName]?.handler;
      if (!h) throw new Error(`Handler not found for ${toolName}`);
      const res = await h(input, {});
      return res;
    }

    // For each registered tool, run a subtest with representative inputs
    for (const toolName of toolNames) {
      await t.test(`invoke ${toolName}`, async (t2) => {
        t2.log(`Invoking ${toolName}...`);
        let inputExample = {};
        if (toolName === 'dev.summarizeCode') {
          // try both path and text variants
          t2.log(' - variant: path');
          const pathRes = await invokeHandler(toolName, { inputType: 'path', path: 'sample.js' });
          t2.log('  ->', JSON.stringify(pathRes).slice(0, 500));

          t2.log(' - variant: text');
          const textRes = await invokeHandler(toolName, { inputType: 'text', content: sampleCode });
          t2.log('  ->', JSON.stringify(textRes).slice(0, 500));

          // basic assertions: got back an object or text wrapper
          assert.ok(pathRes && (typeof pathRes === 'object' || pathRes.result), 'Expected path result object or text wrapper');
          assert.ok(textRes && (typeof textRes === 'object' || textRes.result), 'Expected text result object or text wrapper');
          return;
        }

        if (toolName.startsWith('dev.')) {
          // common dev tools expect `content` or similar
          inputExample = { content: sampleCode };
        } else if (toolName.startsWith('web.')) {
          // web tools need a query/packageName
          if (toolName === 'web.findLibraryUsage') inputExample = { packageName: 'express' };
          else inputExample = { query: 'read file in node' };
        } else {
          inputExample = { content: sampleCode };
        }

        const result = await invokeHandler(toolName, inputExample);
        t2.log(' ->', JSON.stringify(result).slice(0, 500));
        assert.ok(result && (typeof result === 'object' || result.result), 'Expected a parsed object or a text wrapper result');
      });
    }
  } finally {
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
  }
});
