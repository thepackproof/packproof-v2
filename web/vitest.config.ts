import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@packproof/station": path.resolve(__dirname, "../mobile/src/packing-station"),
      "@packproof/copy": path.resolve(__dirname, "../mobile/src/copy"),
      "@packproof/theme": path.resolve(__dirname, "../mobile/src/theme"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
  },
});
