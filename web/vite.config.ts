import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { legalDocuments } from "./src/legal/documents";
import { renderLegalHtml } from "./src/legal/render-html";

const root = path.dirname(fileURLToPath(import.meta.url));
const webVersion: string = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
function webBuild(): string | undefined {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return !dirty && /^[0-9a-f]{40}$/.test(commit) ? commit : undefined;
  } catch { return undefined; }
}

const api = {
  target: "http://127.0.0.1:3000",
  bypass(req: { headers: { accept?: string } }) {
    if (req.headers.accept?.includes("text/html")) {
      return "/index.html";
    }
  },
};

function emitLegalPages(): Plugin {
  return {
    name: "packproof-legal-pages",
    closeBundle() {
      const css = readFileSync(path.join(root, "src/legal/legal.css"), "utf8");
      const outDir = path.join(root, "dist");
      for (const document of legalDocuments) {
        const dir = path.join(outDir, "new", document.kind);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "index.html"), renderLegalHtml(document, css));
      }
    },
  };
}

export default defineConfig({
  define: {
    "import.meta.env.VITE_PACKPROOF_WEB_VERSION": JSON.stringify(webVersion),
    "import.meta.env.VITE_PACKPROOF_WEB_BUILD": JSON.stringify(webBuild() ?? ""),
  },
  plugins: [react(), emitLegalPages()],
  appType: "spa",
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { jsx: "react-jsx", useDefineForClassFields: true } }) },
  resolve: {
    alias: {
      "@packproof/station": path.resolve(root, "../mobile/src/packing-station"),
      "@packproof/copy": path.resolve(root, "../mobile/src/copy"),
      "@packproof/theme": path.resolve(root, "../mobile/src/theme"),
    },
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/admin": api,
      "/analytics": api,
      "/v1": api,
      "/order-intake": api,
      "/upload": api,
      "/health": api,
      "/auth": api,
      "/me": api,
      "/dev": api,
      "/proofs": api,
      "/transactions": api,
      "/integrations": api,
      "/invitations": api,
      "/users": api,
      "/public": api,
      "/oauth": api,
    },
  },
});
