import path from "node:path";
import { BearerUserAdapter } from "./auth/adapter.js";
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
  auth: new BearerUserAdapter(opened.db),
  publicBaseUrl: config.publicBaseUrl,
  devAuth: config.devAuth,
});

const server = app.listen(config.port, () => {
  console.log(
    `PackProof V2 API listening on ${config.port} using ${opened.engine}`,
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
