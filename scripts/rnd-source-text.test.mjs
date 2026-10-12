import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sourceName,sourceText } from './rnd-source-text.mjs';

test('generated schema identity is stable across Windows and Linux checkouts, but detects actual edits', () => {
  const hash = (name,text) => createHash('sha256').update(sourceName(name)).update('\0').update(sourceText(text)).digest('hex');
  const linux = hash('backend/rnd-openapi.json', '{\n  "version": 1\n}\n');
  assert.equal(hash('backend\\rnd-openapi.json', '{\r\n  "version": 1\r\n}\r\n'),linux);
  assert.notEqual(hash('backend/rnd-openapi.json', '{\n  "version": 2\n}\n'),linux);
  assert.notEqual(hash('backend/other.json', '{\n  "version": 1\n}\n'),linux);
});
