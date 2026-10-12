import {it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {executableInventory} from '../src/rnd/method.js';
import {sha256Hex} from '../src/hash.js';
import type {RndDeps} from '../src/rnd/types.js';

it('hashes real TypeScript method bytes in source mode on Windows and POSIX',async()=>{
 const inventory=await executableInventory({} as RndDeps,'verifiedcapture');
 expect(inventory.files['backend/method']).toBe(sha256Hex(await readFile(new URL('../src/rnd/method.ts',import.meta.url))));
 expect(inventory.files.contracts).toBe(sha256Hex(await readFile(new URL('../../packages/evidence-contracts/contracts.mjs',import.meta.url))));
 expect((await executableInventory({} as RndDeps,'verifiedcapture')).digest).toBe(inventory.digest);
});
