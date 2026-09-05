import path from "node:path";
import { createAuthentication, isDevLoginEnabled } from "./auth/create-auth.js";
import { systemClock } from "./clock.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createServerApp } from "./server-app.js";
import { openDatabase } from "./db/open.js";
import { createObjectStore } from "./s3/create-object-store.js";
import { createDefaultIntegrationRegistry } from "./integrations/registry.js";
import { createCredentialStore } from "./integrations/create-credential-store.js";
import { createEbayRuntime } from "./integrations/ebay/runtime.js";
import { webhookConfigFromEnv } from "./platform/webhooks.js";
import { startWebhookWorker } from "./platform/worker.js";
import {
  createFacebookRuntime,
  createGoogleRuntime,
  createShopifyRuntime,
} from "./integrations/connected-accounts/from-config.js";

loadEnvFile(path.resolve(process.cwd()));

const config = loadConfig();
const opened = await openDatabase(config);
await migrate(opened.db);
const credentialStore = createCredentialStore(config);
const webhookConfig = webhookConfigFromEnv();

const app = createServerApp({
  db: opened.db,
  objectStore: createObjectStore(config),
  clock: systemClock,
  auth: createAuthentication(config, opened.db, systemClock),
  publicBaseUrl: config.publicBaseUrl,
  devAuth: isDevLoginEnabled(config),
  corsOrigins: config.webOrigins,
  integrations: createDefaultIntegrationRegistry(systemClock),
  credentialStore,
  webhookConfig,
  releaseIdentity: config.release,
  ebay: createEbayRuntime(config, {
    publicBaseUrl: config.publicBaseUrl,
    webOrigins: config.webOrigins,
  }),
  shopify: createShopifyRuntime(config),
  google: createGoogleRuntime(config),
  facebook: createFacebookRuntime(config),
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `PackProof V2 API listening on ${config.port} engine=${opened.engine} objectStore=${config.objectStore} authMode=${config.authMode}`,
  );
});
const stopWebhookWorker =
  webhookConfig.encryptionKey &&
  webhookConfig.allowedHosts.length &&
  process.env.PACKPROOF_WEBHOOK_WORKER !== "false"
    ? startWebhookWorker(opened.db, systemClock, webhookConfig)
    : async () => {};

const shutdown = async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await stopWebhookWorker();
  await opened.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
