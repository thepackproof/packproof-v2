import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { legalDocuments } from "./src/legal/documents";
import { renderLegalHtml } from "./src/legal/render-html";

const root = path.dirname(fileURLToPath(import.meta.url));

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
  plugins: [react(), emitLegalPages()],
  appType: "spa",
  resolve: {
    alias: {
      "@packproof/station": path.resolve(root, "../mobile/src/packing-station"),
      "@packproof/copy": path.resolve(root, "../mobile/src/copy"),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
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
