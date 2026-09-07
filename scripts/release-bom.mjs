#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const digestPattern = /^[a-f0-9]{64}$/;
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
async function hashFile(path) {
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest("hex"), bytes };
}
export async function inventoryTree(directory) {
  const files = [];
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("ARTIFACT_SYMLINK_REJECTED");
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push({ path: relative(directory, full).split(sep).join("/"), ...await hashFile(full) });
    }
  }
  await walk(directory);
  return { state: "artifact_hashed", files, treeSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

function validateRuntimeEvidence(input) {
  const keys = ["environment", "apiImageDigest", "deployedSourceSha", "deployedMigrationChecksums", "webAssetTreeSha256", "distributedAndroidSha256", "devices", "capabilityVersions", "featureFlags", "signingKeyReference", "verifierTrustConfigSha256", "releaseEvidenceReferences"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw new Error("INVALID_RUNTIME_EVIDENCE_FIELDS");
  for (const key of ["webAssetTreeSha256", "distributedAndroidSha256", "verifierTrustConfigSha256"]) if (input[key] != null && !digestPattern.test(input[key])) throw new Error("INVALID_RUNTIME_DIGEST");
  if (input.deployedSourceSha != null && !/^[a-f0-9]{40}$/.test(input.deployedSourceSha)) throw new Error("INVALID_RUNTIME_SOURCE");
  if (input.apiImageDigest != null && !/^sha256:[a-f0-9]{64}$/.test(input.apiImageDigest)) throw new Error("INVALID_IMAGE_DIGEST");
  if (input.environment != null && !/^[a-z][a-z0-9_-]{0,39}$/.test(input.environment)) throw new Error("INVALID_RUNTIME_ENVIRONMENT");
  if (input.signingKeyReference != null && (typeof input.signingKeyReference !== "string" || !/^(arn:aws[a-z-]*:kms:|alias\/|kms:)/.test(input.signingKeyReference))) throw new Error("SIGNING_KEY_REFERENCE_ONLY");
  for (const key of ["deployedMigrationChecksums", "devices", "releaseEvidenceReferences"]) if (input[key] != null && !Array.isArray(input[key])) throw new Error("INVALID_RUNTIME_LIST");
  for (const row of input.deployedMigrationChecksums ?? []) {
    if (!row || Object.keys(row).sort().join(",") !== "id,sha256" || !/^\d+_[a-z0-9_]+$/.test(row.id) || !digestPattern.test(row.sha256)) throw new Error("INVALID_MIGRATION_EVIDENCE");
  }
  if (new Set((input.deployedMigrationChecksums ?? []).map(row => row.id)).size !== (input.deployedMigrationChecksums ?? []).length) throw new Error("DUPLICATE_MIGRATION_EVIDENCE");
  for (const row of input.devices ?? []) {
    const required = ["model", "installedVersionCode", "installedArtifactSha256", "evidenceReference"];
    if (!row || Object.keys(row).some(key => !required.includes(key)) || required.some(key => !(key in row))
      || !["S24 Ultra", "A16 5G"].includes(row.model) || !Number.isSafeInteger(row.installedVersionCode) || row.installedVersionCode < 1
      || !digestPattern.test(row.installedArtifactSha256) || typeof row.evidenceReference !== "string" || row.evidenceReference.length > 400) throw new Error("INVALID_DEVICE_EVIDENCE");
  }
  if (input.featureFlags != null && (typeof input.featureFlags !== "object" || Array.isArray(input.featureFlags)
    || Object.entries(input.featureFlags).some(([key, value]) => !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(key) || typeof value !== "boolean"))) throw new Error("BOOLEAN_FEATURE_FLAGS_ONLY");
  if (input.capabilityVersions != null && (typeof input.capabilityVersions !== "object" || Array.isArray(input.capabilityVersions)
    || Object.entries(input.capabilityVersions).some(([key, versions]) => !/^[a-zA-Z][a-zA-Z0-9]{0,49}$/.test(key) || !Array.isArray(versions) || versions.some(version => !Number.isSafeInteger(version) || version < 1)))) throw new Error("INVALID_CAPABILITY_VERSIONS");
  if ((input.releaseEvidenceReferences ?? []).some(reference => typeof reference !== "string" || reference.length > 400)) throw new Error("INVALID_RELEASE_EVIDENCE_REFERENCE");
  return input;
}

export async function createReleaseBom({ root, output, allowDirty = false, webDist, apiDist, androidArtifact, runtimeEvidence, expectedSourceSha }) {
  root = resolve(root);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  if (expectedSourceSha && expectedSourceSha !== sourceSha) throw new Error("RELEASE_SOURCE_SHA_MISMATCH");
  const outputRelative = output ? relative(root, resolve(output)).split(sep).join("/") : null;
  const changes = git(root, ["status", "--porcelain", "--untracked-files=all"]).split("\n").filter(Boolean)
    .filter(line => line.slice(3) !== outputRelative);
  if (changes.length && !allowDirty) throw new Error("RELEASE_SOURCE_DIRTY");
  const migrations = [];
  for (const filename of (await readdir(join(root, "backend/migrations"))).filter(name => name.endsWith(".sql")).sort()) {
    migrations.push({ id: filename.replace(/\.sql$/, ""), path: `backend/migrations/${filename}`, ...await hashFile(join(root, "backend/migrations", filename)) });
  }
  const lockfiles = []; const dependencyLicenseInventory = [];
  for (const path of ["backend/package-lock.json", "web/package-lock.json", "mobile/package-lock.json"]) {
    lockfiles.push({ path, ...await hashFile(join(root, path)) });
    const lock = JSON.parse(await readFile(join(root, path), "utf8"));
    const packages = Object.entries(lock.packages ?? {}).filter(([packagePath]) => packagePath !== "");
    if (packages.length > 10_000) throw new Error("DEPENDENCY_INVENTORY_TOO_LARGE");
    const dependencies = packages.sort(([a], [b]) => a.localeCompare(b)).map(([packagePath, entry]) => ({
      name: entry.name ?? packagePath.split("node_modules/").at(-1), version: entry.version ?? null, packagePath,
      license: typeof entry.license === "string" ? entry.license : entry.license?.type ?? null,
      developmentOnly: entry.dev === true, linkedSource: entry.link === true,
    }));
    dependencyLicenseInventory.push({ source: path, packages: dependencies, count: dependencies.length,
      missingLicenseCount: dependencies.filter(item => !item.license).length,
      note: "Lockfile metadata is an inventory, not legal license approval. Missing licenses require package/source review; transitive obligations remain applicable." });
  }
  const mobileConfig = await readFile(join(root, "mobile/app.config.js"), "utf8");
  const declaredVersion = mobileConfig.match(/\bversion:\s*"([^"]+)"/)?.[1] ?? null;
  const declaredVersionCode = Number(mobileConfig.match(/\bversionCode:\s*(\d+)/)?.[1]) || null;
  let runtime = null;
  if (runtimeEvidence) {
    if ((await stat(runtimeEvidence)).size > 1024 * 1024) throw new Error("RUNTIME_EVIDENCE_TOO_LARGE");
    runtime = validateRuntimeEvidence(JSON.parse(await readFile(runtimeEvidence, "utf8")));
  }
  const web = webDist ? await inventoryTree(resolve(webDist)) : { state: "not_supplied" };
  const api = apiDist ? await inventoryTree(resolve(apiDist)) : { state: "not_supplied" };
  const android = androidArtifact ? { state: "artifact_hashed", filename: androidArtifact.split(/[\\/]/).pop(), ...await hashFile(resolve(androidArtifact)) } : { state: "not_supplied" };
  const mismatches = [];
  if (runtime?.deployedSourceSha && runtime.deployedSourceSha !== sourceSha) mismatches.push("Deployed API source differs from the inspected source.");
  for (const deployed of runtime?.deployedMigrationChecksums ?? []) {
    if (migrations.find(row => row.id === deployed.id)?.sha256 !== deployed.sha256) mismatches.push(`Deployed migration ${deployed.id} differs or is absent from this source.`);
  }
  if (runtime?.webAssetTreeSha256 && web.state === "artifact_hashed" && runtime.webAssetTreeSha256 !== web.treeSha256) mismatches.push("Deployed web asset inventory differs from the hashed build.");
  if (runtime?.distributedAndroidSha256 && android.state === "artifact_hashed" && runtime.distributedAndroidSha256 !== android.sha256) mismatches.push("Distributed Android artifact differs from the hashed build.");
  for (const device of runtime?.devices ?? []) {
    if (device.installedVersionCode !== declaredVersionCode) mismatches.push(`${device.model} installed version differs from source configuration.`);
    if (runtime?.distributedAndroidSha256 && device.installedArtifactSha256 !== runtime.distributedAndroidSha256) mismatches.push(`${device.model} installation does not match the reported distributed artifact.`);
  }
  const gaps = [];
  if (!runtime?.apiImageDigest) gaps.push("API image digest and deployed runtime evidence missing.");
  if (!runtime?.deployedSourceSha) gaps.push("Deployed source identity missing.");
  if ((runtime?.deployedMigrationChecksums ?? []).length !== migrations.length) gaps.push("Complete deployed migration checksum set missing.");
  if (web.state !== "artifact_hashed" || !runtime?.webAssetTreeSha256) gaps.push("Built-to-deployed web identity incomplete.");
  if (android.state !== "artifact_hashed" || !runtime?.distributedAndroidSha256) gaps.push("Built-to-distributed Android identity incomplete.");
  if (!runtime?.devices?.some(device => device.model === "S24 Ultra") || !runtime?.devices?.some(device => device.model === "A16 5G")) gaps.push("Both physical device installation records required.");
  if (!runtime?.signingKeyReference || !runtime?.verifierTrustConfigSha256) gaps.push("Signing reference and verifier trust configuration evidence missing.");
  if (!runtime?.capabilityVersions || !runtime?.featureFlags) gaps.push("Runtime capability and flag inventory missing.");
  return {
    schemaVersion: "packproof.release-bom.v1", recordedAt: new Date().toISOString(), source: {
      state: changes.length ? "inspected_dirty_candidate" : "inspected_clean_commit", sha: sourceSha, tree: git(root, ["rev-parse", "HEAD^{tree}"]),
      committedAt: git(root, ["show", "-s", "--format=%cI", "HEAD"]), dirtyPaths: changes, lockfiles,
    }, migrations, dependencyLicenseInventory, builds: { api, web, android: { ...android, configuredVersion: declaredVersion, configuredVersionCode: declaredVersionCode,
      configurationSha256: (await hashFile(join(root, "mobile/app.config.js"))).sha256 } },
    runtime: runtime ? { state: "reported_evidence_requires_review", evidence: runtime, sourceFileSha256: (await hashFile(runtimeEvidence)).sha256 } : { state: "not_supplied" },
    compatibility: { mismatches, missingEvidence: gaps, releaseGatePassed: false,
      note: "This inventory hashes available bytes and compares supplied identities. It does not independently prove deployment, Play distribution, installation, rollback, protections or physical device behavior." },
    generation: { nodeVersion: process.version, tool: "scripts/release-bom.mjs" },
  };
}

export function safeBomFailureCode(error) {
  // Only fixed tool codes are printed; never command stderr, path contents or supplied fields.
  const allowed = new Set(["RELEASE_SOURCE_SHA_MISMATCH", "RELEASE_SOURCE_DIRTY", "ARTIFACT_SYMLINK_REJECTED", "INVALID_RUNTIME_EVIDENCE_FIELDS", "INVALID_RUNTIME_DIGEST", "INVALID_RUNTIME_SOURCE", "INVALID_IMAGE_DIGEST", "INVALID_RUNTIME_ENVIRONMENT", "SIGNING_KEY_REFERENCE_ONLY", "INVALID_RUNTIME_LIST", "INVALID_MIGRATION_EVIDENCE", "DUPLICATE_MIGRATION_EVIDENCE", "INVALID_DEVICE_EVIDENCE", "BOOLEAN_FEATURE_FLAGS_ONLY", "INVALID_CAPABILITY_VERSIONS", "INVALID_RELEASE_EVIDENCE_REFERENCE", "DEPENDENCY_INVENTORY_TOO_LARGE", "RUNTIME_EVIDENCE_TOO_LARGE", "INVALID_BOM_ARGUMENTS", "BOM_OUTPUT_REQUIRED"]);
  if (error instanceof Error && allowed.has(error.message)) return error.message;
  if (error?.code === "ENOENT") return "BOM_INPUT_NOT_FOUND";
  if (error?.code === "EACCES") return "BOM_INPUT_ACCESS_DENIED";
  return "RELEASE_BOM_FAILED";
}

async function cli(args) {
  const options = new Map(); let allowDirty = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--allow-dirty") { allowDirty = true; continue; }
    if (!["--root", "--out", "--web-dist", "--api-dist", "--android-artifact", "--runtime-evidence", "--expected-sha"].includes(flag)
      || !args[index + 1] || args[index + 1].startsWith("--") || options.has(flag)) throw new Error("INVALID_BOM_ARGUMENTS");
    options.set(flag, args[++index]);
  }
  const output = options.get("--out"); if (!output) throw new Error("BOM_OUTPUT_REQUIRED");
  const bom = await createReleaseBom({ root: options.get("--root") ?? process.cwd(), output, allowDirty,
    webDist: options.get("--web-dist"), apiDist: options.get("--api-dist"), androidArtifact: options.get("--android-artifact"),
    runtimeEvidence: options.get("--runtime-evidence"), expectedSourceSha: options.get("--expected-sha") });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(output, `${JSON.stringify(bom, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Release BOM written; ${bom.compatibility.mismatches.length} identity mismatches and ${bom.compatibility.missingEvidence.length} evidence gaps.\n`);
  if (bom.compatibility.mismatches.length) process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) cli(process.argv.slice(2)).catch(error => {
  // Never dump process environment, supplied inventory fields or command errors.
  process.stderr.write(`${safeBomFailureCode(error)}: check source cleanliness, expected SHA, artifact paths and the allowlisted evidence schema.\n`); process.exitCode = 1;
});
