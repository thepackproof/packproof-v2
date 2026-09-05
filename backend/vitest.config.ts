import { defineConfig } from "vitest/config";

export default defineConfig({
  // These tests import framework-free native contracts; Expo is not a backend dependency.
  esbuild: { tsconfigRaw: JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", jsx: "react-jsx", useDefineForClassFields: true } }) },
  test: {
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30000,
  },
});
