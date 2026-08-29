import { createHash } from "node:crypto";

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256HexFromStream(
  body: AsyncIterable<Uint8Array | Buffer | string>,
): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of body) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    hash.update(buf);
    byteSize += buf.byteLength;
  }
  return { sha256: hash.digest("hex"), byteSize };
}
