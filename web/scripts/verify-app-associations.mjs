import { createRequire } from "node:module";
import { androidAssociation, appleAssociation } from "./app-associations.mjs";

const platform = process.argv[process.argv.indexOf("--platform") + 1];
if (!["android", "ios", "all"].includes(platform)) throw new Error("Select --platform android, ios, or all.");
const config = createRequire(import.meta.url)("../../mobile/app.config.js").expo;
const paths = [];
if (platform !== "ios") {
  androidAssociation([], config.android.package, process.env.PACKPROOF_PLAY_APP_SIGNING_SHA256);
  paths.push(["/.well-known/assetlinks.json", value => androidAssociation(value, config.android.package, process.env.PACKPROOF_PLAY_APP_SIGNING_SHA256)]);
}
if (platform !== "android") {
  appleAssociation({}, config.ios.bundleIdentifier, process.env.PACKPROOF_APPLE_APPLICATION_IDENTIFIER);
  paths.push(["/.well-known/apple-app-site-association", value => appleAssociation(value, config.ios.bundleIdentifier, process.env.PACKPROOF_APPLE_APPLICATION_IDENTIFIER)]);
}
for (const hostname of ["thepackproof.com", "www.thepackproof.com"]) {
  for (const [path, validate] of paths) {
    const response = await fetch(`https://${hostname}${path}`, { redirect: "manual", signal: AbortSignal.timeout(10000) });
    if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get("content-type") || "")) throw new Error(`${hostname}${path}: expected direct HTTP 200 application/json, received ${response.status}.`);
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error(`${hostname}${path}: association document exceeds 128 KiB.`);
    const value = JSON.parse(raw);
    if (JSON.stringify(validate(value)) !== JSON.stringify(value)) throw new Error(`${hostname}${path}: current release identity or scoped routes are missing.`);
    console.log(`${hostname}${path}: release identity verified`);
  }
}
