import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { jsonSchemaToZod } from '../dist/lib/schemaUtils.js';

// Tests for jsonSchemaToZod features (enums, oneOf/anyOf, tuples, patterns, numbers, additionalProperties, uniqueItems, formats)

test('enum -> z.enum', () => {
  const schema = { enum: ['a', 'b', 'c'] };
  const z = jsonSchemaToZod(schema);
  z.parse('a');
  let threw = false;
  try { z.parse('x'); } catch { threw = true; }
  assert.ok(threw, 'enum should reject unknown value');
});

test('oneOf (string|number) -> union', () => {
  const schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
  const z = jsonSchemaToZod(schema);
  z.parse('ok');
  z.parse(5);
  let threw = false;
  try { z.parse(true); } catch { threw = true; }
  assert.ok(threw, 'oneOf should reject boolean');
});

test('tuple array -> z.tuple', () => {
  const schema = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };
  const z = jsonSchemaToZod(schema);
  z.parse(['s', 1]);
  let threw = false;
  try { z.parse(['s']); } catch { threw = true; }
  assert.ok(threw, 'tuple should require both items');
});

test('string pattern constraint', () => {
  const schema = { type: 'string', pattern: '^a+$' };
  const z = jsonSchemaToZod(schema);
  z.parse('aaaa');
  let threw = false;
  try { z.parse('b'); } catch { threw = true; }
  assert.ok(threw, 'pattern should reject non-matching');
});

test('number constraints: min/max/multipleOf', () => {
  const schema = { type: 'number', minimum: 2, maximum: 5, multipleOf: 0.5 };
  const z = jsonSchemaToZod(schema);
  z.parse(3);
  z.parse(2.5);
  let threw = false;
  try { z.parse(1); } catch { threw = true; }
  assert.ok(threw, 'minimum should reject 1');
  threw = false;
  try { z.parse(2.25); } catch { threw = true; }
  assert.ok(threw, 'multipleOf should reject non-multiple');
});

test('additionalProperties=false enforces strict object', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  const z = jsonSchemaToZod(schema);
  z.parse({ a: 'x' });
  let threw = false;
  try { z.parse({ a: 'x', b: 1 }); } catch { threw = true; }
  assert.ok(threw, 'strict object should reject extra properties');
});

test('uniqueItems true enforces uniqueness', () => {
  const schema = { type: 'array', items: { type: 'string' }, uniqueItems: true };
  const z = jsonSchemaToZod(schema);
  z.parse(['a', 'b']);
  let threw = false;
  try { z.parse(['a', 'a']); } catch { threw = true; }
  assert.ok(threw, 'uniqueItems should reject duplicates');
});

test('format: url/email', () => {
  const s1 = { type: 'string', format: 'url' };
  const s2 = { type: 'string', format: 'email' };
  const z1 = jsonSchemaToZod(s1);
  const z2 = jsonSchemaToZod(s2);
  z1.parse('http://example.com');
  z2.parse('x@example.com');
  let threw = false;
  try { z1.parse('not-a-url'); } catch { threw = true; }
  assert.ok(threw, 'url format should reject invalid url');
});
