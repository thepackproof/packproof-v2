// Generate the one-row reader shim from the exact release SQL and the actual prior image.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const previousInventorySha256 = '8ab67cf9cc721d6da4c28cef72fdcdaf2b08faaa86196d76acff0a4f95f97fcc';
export const inventorySha256 = '13f05713808a4c077b9388d5609d99ad1bfa16b9ded82b2e447bc1c076d5896e';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function readInventory(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.sql')).sort().map(name => ({
    id: name.slice(0, -4), checksum: digest(readFileSync(join(directory, name))),
  }));
}

export function buildGuard(previous, candidate) {
  if (previous.length !== 128 || candidate.length !== 129 ||
      digest(JSON.stringify(previous)) !== previousInventorySha256 ||
      digest(JSON.stringify(candidate)) !== inventorySha256 ||
      JSON.stringify(candidate.slice(0, 128)) !== JSON.stringify(previous))
    throw Error('Expected exact reviewed 129 and 130 migration bytes.');
  return [
    "import {FORWARD_COMPATIBLE_MIGRATIONS as previous, isReviewedForwardCompatibleMigration as accepted} from './forward-compatible-migrations.recovery129.js';",
    'const added = Object.freeze(' + JSON.stringify(candidate.slice(128)) + '.map(Object.freeze));',
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
