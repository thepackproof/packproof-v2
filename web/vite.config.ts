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
  server: {
    port: 5173,
    proxy: {
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
