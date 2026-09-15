import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ownedPaths = ["/app/packing", "/app/proofs", "/app/proofs/*", "/app/capture/*"];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function androidAssociation(existing, packageName, fingerprintInput) {
  if (!Array.isArray(existing)) throw new Error("Existing assetlinks.json must be a JSON array; refusing to replace it.");
  const fingerprints = [...new Set(String(fingerprintInput || "").split(",").map(v => v.trim().toUpperCase()).filter(Boolean))];
  if (!fingerprints.length || fingerprints.some(v => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(v))) {
    throw new Error("PACKPROOF_PLAY_APP_SIGNING_SHA256 must contain actual Play App Signing SHA-256 fingerprints (comma-separated for rotation), not an upload-key fingerprint.");
  }
  if (!packageName || !/^[A-Za-z]\w*(?:\.\w+)+$/.test(packageName)) throw new Error("The current Android package identity is missing.");
  const output = structuredClone(existing);
  const entry = output.find(row => row?.target?.namespace === "android_app" && row.target.package_name === packageName && row.relation?.includes("delegate_permission/common.handle_all_urls"));
  if (entry) entry.target.sha256_cert_fingerprints = [...new Set([...(entry.target.sha256_cert_fingerprints || []), ...fingerprints])];
  else output.push({ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: packageName, sha256_cert_fingerprints: fingerprints } });
  return output;
}

export function appleAssociation(existing, bundleIdentifier, applicationIdentifier) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("Existing AASA must be a JSON object; refusing to replace it.");
  if (!applicationIdentifier || !/^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(applicationIdentifier) || applicationIdentifier.slice(11) !== bundleIdentifier) {
    throw new Error("PACKPROOF_APPLE_APPLICATION_IDENTIFIER must be the actual signed application's application-identifier entitlement, matching the current iOS bundleIdentifier.");
  }
  const output = structuredClone(existing);
  output.applinks ||= { apps: [], details: [] };
  if (!Array.isArray(output.applinks.details)) throw new Error("Existing AASA applinks.details is invalid; refusing to replace it.");
  // Add a scoped entry instead of modifying other applications or older paths.
  const components = ownedPaths.map(path => ({ "/": path }));
  if (!output.applinks.details.some(row => JSON.stringify(row.appIDs) === JSON.stringify([applicationIdentifier]) && JSON.stringify(row.components) === JSON.stringify(components))) {
    output.applinks.details.push({ appIDs: [applicationIdentifier], components });
  }
  return output;
}

async function readExisting(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

export async function generateAssociations({ directory = resolve(root, "public/.well-known"), platform, env = process.env, config } = {}) {
  if (!["android", "ios", "all"].includes(platform)) throw new Error("Select --platform android, ios, or all; platforms release independently.");
  config ||= createRequire(import.meta.url)(resolve(root, "../mobile/app.config.js")).expo;
  const writes = [];
  if (platform !== "ios") {
    const path = resolve(directory, "assetlinks.json");
    writes.push([path, androidAssociation(await readExisting(path, []), config.android?.package, env.PACKPROOF_PLAY_APP_SIGNING_SHA256)]);
  }
  if (platform !== "android") {
    const path = resolve(directory, "apple-app-site-association");
    writes.push([path, appleAssociation(await readExisting(path, {}), config.ios?.bundleIdentifier, env.PACKPROOF_APPLE_APPLICATION_IDENTIFIER)]);
  }
  // Validate every requested platform before writing any document.
  await mkdir(directory, { recursive: true });
  for (const [path, value] of writes) await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return writes.map(([path]) => path);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const platform = args[args.indexOf("--platform") + 1];
  const directory = args.includes("--directory") ? resolve(args[args.indexOf("--directory") + 1]) : undefined;
  try { for (const path of await generateAssociations({ platform, directory })) console.log(path); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
