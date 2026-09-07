import { assertPolicyAccessSafe } from "./domain/policy-recovery.js";
import { initializeRecoveryPublisher } from "./operations/recovery-runtime.js";
import express from "express";
import { liveness,createReadiness } from "./operations/readiness.js";
import { dispatchCaptureShipments } from './workers/capture-shipment-worker.js';
import { startOperationsWorkers } from './operations/runtime-jobs.js';
import { assertSchemaCurrent } from './db/migrate.js';
import type { ScheduledJob } from './operations/scheduler.js';
import path from "node:path";
import { initializeManifestSigningRuntime } from "./integrity/kms-signing-runtime.js";
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
import { createEbayCommerceAdapter } from "./integrations/ebay/adapter.js";

import { dispatchCommerceSyncs } from "./workers/commerce-worker.js";
import { dispatchWebhooks } from "./platform/webhooks.js";
import {
  createFacebookRuntime,
  createGoogleRuntime,
  createShopifyRuntime,
} from "./integrations/connected-accounts/from-config.js";

loadEnvFile(path.resolve(process.cwd()));

const config = loadConfig();
// Validate signing configuration before opening the database or starting workers.
const manifestSigning = await initializeManifestSigningRuntime(systemClock);
const opened = await openDatabase(config);
if(config.migrateOnStart) await migrate(opened.db);
else await assertSchemaCurrent(opened.db);

const credentialStore = createCredentialStore(config);
const objectStore = createObjectStore(config);
const webhookConfig = webhookConfigFromEnv();
const recoveryPublisher=await initializeRecoveryPublisher(config,systemClock);
const durabilityPolicy=(await opened.db.query<{durability_required:boolean}>('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
if(!durabilityPolicy||durabilityPolicy.durability_required!==(config.requireDurableReceipts===true))
  throw new Error('Runtime durability mode does not match the migration-controlled policy');

const ebayRuntime=createEbayRuntime(config,{publicBaseUrl:config.publicBaseUrl,webOrigins:config.webOrigins});
const integrations=createDefaultIntegrationRegistry(systemClock);
if(ebayRuntime.enabled) integrations.registerCommerce(createEbayCommerceAdapter(opened.db,systemClock,ebayRuntime,credentialStore));
const readinessProbes=[
  {name:'policy-recovery',check:()=>assertPolicyAccessSafe(opened.db)},
  {name:'database',check:()=>opened.db.query('SELECT 1')},
  {name:'schema',check:()=>assertSchemaCurrent(opened.db)},
  {name:'storage',check:async()=>{
    if(config.objectStore==='local')return;
    const key=process.env.PACKPROOF_READINESS_OBJECT_KEY,versionId=process.env.PACKPROOF_READINESS_OBJECT_VERSION;
    if(!key||!versionId||!objectStore.head)throw new Error('Pinned readiness sentinel is required');
    if(!await objectStore.head(key,{versionId}))throw new Error('Readiness sentinel is unavailable');
  }},
  {name:'signing-trust',required:manifestSigning.publicStatus.required,check:async()=>{
    if(!manifestSigning.publicStatus.required)return;
    const trust=manifestSigning.trustList;
    if(!manifestSigning.signer||!trust||Date.parse(trust.expiresAt)<=Date.now()||!trust.keys.some(key=>key.keyId===manifestSigning.publicStatus.keyId&&key.status==='ACTIVE'))throw new Error('Signing trust unavailable');
  }},
];
const app = config.processRole==='worker'?express():createServerApp({
  db: opened.db,
  objectStore,
  clock: systemClock,
  auth: createAuthentication(config, opened.db, systemClock),
  publicBaseUrl: config.publicBaseUrl,
  devAuth: isDevLoginEnabled(config),
  corsOrigins: config.webOrigins,
  integrations,
  credentialStore,
  webhookConfig,
  manifestSigning,
  releaseIdentity: config.release,
  requireDurableReceipts: config.requireDurableReceipts,
  readinessProbes,
  ebay: ebayRuntime,
  shopify: createShopifyRuntime(config),
  google: createGoogleRuntime(config),
  facebook: createFacebookRuntime(config),
});

if(config.processRole==='worker'){
  app.get('/live',liveness);app.get('/health',liveness);
  app.get('/ready',createReadiness(readinessProbes).handler);
}
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    `PackProof V2 API listening on ${config.port} engine=${opened.engine} objectStore=${config.objectStore} authMode=${config.authMode}`,
  );
});
const jobs:ScheduledJob[]=[];
if(webhookConfig.encryptionKey&&webhookConfig.allowedHosts.length&&process.env.PACKPROOF_WEBHOOK_WORKER!=="false")
  jobs.push({name:'webhooks',intervalMs:15000,run:()=>dispatchWebhooks(opened.db,systemClock,webhookConfig,undefined,5)});
if(process.env.PACKPROOF_COMMERCE_WORKER!=="false")jobs.push({name:'commerce',intervalMs:15000,run:()=>dispatchCommerceSyncs(opened.db,systemClock,{integrations,credentials:credentialStore})});
if(process.env.PACKPROOF_CAPTURE_SHIPMENT_WORKER!=="false")jobs.push({name:'capture-shipments',intervalMs:15000,run:()=>dispatchCaptureShipments(opened.db,systemClock,{integrations,credentials:credentialStore,defaultShippoCredentialReference:process.env.PACKPROOF_CAPTURE_SHIPPO_CREDENTIAL_REFERENCE,defaultEasyPostCredentialReference:process.env.PACKPROOF_CAPTURE_EASYPOST_CREDENTIAL_REFERENCE,manifestSigning})});
const stopWorkers=config.processRole==='api'?async()=>{}:startOperationsWorkers(opened.db,systemClock,objectStore,config,recoveryPublisher,process.env,jobs);

let shuttingDown=false;
const shutdown = async () => {
  if(shuttingDown)return;
  shuttingDown=true;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await stopWorkers();
  await opened.close();
};

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});
