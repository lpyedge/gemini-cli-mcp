import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';

test('mcp manifest with internal $defs and external relative $ref is loaded and advertised', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-manifest-test-'));
  try {
    // create schemas dir and external schema
    const schemasDir = path.join(tmp, 'schemas');
    await fs.mkdir(schemasDir, { recursive: true });
    const externalSchema = {
      "$id": "external.json",
      "definitions": {
        "externalDef": {
          "type": "object",
          "properties": { "x": { "type": "string" } },
          "required": ["x"]
        }
      }
    };
    await fs.writeFile(path.join(schemasDir, 'external.json'), JSON.stringify(externalSchema, null, 2), 'utf8');

    // create mcp.json with internal $defs and external relative $ref
    const manifest = {
      tools: [
        {
          name: 'test.internalRef',
          title: 'Internal Ref Tool',
          arguments: {
            $defs: {
              Common: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
              }
            },
            type: 'object',
            properties: {
              payload: { $ref: '#/$defs/Common' }
            },
            required: ['payload']
          }
        },
        {
          name: 'test.externalRef',
          title: 'External Ref Tool',
          arguments: {
            type: 'object',
            properties: {
              payload: { $ref: './schemas/external.json#/definitions/externalDef' }
            },
            required: ['payload']
          }
        }
      ]
    };
    await fs.writeFile(path.join(tmp, 'mcp.json'), JSON.stringify(manifest, null, 2), 'utf8');

    // spawn the compiled server (server/dist/index.js)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const serverDist = path.resolve(path.join(__dirname, '..', '..', 'server', 'dist', 'index.js'));
    assert.ok(fsSync.existsSync(serverDist), `Expected compiled server at ${serverDist}`);

    const env = { ...process.env, GEMINI_TASK_CWD: tmp };

    const child = spawn(process.execPath, [serverDist], { env, stdio: ['ignore', 'pipe', 'pipe'] });

    let out = '';
    let errOut = '';
    const gotInternal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout waiting for manifest advertisement')), 15000);
      child.stdout.on('data', (b) => {
        out += b.toString();
        // server diagnostic logs are on stderr and may change over time; be resilient
        // and consider either stdout or stderr containing the tool names
        if ((out.includes('test.internalRef') && out.includes('test.externalRef')) || (errOut.includes('test.internalRef') && errOut.includes('test.externalRef'))) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.stderr.on('data', (b) => {
        errOut += b.toString();
        if ((out.includes('test.internalRef') && out.includes('test.externalRef')) || (errOut.includes('test.internalRef') && errOut.includes('test.externalRef'))) {
          clearTimeout(timer);
          resolve(true);
        }
      });
      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Server exited early with ${code} stderr:${errOut}`));
        }
      });
    });

    await gotInternal;
    // success: both advertised
    child.kill();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    // best-effort cleanup
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {}
  }
});
