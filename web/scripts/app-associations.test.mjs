import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { androidAssociation, appleAssociation, generateAssociations, ownedPaths } from "./app-associations.mjs";

const fingerprint = Array(32).fill("AB").join(":");
test("Android preserves unrelated associations and authorized rotated certificates", () => {
  const old = Array(32).fill("CD").join(":");
  const other = { relation: ["unrelated"], target: { namespace: "web", site: "https://example.com" } };
  const initial = [other, { relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "com.packproof.mobile", sha256_cert_fingerprints: [old] } }];
  const merged = androidAssociation(initial, "com.packproof.mobile", fingerprint);
  assert.deepEqual(merged[0], other);
  assert.deepEqual(merged[1].target.sha256_cert_fingerprints, [old, fingerprint]);
  assert.deepEqual(initial[1].target.sha256_cert_fingerprints, [old]);
  assert.deepEqual(androidAssociation(merged, "com.packproof.mobile", fingerprint), merged);
});

test("Apple retains existing services and applications without intercepting public sharing", () => {
  const prior = { applinks: { apps: [], details: [{ appID: "OTHERTEAM1.com.example", paths: ["/old/*"] }] }, webcredentials: { apps: ["OTHERTEAM1.com.example"] } };
  const merged = appleAssociation(prior, "com.packproof.mobile", "TESTTEAM01.com.packproof.mobile");
  assert.deepEqual(merged.applinks.details[0], prior.applinks.details[0]);
  assert.deepEqual(merged.webcredentials, prior.webcredentials);
  assert.deepEqual(merged.applinks.details[1].components.map(row => row["/"]), ownedPaths);
  assert.equal(ownedPaths.some(path => path === "*" || path.startsWith("/p/")), false);
  assert.deepEqual(appleAssociation(merged, "com.packproof.mobile", "TESTTEAM01.com.packproof.mobile"), merged);
});

test("release documents fail closed without real platform identities; independent Android generation works", async () => {
  const directory = await mkdtemp(join(tmpdir(), "packproof-associations-"));
  const config = { android: { package: "com.packproof.mobile" }, ios: { bundleIdentifier: "com.packproof.mobile" } };
  try {
    await assert.rejects(generateAssociations({ directory, platform: "all", config, env: { PACKPROOF_PLAY_APP_SIGNING_SHA256: fingerprint } }), /actual signed application's/);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(generateAssociations({ directory, platform: "android", config, env: {} }), /actual Play App Signing/);
    await generateAssociations({ directory, platform: "android", config, env: { PACKPROOF_PLAY_APP_SIGNING_SHA256: fingerprint } });
    assert.equal(JSON.parse(await readFile(join(directory, "assetlinks.json"), "utf8"))[0].target.package_name, "com.packproof.mobile");
  } finally { await rm(directory, { recursive: true }); }
});
