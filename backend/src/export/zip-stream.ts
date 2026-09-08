import { createHash } from "node:crypto";
import { Readable } from "node:stream";

export interface ZipStreamEntry {
  name: string;
  body: AsyncIterable<Uint8Array>;
  byteSize?: number;
  sha256?: string;
  onComplete?: (result: { byteSize: number; sha256: string }) => void | Promise<void>;
}
export class ZipStreamError extends Error {
  constructor(readonly code: "ZIP_TOO_LARGE" | "ZIP_INVALID_ENTRY" | "ZIP_INTEGRITY_FAILURE", message: string) { super(message); }
}
const BLOCK_BYTES = 64 * 1024;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Uncompressed ZIP with streaming data descriptors. Only bounded headers and the
 * central directory are retained. Abort never emits a successful end directory. */
export function streamZip(entries: AsyncIterable<ZipStreamEntry>, options: { maximumBytes?: number; beforeChunk?: () => Promise<void> } = {}): Readable {
  const maximumBytes = options.maximumBytes ?? 220 * 1024 * 1024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 22 || maximumBytes > 0xffffffff)
    throw new ZipStreamError("ZIP_TOO_LARGE", "Invalid archive size bound");
  async function* generate() {
    const names = new Set<string>(), central: Buffer[] = [];
    let offset = 0, centralBytes = 0;
    function check(additional: number) {
      if (offset + additional + centralBytes + 22 > maximumBytes)
        throw new ZipStreamError("ZIP_TOO_LARGE", "Archive exceeds its encoded size limit");
    }
    async function* emit(bytes: Buffer) {
      for (let at = 0; at < bytes.length; at += BLOCK_BYTES) {
        const part = bytes.subarray(at, Math.min(bytes.length, at + BLOCK_BYTES));
        check(part.length); await options.beforeChunk?.(); offset += part.length; yield part;
      }
    }
    for await (const entry of entries) {
      try {
        const name = Buffer.from(entry.name);
        if (names.size >= 4096 || !/^[A-Za-z0-9_./-]+$/.test(entry.name) || name.length > 1024
            || entry.name.split("/").some(part => !part || part === "." || part === "..") || names.has(entry.name))
          throw new ZipStreamError("ZIP_INVALID_ENTRY", "Invalid or duplicate archive entry");
        names.add(entry.name);
        if (entry.byteSize !== undefined && (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0))
          throw new ZipStreamError("ZIP_INVALID_ENTRY", "Invalid declared entry length");
        centralBytes += 46 + name.length;
        check(30 + name.length + 16 + (entry.byteSize ?? 0));
        const start = offset, header = Buffer.alloc(30), hash = createHash("sha256");
        header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(33, 12); header.writeUInt16LE(name.length, 26);
        let crc = 0xffffffff, size = 0;
        yield* emit(header); yield* emit(name);
        for await (const chunk of entry.body) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (entry.byteSize !== undefined && size + bytes.length > entry.byteSize)
            throw new ZipStreamError("ZIP_INTEGRITY_FAILURE", "Source exceeded its declared length");
          check(bytes.length + 16);
          size += bytes.length; hash.update(bytes);
          for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
          yield* emit(bytes);
        }
        const sha256 = hash.digest("hex");
        if ((entry.byteSize !== undefined && size !== entry.byteSize) || (entry.sha256 && sha256 !== entry.sha256))
          throw new ZipStreamError("ZIP_INTEGRITY_FAILURE", "Source does not match its preserved digest and length");
        await entry.onComplete?.({ byteSize: size, sha256 });
        const value = (crc ^ 0xffffffff) >>> 0, descriptor = Buffer.alloc(16), directory = Buffer.alloc(46);
        descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(value, 4);
        descriptor.writeUInt32LE(size, 8); descriptor.writeUInt32LE(size, 12); yield* emit(descriptor);
        directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
        directory.writeUInt16LE(0x0808, 8); directory.writeUInt16LE(33, 14); directory.writeUInt32LE(value, 16);
        directory.writeUInt32LE(size, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28);
        directory.writeUInt32LE(start, 42); central.push(directory, name);
      } finally { if (entry.body instanceof Readable) entry.body.destroy(); }
    }
    const directoryOffset = offset, directorySize = centralBytes;
    // Reserved directory bytes become emitted bytes, keeping the same bound.
    for (const part of central) { centralBytes -= part.length; yield* emit(part); }
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(names.size, 8); end.writeUInt16LE(names.size, 10);
    end.writeUInt32LE(directorySize, 12); end.writeUInt32LE(directoryOffset, 16);
    await options.beforeChunk?.(); yield end;
  }
  return Readable.from(generate(), { objectMode: false, highWaterMark: BLOCK_BYTES });
}

export function zipBytes(name: string, bytes: Buffer, onComplete?: ZipStreamEntry["onComplete"]): ZipStreamEntry {
  return { name, byteSize: bytes.length, body: (async function* () { yield bytes; })(), onComplete };
}

/** Small compatibility-only collector. Production downloads must pipe the stream. */
export async function collectSmallZip(stream: Readable, maximumBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []; let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if ((total += bytes.length) > maximumBytes) throw new ZipStreamError("ZIP_TOO_LARGE", "Use the streaming download for this archive");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  } finally { stream.destroy(); }
}
