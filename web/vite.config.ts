import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const api = {
  target: "http://127.0.0.1:3000",
  bypass(req: { headers: { accept?: string } }) {
    if (req.headers.accept?.includes("text/html")) {
      return "/index.html";
    }
  },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@packproof/station": path.resolve(__dirname, "../mobile/src/packing-station"),
      "@packproof/copy": path.resolve(__dirname, "../mobile/src/copy"),
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
    },
  },
});
