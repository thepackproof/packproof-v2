import path from "node:path";
import { createAuthentication, isDevLoginEnabled } from "./auth/create-auth.js";
import { systemClock } from "./clock.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
import { openDatabase } from "./db/open.js";
import { createObjectStore } from "./s3/create-object-store.js";

loadEnvFile(path.resolve(process.cwd()));

const config = loadConfig();
const opened = await openDatabase(config);
await migrate(opened.db);

const app = createApp({
  db: opened.db,
  objectStore: createObjectStore(config),
  clock: systemClock,
  auth: createAuthentication(config, opened.db, systemClock),
  publicBaseUrl: config.publicBaseUrl,
  devAuth: isDevLoginEnabled(config),
  corsOrigins: config.webOrigins,
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `PackProof V2 API listening on ${config.port} engine=${opened.engine} objectStore=${config.objectStore} authMode=${config.authMode}`,
  );
});

const shutdown = async () => {
  server.close();
  await opened.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
