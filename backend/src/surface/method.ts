import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from '../hash.js';
import { canonicalize } from '../canonical.js';
import { SURFACE_METHOD, type SurfaceConfig } from './config.js';
/** Pin exact shipped bytes before enqueue. A changed executable requires a new request. */
export async function surfaceMethodPin(config: SurfaceConfig) {
  const root = path.resolve(config.workerRoot),
    pythonDir = path.join(root, 'packproof_surface');
  const inventory: Record<string, string> = {};
  for (const name of (await readdir(pythonDir)).filter(n => n.endsWith('.py')).sort()) inventory[`packproof_surface/${name}`] = sha256Hex(await readFile(path.join(pythonDir, name)));
  for (const name of ['profiles/research-paper-v1.json', 'requirements.lock']) inventory[name] = sha256Hex(await readFile(path.join(root, name)));
  return {
    ...SURFACE_METHOD,
    artifactInventorySha256: sha256Hex(canonicalize(inventory)),
    artifactInventory: inventory
  };
}
