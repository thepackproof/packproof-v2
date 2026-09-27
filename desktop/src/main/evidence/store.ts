import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { mkdir, open, rename, unlink, readdir, lstat, chmod, statfs } from 'node:fs/promises';
import path from 'node:path';

export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_BYTES = 250_000_000;
export const MAX_DURATION_SECONDS = 300;
const MAGIC = Buffer.from('PPQ1');
const SAFE_ID = /^[a-f0-9-]{36}$/;

/** AES-GCM authenticates both the exact bytes and their job/sequence identity. */
export function encrypt(bytes: Buffer, key: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}
export function decrypt(bytes: Buffer, key: Buffer, aad: string): Buffer {
  if (bytes.length < 32 || !bytes.subarray(0, 4).equals(MAGIC)) throw new Error('LOCAL_INTEGRITY');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(bytes.subarray(16, 32));
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]);
  } catch { throw new Error('LOCAL_INTEGRITY'); }
}
async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) {
    // Windows does not expose directory fsync. File fsync + atomic rename is used.
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'EISDIR', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally { await handle?.close(); }
}
async function safeDirectory(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_STORAGE');
  await chmod(directory, 0o700);
  if (created) await syncDirectory(path.dirname(directory));
}
async function boundedRead(file: string, maximum: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw new Error('LOCAL_INTEGRITY');
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size !== info.size || stat.ino !== info.ino) throw new Error('LOCAL_INTEGRITY');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size) throw new Error('LOCAL_INTEGRITY');
    return bytes;
  } finally { await handle.close(); }
}

/** Encrypted per-account, per-job atomic journal. Filenames contain no account/order data. */
export class EvidenceStore {
  readonly rootDir: string;
  private readonly installationKey: Buffer;
  constructor(rootDir: string, encryptionKey: Buffer) {
    if (encryptionKey.length !== 32) throw new Error('A protected 256-bit installation key is required');
    this.rootDir = path.resolve(rootDir);
    this.installationKey = Buffer.from(encryptionKey);
  }
  async initialize(): Promise<void> { await safeDirectory(this.rootDir); }
  accountTag(accountId: string): string {
    return createHmac('sha256', this.installationKey).update('account-path\0').update(accountId).digest('hex');
  }
  private key(accountId: string): Buffer {
    return createHmac('sha256', this.installationKey).update('account-key\0').update(accountId).digest();
  }
  private accountDirectory(accountId: string): string { return path.join(this.rootDir, this.accountTag(accountId)); }
  private jobDirectory(accountId: string, id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('INVALID_JOB_ID');
    return path.join(this.accountDirectory(accountId), id);
  }
  private async prepare(accountId: string, id: string): Promise<string> {
    await safeDirectory(this.accountDirectory(accountId));
    const directory = this.jobDirectory(accountId, id);
    await safeDirectory(directory);
    return directory;
  }
  private async writeAtomic(directory: string, name: string, bytes: Buffer): Promise<void> {
    const temporary = path.join(directory, `${name}.${randomBytes(8).toString('hex')}.tmp`);
    const destination = path.join(directory, name);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    catch (error) { await handle.close(); await unlink(temporary).catch(() => undefined); throw error; }
    await handle.close();
    await rename(temporary, destination);
    await syncDirectory(directory);
  }
  async writeJournal(accountId: string, id: string, record: unknown): Promise<void> {
    const directory = await this.prepare(accountId, id);
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > 2 * 1024 * 1024) throw new Error('QUEUE_METADATA_LIMIT');
    await this.writeAtomic(directory, 'journal.enc', encrypt(bytes, this.key(accountId), `journal:${id}`));
  }
  async readJournal<T>(accountId: string, id: string): Promise<T> {
    const bytes = await boundedRead(path.join(this.jobDirectory(accountId, id), 'journal.enc'), 2 * 1024 * 1024 + 32);
    return JSON.parse(decrypt(bytes, this.key(accountId), `journal:${id}`).toString('utf8')) as T;
  }
  async listIds(accountId: string): Promise<string[]> {
    const directory = this.accountDirectory(accountId);
    await safeDirectory(directory);
    return (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_ID.test(entry.name)).map(entry => entry.name);
  }
  async hasOtherAccounts(accountId: string): Promise<boolean> {
    const own = this.accountTag(accountId);
    for (const entry of await readdir(this.rootDir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== own) {
        if ((await readdir(path.join(this.rootDir, entry.name))).some(name => SAFE_ID.test(name))) return true;
      }
    }
    return false;
  }
  private chunkName(sequence: number): string {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 100_000) throw new Error('INVALID_SEQUENCE');
    return `${String(sequence).padStart(6, '0')}.enc`;
  }
  async writeChunk(accountId: string, id: string, sequence: number, bytes: Buffer): Promise<void> {
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES) throw new Error('CHUNK_LIMIT');
    const directory = await this.prepare(accountId, id);
    await this.writeAtomic(directory, this.chunkName(sequence), encrypt(bytes, this.key(accountId), `chunk:${id}:${sequence}`));
  }
  async readChunk(accountId: string, id: string, sequence: number): Promise<Buffer> {
    const bytes = await boundedRead(path.join(this.jobDirectory(accountId, id), this.chunkName(sequence)), MAX_CHUNK_BYTES + 32);
    return decrypt(bytes, this.key(accountId), `chunk:${id}:${sequence}`);
  }
  async removeChunks(accountId: string, id: string): Promise<void> {
    const directory = this.jobDirectory(accountId, id);
    for (const name of await readdir(directory)) {
      if (/^\d{6}\.enc$/.test(name) || /^[a-z0-9.]+\.tmp$/.test(name)) await unlink(path.join(directory, name));
    }
    await syncDirectory(directory);
  }
  async availableBytes(): Promise<number> {
    const info = await statfs(this.rootDir);
    return info.bavail * info.bsize;
  }
}
