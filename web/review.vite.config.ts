import { defineConfig, type Plugin } from "vite";
import productionConfig from "./vite.config";

function reviewRoutes(): Plugin {
  return {
    name: "packproof-local-design-review",
    config(_config, environment) {
      if (environment.command !== "serve") throw new Error("The local design review is development-only. Use the normal build command for production.");
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || "/", "http://127.0.0.1:5180").pathname;
        if (pathname.startsWith("/__review-api")) {
          response.statusCode = 404;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ error: { code: "REVIEW_FIXTURE_MISSING", message: "This local review request has no fixture." } }));
          return;
        }
        if (request.headers.accept?.includes("text/html") && !pathname.startsWith("/@") && !pathname.startsWith("/src/") && !pathname.startsWith("/dev/")) {
          request.url = "/review.html";
        }
        next();
      });
    },
  };
}

export default defineConfig({
  ...productionConfig,
  define: {
    ...productionConfig.define,
    "import.meta.env.VITE_PACKPROOF_API_BASE_URL": JSON.stringify("http://127.0.0.1:5180/__review-api"),
    "import.meta.env.VITE_PACKPROOF_AUTH_MODE": JSON.stringify("dev"),
  },
  plugins: [reviewRoutes(), ...(productionConfig.plugins || [])],
  server: {
    ...productionConfig.server,
    host: "127.0.0.1",
    port: 5180,
    strictPort: true,
    // Review requests must never be forwarded to a PackProof API.
    proxy: {},
  },
});
