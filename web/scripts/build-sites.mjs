import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateAssociations } from "./app-associations.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
// Release builds that declare verified links must supply the actual platform
// signing identity. Unrelated web-only releases keep existing documents intact.
if (process.env.PACKPROOF_LINK_PLATFORMS) await generateAssociations({ platform: process.env.PACKPROOF_LINK_PLATFORMS });
const result = spawnSync("npm", ["run", "build"], {
  cwd: path.join(root, "web"),
  stdio: "inherit",
  env: {
    ...process.env,
    VITE_PACKPROOF_API_BASE_URL: "/api",
    VITE_PACKPROOF_AUTH_MODE: "cognito",
    VITE_PACKPROOF_COGNITO_USER_POOL_ID: "us-east-1_GdgTeYaOO",
    VITE_PACKPROOF_COGNITO_CLIENT_ID: "34pnucunllka2jcs8hsq762m5e",
    VITE_PACKPROOF_COGNITO_REGION: "us-east-1",
  },
});
if (result.status !== 0) process.exit(result.status ?? 1);
rmSync(path.join(root, "dist"), { recursive: true, force: true });
mkdirSync(path.join(root, "dist/server"), { recursive: true });
mkdirSync(path.join(root, "dist/.openai"), { recursive: true });
cpSync(path.join(root, "web/dist"), path.join(root, "dist/client"), { recursive: true });
// All browser routes, including legacy legal links, use the unified navigation.
rmSync(path.join(root, "dist/client/new"), { recursive: true, force: true });
cpSync(path.join(root, "web/scripts/sites-worker.mjs"), path.join(root, "dist/server/index.js"));
cpSync(path.join(root, ".openai/hosting.json"), path.join(root, "dist/.openai/hosting.json"));
