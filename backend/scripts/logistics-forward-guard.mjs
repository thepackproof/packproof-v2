// Generate the five-row reader shim from the exact release SQL and the actual prior image.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const previousInventorySha256 = 'd0161362a548b61f4cc69195ad8920fbddec36f2b9d183e5b1cd066b6f0eeb60';
export const inventorySha256 = '8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function readInventory(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => ({
    id: name.slice(0, -4), checksum: digest(readFileSync(join(directory, name))),
  }));
}

export function buildGuard(previous, candidate) {
  if (previous.length !== 123 || candidate.length !== 128 ||
      digest(JSON.stringify(previous)) !== previousInventorySha256 ||
      digest(JSON.stringify(candidate)) !== inventorySha256 ||
      JSON.stringify(candidate.slice(0, 123)) !== JSON.stringify(previous))
    throw Error('Expected exact reviewed 124 and 129 migration bytes.');
  return [
    "import {FORWARD_COMPATIBLE_MIGRATIONS as previous, isReviewedForwardCompatibleMigration as accepted} from './forward-compatible-migrations.logistics124.js';",
    'const added = Object.freeze(' + JSON.stringify(candidate.slice(123)) + '.map(Object.freeze));',
    'export const FORWARD_COMPATIBLE_MIGRATIONS = Object.freeze([...previous, ...added]);',
    'export function isReviewedForwardCompatibleMigration(row) {',
    '  return accepted(row) || added.some(entry => entry.id === row?.id && entry.checksum === row.checksum);',
    '}','',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [before, after, destination] = process.argv.slice(2);
  if (process.argv.length !== 5) throw Error('Supply previous and candidate migration directories and a new output path.');
  writeFileSync(destination, buildGuard(readInventory(before), readInventory(after)), { flag: 'wx' });
}
