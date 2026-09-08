import { assertPolicyAccessSafe } from "./domain/policy-recovery.js";
import { intakeConfigFromEnv,enrollConfiguredIntakeCohort } from './intake/runtime-config.js';
import { createIntakeMailJobs } from './intake/mail-runtime.js';
import { dispatchShippoIntake } from './intake/shippo-runtime.js';
import { StripeBillingAdapter, stripeBillingConfigFromEnv } from "./billing/stripe-adapter.js";
import {processStripeBillingReconciliation} from "./billing/daily-reconciliation.js";
import {DomainError} from "./domain/errors.js";
import {observationConfigFromEnv} from "./analytics/observation-router.js";
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
import { createEtsyCommerceAdapter } from "./integrations/etsy/commerce-adapter.js";
import { createEtsyAccessTokenRunner } from "./integrations/etsy/access.js";
import { createConnectedAccountRegistry } from "./integrations/connected-accounts/runtime.js";

import { dispatchCommerceSyncs } from "./workers/commerce-worker.js";
import { dispatchWebhooks } from "./platform/webhooks.js";
import {
  createFacebookRuntime,
  createGoogleRuntime,
  createShopifyRuntime,
  createEtsyRuntime,
} from "./integrations/connected-accounts/from-config.js";

loadEnvFile(path.resolve(process.cwd()));

const config = loadConfig();
// Validate signing configuration before opening the database or starting workers.
const manifestSigning = await initializeManifestSigningRuntime(systemClock);
const opened = await openDatabase(config);
if(config.migrateOnStart) await migrate(opened.db);
else await assertSchemaCurrent(opened.db);
const intakeConfig=intakeConfigFromEnv();
await enrollConfiguredIntakeCohort(opened.db,intakeConfig);

const credentialStore = createCredentialStore(config);
const billingConfig=stripeBillingConfigFromEnv(process.env);
const billing=billingConfig?new StripeBillingAdapter(billingConfig,credentialStore,systemClock):null;
const billingReconciliationStartAt=process.env.PACKPROOF_STRIPE_RECONCILIATION_START_AT;
if(billing){
  const start=Date.parse(billingReconciliationStartAt??'');
  if(!Number.isFinite(start)||new Date(start).toISOString()!==billingReconciliationStartAt||start%1000!==0||start>systemClock.now().getTime())
    throw new Error('Configured billing requires an explicit UTC reconciliation baseline');
}
const objectStore = createObjectStore(config);
const webhookConfig = webhookConfigFromEnv();
const recoveryPublisher=await initializeRecoveryPublisher(config,systemClock);
const durabilityPolicy=(await opened.db.query<{durability_required:boolean}>('SELECT durability_required FROM policy_recovery_fence WHERE singleton=1')).rows[0];
if(!durabilityPolicy||durabilityPolicy.durability_required!==(config.requireDurableReceipts===true))
  throw new Error('Runtime durability mode does not match the migration-controlled policy');

const ebayRuntime=createEbayRuntime(config,{publicBaseUrl:config.publicBaseUrl,webOrigins:config.webOrigins});
const etsyRuntime=createEtsyRuntime(config,credentialStore,opened.db,systemClock);
const accountRuntimes={
  ebay:ebayRuntime, etsy:etsyRuntime, shopify:createShopifyRuntime(config),
  google:createGoogleRuntime(config), facebook:createFacebookRuntime(config), credentials:credentialStore,
};
const integrations=createDefaultIntegrationRegistry(systemClock);
if(ebayRuntime.enabled) integrations.registerCommerce(createEbayCommerceAdapter(opened.db,systemClock,ebayRuntime,credentialStore));
if(etsyRuntime.enabled&&etsyRuntime.client) integrations.registerCommerce(createEtsyCommerceAdapter(etsyRuntime.client,
  createEtsyAccessTokenRunner(opened.db,systemClock,{
    registry:createConnectedAccountRegistry(accountRuntimes),credentials:credentialStore,
    packproofEnvironment:config.release.environment,
    webReturnUrl:config.webOrigins[0]?`${config.webOrigins[0].replace(/\/$/,"")}/account`:"/account",
  })));
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
    manifestSigning.readSignedTrustRegistry?.();
    const trust=manifestSigning.trustList;
    if(!manifestSigning.signer||!trust||Date.parse(trust.expiresAt)<=Date.now()||!trust.keys.some(key=>key.keyId===manifestSigning.publicStatus.keyId&&key.status==='ACTIVE'))throw new Error('Signing trust unavailable');
  }},
];
const app = config.processRole==='worker'?express():createServerApp({
  intake: intakeConfig,
  db: opened.db,
  objectStore,
  clock: systemClock,
  auth: createAuthentication(config, opened.db, systemClock),
  publicBaseUrl: config.publicBaseUrl,
  devAuth: isDevLoginEnabled(config),
  corsOrigins: config.webOrigins,
  integrations,
  credentialStore,
  billing,
  observationConfig:observationConfigFromEnv(process.env),
  webhookConfig,
  manifestSigning,
  releaseIdentity: config.release,
  requireDurableReceipts: config.requireDurableReceipts,
  readinessProbes,
  ebay: ebayRuntime,
  etsy: etsyRuntime,
  shopify: accountRuntimes.shopify,
  google: accountRuntimes.google,
  facebook: accountRuntimes.facebook,
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
const jobs:ScheduledJob[]=createIntakeMailJobs(opened.db,systemClock);
jobs.push({name:'order-shippo',intervalMs:15000,run:()=>dispatchShippoIntake(opened.db,systemClock,{credentialStore,config:()=>intakeConfigFromEnv()})});
if(billing&&billingReconciliationStartAt){
  const initialStartAt=billingReconciliationStartAt;
  jobs.push({name:'billing-reconciliation',intervalMs:30000,run:async()=>{
    const result=await processStripeBillingReconciliation(opened.db,systemClock,billing,{initialStartAt});
    const errorCode='errorCode' in result?result.errorCode:null;
    if(result.state==='BLOCKED'||errorCode)throw new DomainError(errorCode??'BILLING_RECONCILIATION_BLOCKED','Billing event coverage requires review',503);
    return result;
  }});
  if(billingConfig?.checkout)jobs.push({name:'billing-enrollment',intervalMs:60000,run:async()=>{
    const result=await billing.reconcileEnrollments(opened.db);
    if(result.errors?.length)throw new DomainError(result.errors[0].code,'Subscription enrollment reconciliation requires attention',503);
    return result;
  }});
}
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
