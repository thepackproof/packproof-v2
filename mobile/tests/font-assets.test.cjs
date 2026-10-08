const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const faces = [
  { file: 'Inter-Regular.ttf', style: 'Regular', weight: 400 },
  { file: 'Inter-SemiBold.ttf', style: 'SemiBold', weight: 600 },
  { file: 'Inter-Bold.ttf', style: 'Bold', weight: 700 },
];
function checksum(data) {
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
  data.copy(padded);
  let result = 0;
  for (let offset = 0; offset < padded.length; offset += 4) result = (result + padded.readUInt32BE(offset)) >>> 0;
  return result;
}
function readFont(file) {
  const data = fs.readFileSync(path.join(__dirname, '../assets/fonts', file));
  assert.equal(data.readUInt32BE(0), 0x00010000, `${file}: TrueType SFNT signature`);
  const tables = new Map();
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    const tag = data.toString('ascii', record, record + 4);
    const offset = data.readUInt32BE(record + 8), length = data.readUInt32BE(record + 12);
    assert.ok(offset % 4 === 0 && offset + length <= data.length, `${file}: ${tag} bounds/alignment`);
    const bytes = Buffer.from(data.subarray(offset, offset + length));
    const checkBytes = Buffer.from(bytes);
    if (tag === 'head') checkBytes.writeUInt32BE(0, 8);
    assert.equal(checksum(checkBytes), data.readUInt32BE(record + 4), `${file}: ${tag} checksum`);
    tables.set(tag, bytes);
  }
  assert.equal(checksum(data), 0xB1B0AFBA, `${file}: whole-font checksum`);
  const names = new Map(), table = tables.get('name');
  assert.ok(table, `${file}: name table exists`);
  const strings = table.readUInt16BE(4);
  for (let i = 0; i < table.readUInt16BE(2); i++) {
    const record = 6 + i * 12, platform = table.readUInt16BE(record);
    const id = table.readUInt16BE(record + 6), length = table.readUInt16BE(record + 8), offset = table.readUInt16BE(record + 10);
    assert.ok(strings + offset + length <= table.length, `${file}: name ${id} bounds`);
    if (platform !== 0 && platform !== 3) continue;
    const value = Buffer.from(table.subarray(strings + offset, strings + offset + length)).swap16().toString('utf16le');
    const values = names.get(id) || new Set();
    values.add(value); names.set(id, values);
  }
  const name = id => {
    assert.equal(names.get(id)?.size, 1, `${file}: name ${id} has one unambiguous value`);
    return [...names.get(id)][0];
  };
  return { tables, name };
}

test('runtime font aliases resolve to distinct correctly weighted static faces', () => {
  const postScriptNames = new Set(), outlines = new Set();
  for (const face of faces) {
    const { tables, name } = readFont(face.file);
    assert.equal(name(6), `PackProofSans-${face.style}`);
    assert.match(name(6), /^[A-Za-z0-9-]{1,63}$/, 'Portable PostScript font name');
    assert.equal(name(4), `PackProof Sans ${face.style}`);
    assert.equal(name(16), 'PackProof Sans');
    assert.equal(name(17), face.style);
    assert.equal(name(1), face.style === 'SemiBold' ? 'PackProof Sans SemiBold' : 'PackProof Sans');
    assert.equal(name(2), face.style === 'Bold' ? 'Bold' : 'Regular');
    assert.equal(tables.get('OS/2').readUInt16BE(4), face.weight);
    assert.equal(Boolean(tables.get('OS/2').readUInt16BE(62) & 0x20), face.style === 'Bold', 'OS/2 bold style flag');
    assert.equal(Boolean(tables.get('head').readUInt16BE(44) & 1), face.style === 'Bold', 'head bold style flag');
    assert.equal(tables.has('fvar'), false, 'These are static face assets');
    assert.ok(tables.get('maxp').readUInt16BE(4) > 0, 'Glyphs are present');
    postScriptNames.add(name(6));
    outlines.add(createHash('sha256').update(tables.get('glyf')).digest('hex'));
  }
  assert.equal(postScriptNames.size, faces.length, 'iOS must not register different faces under the same font name');
  assert.equal(outlines.size, faces.length, 'Weights must have distinct outlines, not merely distinct metadata');
});

test('renamed fonts retain original attribution and the SIL Open Font License', () => {
  for (const face of faces) {
    const { name } = readFont(face.file);
    assert.match(name(0), /The Inter Project Authors/);
    assert.match(name(13), /SIL Open Font License, Version 1\.1/);
    assert.equal(name(14), 'https://openfontlicense.org');
  }
  const license = fs.readFileSync(path.join(__dirname, '../assets/fonts/OFL-Inter.txt'), 'utf8');
  assert.match(license, /The Inter Project Authors/);
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
});
