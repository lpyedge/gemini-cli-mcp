import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { dereferenceSchema, jsonSchemaToZod } from '../../server/src/lib/schemaUtils.ts';

test('dereference internal $defs and convert to zod', async () => {
  const manifest = {
    tools: [
      {
        name: 't1',
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
      }
    ]
  };
  const resolved = await dereferenceSchema(manifest.tools[0].arguments, manifest, __dirname, {});
  const z = jsonSchemaToZod(resolved);
  // valid
  const ok = { payload: { name: 'alice' } };
  z.parse(ok);
  // invalid: missing name
  let threw = false;
  try {
    z.parse({ payload: {} });
  } catch (err) {
    threw = true;
  }
  assert.ok(threw, 'expected parse to throw for missing required field');
});

test('dereference external relative $ref and convert to zod', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-utils-test-'));
  try {
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

    const manifest = {
      tools: [
        {
          name: 't2',
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

    const resolved = await dereferenceSchema(manifest.tools[0].arguments, manifest, tmp, {});
    const z = jsonSchemaToZod(resolved);
    z.parse({ payload: { x: 'ok' } });
    let threw = false;
    try {
      z.parse({ payload: {} });
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, 'expected parse to throw for missing required external field');
  } finally {
    try {
      await fs.rm(tmp, { recursive: true, force: true });
    } catch {}
  }
});
