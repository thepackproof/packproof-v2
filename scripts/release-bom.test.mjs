import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createReleaseBom, inventoryTree } from "./release-bom.mjs";

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), "packproof-bom-")); const root = join(temporary, "source");
  await mkdir(join(root, "backend/migrations"), { recursive: true }); await mkdir(join(root, "web")); await mkdir(join(root, "mobile"));
  for (const dir of ["backend", "web", "mobile"]) await writeFile(join(root, dir, "package-lock.json"), "{}\n");
  await writeFile(join(root, "backend/migrations/001_init.sql"), "CREATE TABLE example(id TEXT);\n");
  await writeFile(join(root, "mobile/app.config.js"), 'module.exports={expo:{version:"1.2.3",android:{versionCode:4}}};\n');
  await writeFile(join(root, ".gitignore"), "dist/\n");
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Synthetic release fixture");
  try { await run({ root, temporary, sha: git("rev-parse", "HEAD") }); } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("BOM records exact clean source and checksum set without inferring deployment", async () => fixture(async ({ root, temporary, sha }) => {
  const bom = await createReleaseBom({ root, output: join(temporary, "bom.json"), expectedSourceSha: sha });
  assert.equal(bom.source.sha, sha); assert.equal(bom.source.state, "inspected_clean_commit");
  assert.equal(bom.migrations.length, 1); assert.match(bom.migrations[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(bom.builds.android.configuredVersionCode, 4); assert.equal(bom.runtime.state, "not_supplied");
  assert.equal(bom.compatibility.releaseGatePassed, false); assert.ok(bom.compatibility.missingEvidence.length > 0);
}));

test("BOM refuses dirty or different source unless explicitly labeled a candidate", async () => fixture(async ({ root, temporary }) => {
  await assert.rejects(createReleaseBom({ root, output: join(temporary, "bom.json"), expectedSourceSha: "a".repeat(40) }), /RELEASE_SOURCE_SHA_MISMATCH/);
  await writeFile(join(root, "backend/migrations/001_init.sql"), "SELECT 'changed';\n");
  await assert.rejects(createReleaseBom({ root, output: join(temporary, "bom.json") }), /RELEASE_SOURCE_DIRTY/);
  const candidate = await createReleaseBom({ root, output: join(temporary, "bom.json"), allowDirty: true });
  assert.equal(candidate.source.state, "inspected_dirty_candidate");
}));

test("artifact inventories are deterministic and reported mismatches remain blocked", async () => fixture(async ({ root, temporary }) => {
  const dist = join(root, "web/dist"); await mkdir(dist); await writeFile(join(dist, "b.js"), "b"); await writeFile(join(dist, "a.js"), "a");
  assert.deepEqual(await inventoryTree(dist), await inventoryTree(dist));
  const evidence = join(temporary, "runtime.json");
  await writeFile(evidence, JSON.stringify({ environment: "staging", deployedSourceSha: "a".repeat(40), webAssetTreeSha256: "b".repeat(64) }));
  const bom = await createReleaseBom({ root, output: join(temporary, "bom.json"), webDist: dist, runtimeEvidence: evidence });
  assert.equal(bom.compatibility.mismatches.length, 2); assert.equal(bom.compatibility.releaseGatePassed, false);
  await writeFile(evidence, JSON.stringify({ apiSecret: "must not be stored in release evidence" }));
  await assert.rejects(createReleaseBom({ root, output: join(temporary, "bom.json"), runtimeEvidence: evidence }), /INVALID_RUNTIME_EVIDENCE_FIELDS/);
}));
