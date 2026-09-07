import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { expect, it, vi } from "vitest";
import { collectSmallZip, streamZip, zipBytes } from "../src/export/zip-stream.js";

it("streams a 12MiB descriptor ZIP that Python validates without buffering the original or complete archive", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "packproof-stream-zip-"));
  let pulled = 0, largest = 0;
  const block = Buffer.alloc(64 * 1024, 101), expected = createHash("sha256");
  for (let i = 0; i < 192; i++) expected.update(block);
  try {
    const stream = streamZip((async function* () {
      yield { name: "media/original.bin", byteSize: block.length * 192, sha256: expected.digest("hex"),
        body: (async function* () { for (let i = 0; i < 192; i++) { pulled++; yield block; } })() };
      yield zipBytes("record.json", Buffer.from('{"version":1}'));
    })());
    expect(pulled).toBe(0);
    const file = path.join(folder, "original.zip");
    await pipeline(stream, async function* (source) { for await (const chunk of source) { largest = Math.max(largest, chunk.length); yield chunk; } }, createWriteStream(file));
    expect(pulled).toBe(192); expect(largest).toBeLessThanOrEqual(128 * 1024);
    const checked = spawnSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.getinfo('media/original.bin').file_size==12*1024*1024; assert z.getinfo('media/original.bin').flag_bits&8; assert z.read('record.json')==b'{\"version\":1}'", file], { encoding: "utf8" });
    expect(checked.status, checked.stderr).toBe(0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

it("rejects an oversized declared entry before pulling media and closes its source", async () => {
  let pulled = false;
  const body = Readable.from((async function* () { pulled = true; yield Buffer.alloc(2048); })());
  const archive = streamZip((async function* () { yield { name: "media.bin", byteSize: 2048, body }; })(), { maximumBytes: 1024 });
  await expect(collectSmallZip(archive)).rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  expect(pulled).toBe(false); expect(body.destroyed).toBe(true);
});

it("fails wrong digest and small-collector overflow instead of emitting an apparently complete ZIP", async () => {
  const wrong = streamZip((async function* () { yield { name: "media.bin", body: Readable.from([Buffer.from("changed")]), byteSize: 7, sha256: "a".repeat(64) }; })());
  await expect(collectSmallZip(wrong)).rejects.toMatchObject({ code: "ZIP_INTEGRITY_FAILURE" });
  const large = streamZip((async function* () { yield zipBytes("media.bin", Buffer.alloc(2048)); })());
  await expect(collectSmallZip(large, 1024)).rejects.toMatchObject({ code: "ZIP_TOO_LARGE" });
  expect(large.destroyed).toBe(true);
});

it("closes a lazy large original promptly when the download consumer disconnects", async () => {
  let pulled = 0, closed = false, received = 0;
  const body = Readable.from((async function* () {
    try { for (let i = 0; i < 2048; i++) { pulled++; yield Buffer.alloc(64 * 1024); } }
    finally { closed = true; }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
  const archive = streamZip((async function* () { yield { name: "large.bin", byteSize: 128 * 1024 * 1024, body }; })());
  for await (const chunk of archive) { if ((received += chunk.length) > 64 * 1024) break; }
  await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000, interval: 10 });
  expect(pulled).toBeLessThan(10); expect(body.destroyed).toBe(true);
});
