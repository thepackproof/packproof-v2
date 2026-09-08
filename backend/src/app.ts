import { getAccountDeletionRequest, requestAccountDeletion } from "./domain/account-deletion.js";
import { supportAccessRouter } from "./support/router.js";
import { createReadiness, liveness, type DependencyProbe } from "./operations/readiness.js";
import { getAccountUsageSummary, ingestVerifiedBillingEvent } from "./billing/usage-ledger.js";
import type { StripeBillingAdapter } from "./billing/stripe-adapter.js";
import {createObservationRouter,type ProgramObservationConfig} from "./analytics/observation-router.js";
import { appendAudit } from "./domain/audit.js";
import { pipeline } from "node:stream/promises";
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { AuthenticationAdapter } from "./auth/adapter.js";
import type { Clock } from "./clock.js";
import type { Database } from "./db/database.js";
import { createOrGetProof, createProof } from "./domain/create-proof.js";
import { requireParticipationPolicy } from "./domain/participation.js";
import { requireWorkflowType } from "./domain/workflow.js";
import { DomainError } from "./domain/errors.js";
import {
  commitEvidence,
  initializeEvidenceUpload,
  readCommittedEvidence,
  readCommittedEvidenceStream,
} from "./domain/evidence.js";
import { finalizeProof, getManifest } from "./domain/finalize.js";
import { createProofAssets, listProofAssets, updateAssetCatalog } from "./domain/assets.js";
import { bindAssetExternalRef } from "./domain/asset-bindings.js";
import {
  compareObservations,
  completeFinalReceipt,
  completePacking,
  completeReturnPacking,
  documentAssets,
  documentProcessingOutput,
  handoffAssets,
  receiveAssets,
} from "./domain/orchestration.js";
import {
  createAccessLink,
  listAccessLinks,
  revokeAccessLink,
} from "./domain/access-links.js";
import { getPublicProof } from "./domain/public-proof.js";
import { listCaptureRecipes } from "./domain/capture-recipes.js";
import {
  acceptInvitation,
  createInvitation,
  listPendingInvitations,
  searchUsersForProof,
} from "./domain/invitations.js";
import { commitAttestation } from "./domain/attestations.js";
import { createAttestationChallenge } from "./domain/attestation-authorization.js";
import { listMyProofs, queryMyProofs, parseProofListQuery } from "./domain/proof-collection.js";
import { listLinkedIdentities, unlinkIdentity } from "./domain/external-identities.js";
import { getProfile, searchUsers, updateProfile } from "./domain/profiles.js";
import { authorizeProofAccess, getProofForUser } from "./domain/proofs.js";
import {
  createTransaction,
  getTransaction,
  loadTransactionBundle,
  updateShipping,
  updateTransaction,
} from "./domain/transactions.js";
import { ensureIdentityUser } from "./domain/users.js";
import { importNormalizedTransaction } from "./domain/transaction-import.js";
import { getShipmentIntegrity } from "./domain/shipment-integrity.js";
import {
  importShipmentObservations,
  listShipmentEventsForTransaction,
  recordParticipantShipmentEvent,
  resolveTransactionIdForShipmentImport,
  sliceTimelineThrough,
} from "./domain/shipment-events.js";
import { IntegrationError, integrationTrustBoundary } from "./domain/integration-errors.js";
import {
  bindTransactionShipmentConnection,
  createIntegrationConnection,
  findOwnerConnection,
  listOwnerConnections,
  toConnectionView,
} from "./domain/integration-connections.js";
import { executeCommerceFulfillmentSync } from "./domain/commerce-fulfillment-sync.js";
import {
  countReadyFulfillmentOrders,
  listFulfillmentQueue,
  parseFulfillmentQueueFilter,
  providerDisplay,
} from "./domain/fulfillment-queue.js";
import {
  parseStationResolveRequest,
  resolvePackingStationTarget,
} from "./domain/packing-station-resolve.js";
import { loadCommerceSyncState, syncStateView } from "./domain/commerce-order-records.js";
import { normalizeExternalAccountReference } from "./domain/normalized-fulfillment-order.js";
import {
  applyDemoStorefrontScenario,
  DEMO_STORE_ACCOUNT_PRIMARY,
  DEMO_STOREFRONT_ADAPTER_KEY,
  DEMO_STOREFRONT_CREDENTIAL_REFERENCE,
  DEMO_STOREFRONT_DISPLAY_NAME,
  DEMO_STOREFRONT_PROVIDER,
  type DemoStorefrontAdapter,
} from "./integrations/demo-storefront.js";
import { executeTrustedShipmentSync } from "./domain/trusted-shipment-sync.js";
import { ingestTrustedShipmentWebhook } from "./domain/trusted-shipment-webhook.js";
import type { ObjectStore } from "./s3/object-store.js";
import type { IntegrationAdapterRegistry } from "./integrations/registry.js";
import { createDefaultIntegrationRegistry } from "./integrations/registry.js";
import { parseIntegrationImportRequest } from "./integrations/import-request.js";
import { parseShipmentImportRequest } from "./integrations/shipment-import-request.js";
import type {
  IntegrationCredentialStore,
  IntegrationCredentials,
} from "./integrations/credentials.js";
import { parseReleaseIdentity, type ReleaseIdentity } from "./config.js";
import { disabledEbayRuntime } from "./integrations/ebay/runtime.js";
import {
  completeEbayOAuth,
  disconnectEbay,
  ebayChallengeResponse,
  getEbayMarketplaceStatus,
  handleEbayAccountDeletion,
  importEbaySellerOrder,
  listEbaySellerOrders,
  startEbayConnect,
  type EbayRuntime,
} from "./domain/ebay-marketplace.js";
import { MemoryCredentialStore } from "./integrations/memory-credential-store.js";
import {
  TRUSTED_DEMO_API_KEY,
  TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
  TRUSTED_DEMO_CARRIER_PROVIDER,
  TRUSTED_DEMO_WEBHOOK_SECRET,
} from "./integrations/trusted-demo-carrier.js";
import {
  EASYPOST_TRACKER_ADAPTER_KEY,
  easypostCredentialReferenceAllowed,
} from "./integrations/easypost/adapter.js";
import { EASYPOST_PROVIDER } from "./integrations/easypost/normalize.js";
import {
  completeConnectedAccountOAuth,
  disconnectConnectedAccount,
  handleShopifyAppUninstalled,
  listConnectedAccounts,
  reauthorizeConnectedAccount,
  startConnectedAccountConnect,
  type ConnectedAccountService,
} from "./domain/connected-accounts.js";
import { createConnectedAccountRegistry } from "./integrations/connected-accounts/runtime.js";
import {
  disabledShopifyRuntime,
  type ShopifyOAuthRuntime,
} from "./integrations/connected-accounts/providers/shopify.js";
import {
  disabledGoogleRuntime,
  type GoogleOAuthRuntime,
} from "./integrations/connected-accounts/providers/google.js";
import {
  disabledFacebookRuntime,
  type FacebookOAuthRuntime,
} from "./integrations/connected-accounts/providers/facebook.js";
import { parseAppClientSecret } from "./integrations/connected-accounts/app-secret.js";
import { verifyShopifyWebhookHmac } from "./integrations/shopify/hmac.js";
import { createPlatformRouter, createTenantManagementRouter } from "./platform/router.js";
import type { WebhookConfig } from "./platform/webhooks.js";
import { previewOrderIntake } from "./intake/order-intake.js";
import { intakeRouter } from "./http/intake-router.js";
import type { IntakeRuntimeConfig } from "./intake/runtime-config.js";
import { exportEvidencePackageStream, getEvidenceReview } from "./domain/evidence-review.js";
import {
  listUploadParts,
  completeUploadParts,
  discardPendingUpload,
} from "./domain/resumable-upload.js";
import { commerceLifecycleRouter } from "./http/commerce-lifecycle-router.js";
import { httpBoundary, requestBodyErrors, requestCorrelation, configureTrustedProxy, distributedRateLimit, safeHttpError } from "./http/boundary.js";
import { captureSessionRouter, packingRelayRouter } from "./http/capture-router.js";
import { signatureRouter } from "./http/signature-router.js";
import { disclosureRouter, sendPrivateMedia } from "./http/disclosure-router.js";
import { exportDisclosurePackageStream } from "./domain/disclosure-package.js";
import { setCommerceAutomation, commerceOrderPolicy, getCommerceReviewSummary, enqueueCommerceWebhook, getCommerceOrderContext } from "./domain/commerce-automation.js";
import { createEbayCommerceAdapter } from "./integrations/ebay/adapter.js";
import { disabledEtsyRuntime, type EtsyRuntime } from "./integrations/etsy/runtime.js";
import { createEtsyCommerceAdapter } from "./integrations/etsy/commerce-adapter.js";
import { createEtsyAccessTokenRunner } from "./integrations/etsy/access.js";
import { normalizeShopifyShop, shopifyShopHandle } from "./integrations/shopify/shop.js";
import {
  getRetentionControls,
  createRetentionHold,
  releaseRetentionHold,
  requestProofDeletion,
} from "./domain/retention-controls.js";

import type { ManifestSigningRuntime } from "./integrity/signing-runtime.js";
import { captureCapabilities } from "./http/capabilities.js";
import { getProofRecoveryStatus } from "./domain/recovery-journal.js";
import { receiveAdmittedUpload } from "./domain/media-admission.js";
import { readDisclosedMediaStream } from "./domain/disclosure-stream.js";
import { receiveAdmittedUploadPart } from "./domain/resumable-upload.js";
import { packingRequestsRouter, parcelScopeRouter } from "./http/packing-requests-router.js";
import { recipientExportsRouter } from "./http/recipient-exports-router.js";
import { appendProofSupplement, getProofSupplementSnapshot } from "./domain/proof-supplements.js";
import { requireCommerceAccess } from "./domain/commerce-lifecycle.js";

export interface AppDependencies {
  intake?: IntakeRuntimeConfig;
  db: Database;
  objectStore: ObjectStore;
  clock: Clock;
  auth: AuthenticationAdapter;
  publicBaseUrl: string;
  devAuth: boolean;
  corsOrigins?: string[];
  integrations?: IntegrationAdapterRegistry;
  credentialStore?: IntegrationCredentialStore & {
    put?: (credentials: IntegrationCredentials) => void;
  };
  releaseIdentity?: ReleaseIdentity;
  ebay?: EbayRuntime;
  shopify?: ShopifyOAuthRuntime;
  etsy?: EtsyRuntime;
  google?: GoogleOAuthRuntime;
  facebook?: FacebookOAuthRuntime;
  webhookConfig?: WebhookConfig;
  manifestSigning?: ManifestSigningRuntime;
  requireDurableReceipts?: boolean;
  readinessProbes?: DependencyProbe[];
  billing?: StripeBillingAdapter | null;
  observationConfig?: ProgramObservationConfig | null;
}

function asyncRoute(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void fn(req, res).catch(next);
  };
}

function bearerUser(req: Request): string {
  const userId = req.packproofUserId;
  if (!userId) {
    throw new DomainError("UNAUTHENTICATED", "Missing bearer token", 401);
  }
  return userId;
}

declare global {
  namespace Express {
    interface Request {
      packproofUserId?: string;
    }
  }
}

export function createApp(deps: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  configureTrustedProxy(app);
  app.use(requestCorrelation);
  app.use("/public",distributedRateLimit(deps.db,{scope:"public-proof",limit:120,windowMs:60_000}));
  const corsOrigins = deps.corsOrigins ?? [];
  const integrations = deps.integrations ?? createDefaultIntegrationRegistry(deps.clock);
  const credentialStore = deps.credentialStore ?? new MemoryCredentialStore();
  const releaseIdentity = deps.releaseIdentity ?? parseReleaseIdentity();
  const ebay = deps.ebay ?? disabledEbayRuntime();
  if (ebay.enabled) integrations.registerCommerce(createEbayCommerceAdapter(deps.db, deps.clock, ebay, credentialStore));
  const shopify = deps.shopify ?? disabledShopifyRuntime();
  const etsy = deps.etsy ?? disabledEtsyRuntime();
  const google = deps.google ?? disabledGoogleRuntime();
  const facebook = deps.facebook ?? disabledFacebookRuntime();
  const connectedAccounts: ConnectedAccountService = {
    registry: createConnectedAccountRegistry({
      ebay,
      shopify,
      etsy,
      google,
      facebook,
      credentials: credentialStore,
    }),
    credentials: credentialStore,
    packproofEnvironment: releaseIdentity.environment,
    webReturnUrl: corsOrigins[0] ? `${corsOrigins[0].replace(/\/$/, "")}/account` : "/account",
  };
  if (etsy.enabled && etsy.client) {
    integrations.registerCommerce(createEtsyCommerceAdapter(etsy.client,
      createEtsyAccessTokenRunner(deps.db, deps.clock, connectedAccounts)));
  }
  app.use(httpBoundary(corsOrigins));
  // Admission must happen before a body parser can buffer or accept upload bytes.
  app.put("/upload/:token", asyncRoute(async (req, res) => {
    const result = await receiveAdmittedUpload(deps.db, deps.clock, deps.objectStore, req.params.token, req);
    res.json({objectKey:result.key,evidenceId:result.evidenceId});
  }));
  app.put("/proofs/:id/evidence/:evidenceId/parts/:partNumber", asyncRoute(async (req, res) => {
    const actor = await deps.auth.authenticate(req.headers);
    req.packproofUserId = actor.userId;
    res.json(await receiveAdmittedUploadPart(deps.db, deps.clock, deps.objectStore, actor.userId,
      req.params.id, req.params.evidenceId, Number(req.params.partNumber), req));
  }));
  app.post("/billing/webhooks/stripe", distributedRateLimit(deps.db,{scope:"billing-webhook",limit:120,windowMs:60_000}), express.raw({type:()=>true,limit:"1mb"}), asyncRoute(async(req,res)=>{
    if(!deps.billing)throw new DomainError("BILLING_DISABLED","Billing is not configured",404);
    res.json(await ingestVerifiedBillingEvent(deps.db,deps.clock,deps.billing,{rawBody:req.body,signature:req.get("Stripe-Signature")??null}));
  }));
  app.use("/integrations/webhooks", express.raw({ type: () => true, limit: "256kb" }));
  app.use((req, res, next) => {
    if (Buffer.isBuffer(req.body) || (req.method === "PUT" && /^\/v1\/proofs\/[^/]+\/evidence\/[^/]+\/parts\/[^/]+$/.test(req.path))) {
      next();
      return;
    }
    express.json({ limit: "2mb" })(req, res, next);
  });
  app.use((req,res,next) => {
    if (req.method === "PUT" && /^\/v1\/proofs\/[^/]+\/evidence\/[^/]+\/parts\/[^/]+$/.test(req.path)) { next(); return; }
    express.raw({type:["application/octet-stream","video/*","image/*","audio/*"],limit:"100mb"})(req,res,next);
  });

  app.get("/live", liveness);
  app.get("/ready", createReadiness(deps.readinessProbes ?? [{name:"database",check:()=>deps.db.query("SELECT 1")}]).handler);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/capabilities", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(captureCapabilities(releaseIdentity, deps.requireDurableReceipts === true));
  });

  app.get(
    "/public/proofs/:token",
    asyncRoute(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      const result = await getPublicProof(deps.db, deps.clock, req.params.token);
      res.json(result);
    }),
  );

  app.get(
    "/public/proofs/:token/evidence/:evidenceId",
    asyncRoute(async (req, res) => {
      const media = await readDisclosedMediaStream(
        deps.db,
        deps.clock,
        deps.objectStore,
        req.params.token,
        req.params.evidenceId,
        req.header("range"),
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.status(media.status).set(media.headers);
      if (media.body) await pipeline(media.body,res); else res.end();
    }),
  );

  app.get("/public/proofs/:token/package", asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    const archive = await exportDisclosurePackageStream(deps.db, deps.clock, deps.objectStore, req.params.token);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", 'attachment; filename="proof-view.zip"');
    res.type("application/zip");
    await pipeline(archive,res);
  }));

  app.get("/.well-known/packproof-trust-registry.json", (_req,res)=>{
    res.setHeader("Cache-Control","no-store");
    res.setHeader("X-Content-Type-Options","nosniff");
    const registry=deps.manifestSigning?.readSignedTrustRegistry?.() ?? deps.manifestSigning?.signedTrustRegistryJson;
    if(!registry) {
      res.status(503).json({error:{code:"SIGNED_TRUST_REGISTRY_UNAVAILABLE",message:"The signed trust registry is not configured"}}); return;
    }
    res.type("application/json").send(registry);
  });

  app.get("/.well-known/packproof-trust.json", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    deps.manifestSigning?.readSignedTrustRegistry?.();
    if (!deps.manifestSigning?.trustList) {
      res.status(503).json({ error: { code: "MANIFEST_TRUST_NOT_CONFIGURED", message: "An authenticated public trust list has not been configured" } });
      return;
    }
    res.json(deps.manifestSigning.trustList);
  });
  app.get("/integrity/signing", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    deps.manifestSigning?.readSignedTrustRegistry?.();
    res.json(deps.manifestSigning?.publicStatus ?? { mode: "UNSIGNED", algorithm: null, keyId: null, required: false, trustListSha256: null });
  });

  app.get("/meta", (_req, res) => {
    res.json({
      service: releaseIdentity.service,
      environment: releaseIdentity.environment,
      commit: releaseIdentity.commit,
      version: releaseIdentity.version,
      image: releaseIdentity.image,
    });
  });

  if (deps.devAuth) {
    app.post(
      "/auth/dev/login",
      asyncRoute(async (req, res) => {
        const subject = String(req.body?.subject ?? "").trim();
        if (!subject) {
          throw new DomainError("INVALID_SUBJECT", "subject is required", 400);
        }
        const userId = await ensureIdentityUser(deps.db, deps.clock, "dev", subject);
        res.json({ userId, token: userId });
      }),
    );
  }

  app.use("/v1", createPlatformRouter(deps));

  app.use((req, _res, next) => {
    if (
      req.path === "/health" ||
      req.path === "/meta" ||
      req.path.startsWith("/auth/") ||
      req.path.startsWith("/upload/") ||
      req.path.startsWith("/public/") ||
      req.path.startsWith("/integrations/webhooks/") ||
      req.path.startsWith("/integrations/oauth/") ||
      req.path.startsWith("/oauth/")
    ) {
      next();
      return;
    }
    deps.auth
      .authenticate(req.headers)
      .then((auth) => {
        req.packproofUserId = auth.userId;
        next();
      })
      .catch(next);
  });

  app.get("/me/account-deletion-request", asyncRoute(async(req,res)=>{
    res.json(await getAccountDeletionRequest(deps.db,bearerUser(req)));
  }));
  app.post("/me/account-deletion-request", asyncRoute(async(req,res)=>{
    res.status(202).json(await requestAccountDeletion(deps.db,deps.clock,bearerUser(req),req.body));
  }));
  app.use("/internal/support", supportAccessRouter(deps));
  app.use("/study",distributedRateLimit(deps.db,{scope:"study-observation",limit:120,windowMs:60_000,subject:bearerUser}),createObservationRouter(deps,deps.observationConfig??null));
  app.use("/me/billing",distributedRateLimit(deps.db,{scope:"account-billing",limit:30,windowMs:60_000,subject:bearerUser}));
  app.get("/me/billing/status",asyncRoute(async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    res.json(deps.billing?await deps.billing.getOwnBillingStatus(deps.db,bearerUser(req)):{enabled:false,subscriptions:[],pendingCheckout:null});
  }));
  app.get("/me/billing/offer",asyncRoute(async(_req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    res.json(deps.billing?await deps.billing.listApprovedCheckoutOffer(deps.db):{enabled:false,offer:null});
  }));
  app.post("/me/billing/checkout",asyncRoute(async(req,res)=>{
    if(!deps.billing)throw new DomainError("BILLING_DISABLED","Billing is not configured",404);
    const body=req.body;
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>!["operationId","offerVersion","acceptedOfferSha256"].includes(key))||[body.operationId,body.offerVersion,body.acceptedOfferSha256].some(value=>typeof value!=="string"))
      throw new DomainError("INVALID_BILLING_INPUT","An exact accepted offer and stable checkout operation ID are required",400);
    res.setHeader("Cache-Control","private, no-store");
    res.json(await deps.billing.createOwnCheckout(deps.db,bearerUser(req),body));
  }));
  app.post("/me/billing/checkout/complete",asyncRoute(async(req,res)=>{
    if(!deps.billing)throw new DomainError("BILLING_DISABLED","Billing is not configured",404);
    const body=req.body;
    if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).some(key=>key!=="operationId")||typeof body.operationId!=="string")
      throw new DomainError("INVALID_BILLING_INPUT","A checkout operation ID is required",400);
    res.setHeader("Cache-Control","private, no-store");
    res.json(await deps.billing.completeOwnCheckout(deps.db,bearerUser(req),body));
  }));
  app.get("/me/billing/invoices", asyncRoute(async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    if(!deps.billing){res.json({enabled:false,invoices:[]});return;}
    const customerReference=req.query.customerReference,startingAfter=req.query.startingAfter;
    if((customerReference!==undefined&&typeof customerReference!=="string")||(startingAfter!==undefined&&typeof startingAfter!=="string"))throw new DomainError("INVALID_BILLING_REFERENCE","Billing references must be strings",400);
    res.json({enabled:true,...await deps.billing.listOwnInvoices(deps.db,bearerUser(req),{customerReference,startingAfter})});
  }));
  app.post("/me/billing/cancellation-portal", asyncRoute(async(req,res)=>{
    if(!deps.billing)throw new DomainError("BILLING_DISABLED","Billing is not configured",404);
    const {customerReference,subscriptionReference,operationId}=req.body??{};
    if((customerReference!==undefined&&typeof customerReference!=="string")||typeof subscriptionReference!=="string"||typeof operationId!=="string")throw new DomainError("INVALID_BILLING_REFERENCE","A subscription reference and stable operation ID are required",400);
    res.setHeader("Cache-Control","private, no-store");
    res.json(await deps.billing.createOwnCancellationPortal(deps.db,bearerUser(req),{customerReference,subscriptionReference,operationId}));
  }));
  app.use("/me/tenants", createTenantManagementRouter(deps));
  app.use("/proofs/:id/lifecycle", commerceLifecycleRouter(deps));
  app.use("/proofs/:id/capture-sessions", captureSessionRouter(deps));
  app.use("/me/packing-relay", packingRelayRouter(deps));
  app.use((req,res,next)=>{
    const isProofAdmission=req.path==='/proofs'||/^\/transactions\/[^/]+\/proof$/.test(req.path);
    // A transaction alone has no workflow policy; negotiate only when a new merchant Proof is requested.
    const isAdmission=req.method==='POST'&&(isProofAdmission||(req.path==='/integrations/transactions/import'&&req.body?.createProof===true));
    const preservedWorkflow=isProofAdmission&&(req.body?.workflowType==='GRADING_SUBMISSION'||req.body?.participationPolicy==='COUNTERPARTY_REQUIRED');
    if(!isAdmission||preservedWorkflow||req.header('x-packproof-intake-version')==='1')return next();
    void (async()=>{
      const user=bearerUser(req);
      const enrolled=(await deps.db.query('SELECT owner_user_id FROM intake_contract_cohorts WHERE owner_user_id=$1 AND enabled=true',[user])).rows[0];
      if(!enrolled)return next();
      const match=req.path.match(/^\/transactions\/([^/]+)\/proof$/);
      if(match && (await deps.db.query('SELECT id FROM proofs WHERE transaction_id=$1',[match[1]])).rows[0])return next();
      throw new DomainError('INTAKE_CLIENT_UPDATE_REQUIRED','Update PackProof before preparing a new order. Your existing recordings can still be recovered.',409);
    })().catch(next);
  });
  app.use("/me/intake", distributedRateLimit(deps.db,{scope:"order-intake",limit:90,windowMs:60_000,subject:bearerUser}), intakeRouter(deps));
  app.use("/proofs/:id/signature", signatureRouter(deps));
  app.use("/proofs/:id/disclosure", disclosureRouter(deps));
  app.use("/packing-requests", packingRequestsRouter(deps));
  app.use("/proofs/:id/parcel-scope", parcelScopeRouter(deps));
  app.use("/proofs/:id/recipient-exports", recipientExportsRouter(deps));
  app.get("/proofs/:id/supplements", asyncRoute(async (req,res)=>{
    await requireCommerceAccess(deps.db,req.params.id,bearerUser(req));
    res.setHeader("Cache-Control","private, no-store");
    res.json(await getProofSupplementSnapshot(deps.db,req.params.id));
  }));
  app.post("/proofs/:id/supplements", asyncRoute(async (req,res)=>{
    if (!deps.manifestSigning?.signer) throw new DomainError("MANIFEST_SIGNING_UNAVAILABLE","Signing is temporarily unavailable. Retry shortly.",503);
    res.status(201).json(await appendProofSupplement(deps.db,deps.clock,deps.manifestSigning.signer,bearerUser(req),req.params.id,req.body));
  }));
  app.get("/me/usage", asyncRoute(async (req,res) => { res.setHeader("Cache-Control","private, no-store"); res.json(await getAccountUsageSummary(deps.db,deps.clock,bearerUser(req))); }));

  app.get("/proofs/:id/recovery", asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await getProofRecoveryStatus(deps.db, bearerUser(req), req.params.id));
  }));
  app.get(
    "/proofs/:id/retention",
    asyncRoute(async (req, res) => {
      res.json(await getRetentionControls(deps.db, deps.clock, bearerUser(req), req.params.id));
    }),
  );
  app.post(
    "/proofs/:id/retention/holds",
    asyncRoute(async (req, res) => {
      res
        .status(201)
        .json(
          await createRetentionHold(
            deps.db,
            deps.clock,
            bearerUser(req),
            req.params.id,
            req.body?.reason,
          ),
        );
    }),
  );
  app.delete(
    "/proofs/:id/retention/holds/:holdId",
    asyncRoute(async (req, res) => {
      res.json(
        await releaseRetentionHold(
          deps.db,
          deps.clock,
          bearerUser(req),
          req.params.id,
          req.params.holdId,
        ),
      );
    }),
  );
  app.post(
    "/proofs/:id/retention/deletion-requests",
    asyncRoute(async (req, res) => {
      res
        .status(201)
        .json(
          await requestProofDeletion(
            deps.db,
            deps.clock,
            bearerUser(req),
            req.params.id,
            req.body?.reason,
          ),
        );
    }),
  );
  app.get(
    "/me/receipt-invitations",
    asyncRoute(async (req, res) => {
      res.json({
        invitations: (
          await deps.db.query(
            `SELECT r.proof_id AS "proofId",r.created_at AS "createdAt",r.accepted_at AS "acceptedAt",t.item_title AS "itemTitle" FROM commerce_receivers r
      JOIN proofs p ON p.id=r.proof_id JOIN transactions t ON t.id=p.transaction_id WHERE r.user_id=$1 ORDER BY r.created_at DESC LIMIT 100`,
            [bearerUser(req)],
          )
        ).rows,
      });
    }),
  );
  app.post(
    "/order-intake/preview",
    asyncRoute(async (req, res) => {
      bearerUser(req);
      res.setHeader("Cache-Control", "no-store");
      res.json(previewOrderIntake(req.body));
    }),
  );
  app.get(
    "/proofs/:id/review",
    asyncRoute(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.json(await getEvidenceReview(deps.db, deps.clock, bearerUser(req), req.params.id));
    }),
  );
  app.get(
    "/proofs/:id/evidence/:evidenceId/parts",
    asyncRoute(async (req, res) => {
      res.json(
        await listUploadParts(deps.db, bearerUser(req), req.params.id, req.params.evidenceId),
      );
    }),
  );
  app.post(
    "/proofs/:id/evidence/discard",
    asyncRoute(async (req, res) => {
      res.json(
        await discardPendingUpload(
          deps.db,
          deps.clock,
          bearerUser(req),
          req.params.id,
          req.body?.idempotencyKey,
        ),
      );
    }),
  );
  app.post(
    "/proofs/:id/evidence/:evidenceId/parts/complete",
    asyncRoute(async (req, res) => {
      res.json(
        await completeUploadParts(
          deps.db,
          deps.objectStore,
          bearerUser(req),
          req.params.id,
          req.params.evidenceId,
          req.body?.totalBytes,
        ),
      );
    }),
  );
  app.get(
    "/proofs/:id/package",
    asyncRoute(async (req, res) => {
      const archive = await exportEvidencePackageStream(
        deps.db,
        deps.clock,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
      );
      res.setHeader("Content-Disposition", `attachment; filename="${req.params.id.replace(/[^A-Za-z0-9_-]/g, "")}.zip"`);
      res.setHeader("Cache-Control", "no-store");
      res.type("application/zip");
      await pipeline(archive,res);
    }),
  );

  app.get(
    "/integrations/oauth/ebay/callback",
    asyncRoute(async (req, res) => {
      const result = await completeEbayOAuth(deps.db, deps.clock, ebay, credentialStore, {
        code: req.query.code,
        state: req.query.state,
        error: req.query.error,
      });
      res.redirect(302, result.redirectTo);
    }),
  );

  app.get(
    "/oauth/:provider/callback",
    asyncRoute(async (req, res) => {
      if (req.params.provider === "ebay") {
        const result = await completeEbayOAuth(deps.db, deps.clock, ebay, credentialStore, {
          code: req.query.code,
          state: req.query.state,
          error: req.query.error,
        });
        res.redirect(302, result.redirectTo);
        return;
      }
      const result = await completeConnectedAccountOAuth(
        deps.db,
        deps.clock,
        connectedAccounts,
        req.params.provider,
        req.query,
      );
      res.redirect(302, result.redirectTo);
    }),
  );

  app.post(
    "/integrations/webhooks/shopify",
    asyncRoute(async (req, res) => {
      if (!shopify.enabled || !shopify.appCredentialReference) {
        throw new DomainError("CONNECTED_ACCOUNT_PROVIDER_DISABLED", "Shopify is not enabled", 403);
      }
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body ?? ""), "utf8");
      const secret = parseAppClientSecret(
        await credentialStore.getCredentials({
          adapterKey: "shopify",
          credentialReference: shopify.appCredentialReference,
        }),
      );
      verifyShopifyWebhookHmac({
        secret,
        rawBody,
        header: req.header("X-Shopify-Hmac-Sha256"),
      });
      const topic = String(req.header("X-Shopify-Topic") ?? "").toLowerCase();
      if (["orders/create", "orders/updated", "orders/cancelled", "orders/paid", "fulfillments/create", "fulfillments/update"].includes(topic)) {
        const result = await enqueueCommerceWebhook(deps.db, deps.clock, {
          provider: "shopify",
          externalAccountReference: shopifyShopHandle(normalizeShopifyShop(req.header("X-Shopify-Shop-Domain"))),
          deliveryId: String(req.header("X-Shopify-Webhook-Id") ?? ""), topic,
        });
        res.status(200).json(result);
        return;
      }
      if (topic !== "app/uninstalled") {
        res.status(200).json({ accepted: true });
        return;
      }
      const shop = String(req.header("X-Shopify-Shop-Domain") ?? "");
      const result = await handleShopifyAppUninstalled(
        deps.db,
        deps.clock,
        shop,
        connectedAccounts,
      );
      res.status(200).json(result);
    }),
  );

  app.get(
    "/integrations/webhooks/ebay/account-deletion",
    asyncRoute(async (req, res) => {
      const result = ebayChallengeResponse(ebay, req.query);
      res.json(result);
    }),
  );

  app.post(
    "/integrations/webhooks/ebay/account-deletion",
    asyncRoute(async (req, res) => {
      let payload: unknown = req.body;
      if (Buffer.isBuffer(req.body)) {
        try {
          payload = JSON.parse(req.body.toString("utf8") || "{}");
        } catch {
          throw new DomainError("INVALID_WEBHOOK", "eBay deletion notification is invalid", 400);
        }
      }
      const result = await handleEbayAccountDeletion(deps.db, deps.clock, payload, credentialStore);
      res.status(200).json(result);
    }),
  );

  app.get("/transactions/:id/commerce-context", asyncRoute(async (req, res) => {
    res.json(await getCommerceOrderContext(deps.db, bearerUser(req), req.params.id));
  }));

  app.post(
    "/transactions",
    asyncRoute(async (req, res) => {
      const result = await createTransaction(deps.db, deps.clock, bearerUser(req), req.body);
      res.status(201).json(result);
    }),
  );

  app.post(
    "/integrations/transactions/import",
    asyncRoute(async (req, res) => {
      const parsed = parseIntegrationImportRequest(req.body);
      const adapter = integrations.get(parsed.adapterKey);
      if (adapter.kind !== "reference") {
        throw new DomainError(
          "INTEGRATION_TRUST_BOUNDARY",
          "This route accepts reference adapters only",
          403,
        );
      }
      const imported = await adapter.fetchPurchase({
        externalTransactionId: parsed.externalTransactionId,
      });
      const result = await importNormalizedTransaction(
        deps.db,
        deps.clock,
        bearerUser(req),
        imported,
        {
          createProof: parsed.createProof,
          adapterKey: adapter.adapterKey,
        },
      );
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.post(
    "/integrations/shipment-events/import",
    asyncRoute(async (req, res) => {
      const parsed = parseShipmentImportRequest(req.body);
      const adapter = integrations.getShipment(parsed.adapterKey);
      if (adapter.kind !== "reference") {
        throw new DomainError(
          "INTEGRATION_TRUST_BOUNDARY",
          "This route accepts reference adapters only",
          403,
        );
      }
      const actor = bearerUser(req);
      const transactionId = await resolveTransactionIdForShipmentImport(deps.db, actor, {
        transactionId: parsed.transactionId,
        externalTransactionId: parsed.externalTransactionId,
      });
      const bundle = await loadTransactionBundle(deps.db, transactionId);
      const observations = await adapter.fetchShipmentEvents({
        transactionId,
        trackingNumber: bundle?.shipping?.tracking_number ?? null,
        externalTransactionId: parsed.externalTransactionId,
        throughEventType: parsed.throughEventType,
      });
      const sliced = sliceTimelineThrough(observations, parsed.throughEventType);
      const result = await importShipmentObservations(
        deps.db,
        deps.clock,
        actor,
        transactionId,
        sliced,
      );
      res.status(result.createdCount > 0 ? 201 : 200).json(result);
    }),
  );

  app.post(
    "/integrations/webhooks/:adapterKey",
    asyncRoute(async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : "");
      const result = await ingestTrustedShipmentWebhook(
        deps.db,
        deps.clock,
        req.params.adapterKey,
        req.headers,
        rawBody,
        { integrations, credentials: credentialStore, manifestSigning: deps.manifestSigning },
      );
      await deps.db.query(`UPDATE capture_shipment_jobs SET state='REGISTERED',attempts=0,last_error_code=NULL,carrier=$2,provider_mode=$3,registered_at=COALESCE(registered_at,$4),updated_at=$4,next_run_at=$5 WHERE transaction_id=$1`,[req.params.id,result.carrier??null,result.mode??null,deps.clock.now().toISOString(),new Date(deps.clock.now().getTime()+6*3600000).toISOString()]);
      res.status(result.createdCount > 0 ? 201 : 200).json(publicSyncResult(result));
    }),
  );

  app.post(
    "/transactions/:id/shipment-sync",
    asyncRoute(async (req, res) => {
      parseShipmentSyncRequest(req.body);
      const result = await executeTrustedShipmentSync(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        { integrations, credentials: credentialStore, manifestSigning: deps.manifestSigning },
      );
      res.status(result.createdCount > 0 ? 201 : 200).json(publicSyncResult(result));
    }),
  );

  if (deps.devAuth) {
    app.post(
      "/dev/integrations/trusted-demo/connect",
      asyncRoute(async (req, res) => {
        const actor = bearerUser(req);
        const transactionId = String(req.body?.transactionId ?? "").trim();
        if (!transactionId) {
          throw new DomainError("INVALID_SHIPMENT_EVENT", "transactionId is required", 400);
        }
        if (typeof credentialStore.put !== "function") {
          throw new DomainError(
            "INTEGRATION_CREDENTIALS_UNAVAILABLE",
            "Trusted integration credentials are unavailable",
            503,
          );
        }
        const credentialReference = `memory:trusted-demo:${actor}:${transactionId}`;
        await credentialStore.put({
          adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
          credentialReference,
          material: {
            apiKey: TRUSTED_DEMO_API_KEY,
            webhookSecret: TRUSTED_DEMO_WEBHOOK_SECRET,
          },
        });
        const connection = await createIntegrationConnection(deps.db, deps.clock, actor, {
          adapterKey: TRUSTED_DEMO_CARRIER_ADAPTER_KEY,
          provider: TRUSTED_DEMO_CARRIER_PROVIDER,
          credentialReference,
        });
        const shipmentSync = await bindTransactionShipmentConnection(
          deps.db,
          deps.clock,
          actor,
          transactionId,
          connection.connectionId,
        );
        res.status(201).json({ connection, shipmentSync });
      }),
    );
    app.post(
      "/dev/integrations/demo-storefront/connect",
      asyncRoute(async (req, res) => {
        const actor = bearerUser(req);
        const body =
          req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        if (
          body.orders != null ||
          body.payload != null ||
          body.source != null ||
          body.provider != null ||
          body.credentials != null
        ) {
          throw integrationTrustBoundary(
            "Commerce connections do not accept client-supplied storefront payloads",
          );
        }
        const account =
          body.externalAccountReference == null || body.externalAccountReference === ""
            ? DEMO_STORE_ACCOUNT_PRIMARY
            : normalizeExternalAccountReference(body.externalAccountReference);
        const existing = await findOwnerConnection(
          deps.db,
          actor,
          DEMO_STOREFRONT_ADAPTER_KEY,
          account,
        );
        const connection = existing
          ? toConnectionView(existing)
          : await createIntegrationConnection(deps.db, deps.clock, actor, {
              adapterKey: DEMO_STOREFRONT_ADAPTER_KEY,
              provider: DEMO_STOREFRONT_PROVIDER,
              credentialReference: DEMO_STOREFRONT_CREDENTIAL_REFERENCE,
              externalAccountReference: account,
            });
        res.status(existing ? 200 : 201).json({
          connection: {
            connectionId: connection.connectionId,
            adapterKey: connection.adapterKey,
            provider: connection.provider,
            providerDisplay: DEMO_STOREFRONT_DISPLAY_NAME,
            externalAccountReference: connection.externalAccountReference,
            status: connection.status,
          },
        });
      }),
    );
    app.post(
      "/dev/integrations/demo-storefront/simulate",
      asyncRoute(async (req, res) => {
        bearerUser(req);
        const adapter = integrations.getCommerce(
          DEMO_STOREFRONT_ADAPTER_KEY,
        ) as DemoStorefrontAdapter;
        const body =
          req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        const applied = applyDemoStorefrontScenario(adapter, {
          scenario: typeof body.scenario === "string" ? body.scenario : undefined,
          externalAccountReference:
            typeof body.externalAccountReference === "string"
              ? body.externalAccountReference
              : undefined,
          externalOrderId:
            typeof body.externalOrderId === "string" ? body.externalOrderId : undefined,
          paymentState:
            typeof body.paymentState === "string" ? (body.paymentState as "CONFIRMED") : undefined,
          fulfillmentState:
            typeof body.fulfillmentState === "string"
              ? (body.fulfillmentState as "CANCELLED")
              : undefined,
          cancelled: typeof body.cancelled === "boolean" ? body.cancelled : undefined,
        });
        res.json({ applied });
      }),
    );
    app.post(
      "/dev/integrations/easypost/connect",
      asyncRoute(async (req, res) => {
        const actor = bearerUser(req);
        const body =
          req.body != null && typeof req.body === "object" && !Array.isArray(req.body)
            ? (req.body as Record<string, unknown>)
            : {};
        if (body.apiKey != null || body.webhookSecret != null || body.credentials != null) {
          throw integrationTrustBoundary("EasyPost credentials cannot be supplied by the client");
        }
        const transactionId = String(body.transactionId ?? "").trim();
        const credentialReference = String(body.credentialReference ?? "").trim();
        if (!transactionId) {
          throw new DomainError("INVALID_SHIPMENT_EVENT", "transactionId is required", 400);
        }
        if (!credentialReference || !easypostCredentialReferenceAllowed(credentialReference)) {
          throw new DomainError(
            "INVALID_SHIPMENT_EVENT",
            "credentialReference must be an env, memory, or Secrets Manager reference",
            400,
          );
        }
        const connection = await createIntegrationConnection(deps.db, deps.clock, actor, {
          adapterKey: EASYPOST_TRACKER_ADAPTER_KEY,
          provider: EASYPOST_PROVIDER,
          credentialReference,
        });
        const shipmentSync = await bindTransactionShipmentConnection(
          deps.db,
          deps.clock,
          actor,
          transactionId,
          connection.connectionId,
        );
        res.status(201).json({ connection, shipmentSync });
      }),
    );
  }

  app.get(
    "/transactions/:id",
    asyncRoute(async (req, res) => {
      const result = await getTransaction(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  app.get(
    "/transactions/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const transaction = await getTransaction(deps.db, bearerUser(req), req.params.id);
      const events = await listShipmentEventsForTransaction(deps.db, transaction.transactionId);
      res.json({
        transactionId: transaction.transactionId,
        proofId: transaction.proofId,
        identity: transaction.shipping,
        events,
      });
    }),
  );

  app.post(
    "/transactions/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const result = await recordParticipantShipmentEvent(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.patch(
    "/transactions/:id/shipping",
    asyncRoute(async (req, res) => {
      const result = await updateShipping(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.json(result);
    }),
  );

  app.patch(
    "/transactions/:id",
    asyncRoute(async (req, res) => {
      const result = await updateTransaction(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body,
      );
      res.json(result);
    }),
  );

  app.post(
    "/transactions/:id/proof",
    asyncRoute(async (req, res) => {
      const result = await createOrGetProof(deps.db, deps.clock, bearerUser(req), req.params.id, {
        participationPolicy: requireParticipationPolicy(req.body?.participationPolicy),
        workflowType: requireWorkflowType(req.body?.workflowType),
        assetCount:
          req.body?.itemCount == null || req.body?.itemCount === ""
            ? undefined
            : Number(req.body.itemCount),
      });
      res.json(result);
    }),
  );

  app.post(
    "/proofs",
    asyncRoute(async (req, res) => {
      const result = await createProof(deps.db, deps.clock, bearerUser(req), {
        workflowType: req.body?.workflowType,
        itemCount: req.body?.itemCount ?? req.body?.assetCount,
        participationPolicy: req.body?.participationPolicy,
        transaction: req.body?.transaction ?? req.body,
      });
      res.status(201).json(result);
    }),
  );

  app.get(
    "/proofs/:id",
    asyncRoute(async (req, res) => {
      const result = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  app.get(
    "/capture-recipes",
    asyncRoute(async (req, res) => {
      bearerUser(req);
      res.json({ recipes: listCaptureRecipes() });
    }),
  );

  app.get(
    "/proofs/:id/assets",
    asyncRoute(async (req, res) => {
      await authorizeProofAccess(deps.db, req.params.id, bearerUser(req));
      const assets = await listProofAssets(deps.db, req.params.id);
      res.json({ assets });
    }),
  );

  app.post(
    "/proofs/:id/assets",
    asyncRoute(async (req, res) => {
      const assets = await createProofAssets(deps.db, deps.clock, bearerUser(req), req.params.id, {
        count: req.body?.count ?? req.body?.itemCount,
        assetType: req.body?.assetType,
        catalogDescriptor: req.body?.catalogDescriptor,
      });
      res.status(201).json({ assets });
    }),
  );

  app.patch(
    "/proofs/:id/assets/:assetId",
    asyncRoute(async (req, res) => {
      const asset = await updateAssetCatalog(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.params.assetId,
        req.body?.catalogDescriptor ?? req.body,
      );
      res.json({ asset });
    }),
  );

  app.post(
    "/proofs/:id/assets/:assetId/bindings",
    asyncRoute(async (req, res) => {
      const binding = await bindAssetExternalRef(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        {
          scope: req.body?.scope ?? "ASSET",
          tenantKey: req.body?.tenantKey,
          externalId: req.body?.externalId,
          assetId: req.params.assetId,
          source: req.body?.source,
        },
      );
      res.status(201).json({ binding });
    }),
  );

  app.post(
    "/proofs/:id/actions/document",
    asyncRoute(async (req, res) => {
      const result = await documentAssets(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/pack",
    asyncRoute(async (req, res) => {
      const result = await completePacking(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/handoff",
    asyncRoute(async (req, res) => {
      const result = await handoffAssets(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/receive",
    asyncRoute(async (req, res) => {
      const result = await receiveAssets(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/compare",
    asyncRoute(async (req, res) => {
      const result = await compareObservations(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/output",
    asyncRoute(async (req, res) => {
      const result = await documentProcessingOutput(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/return-pack",
    asyncRoute(async (req, res) => {
      const result = await completeReturnPacking(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/actions/final-receipt",
    asyncRoute(async (req, res) => {
      const result = await completeFinalReceipt(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.body ?? {},
      );
      res.json(result);
    }),
  );

  app.get(
    "/proofs/:id/access-links",
    asyncRoute(async (req, res) => {
      const links = await listAccessLinks(deps.db, bearerUser(req), req.params.id);
      res.json({ accessLinks: links });
    }),
  );

  app.post(
    "/proofs/:id/access-links",
    asyncRoute(async (req, res) => {
      const webBase =
        (deps.corsOrigins ?? []).find((origin) => origin.startsWith("http")) ?? deps.publicBaseUrl;
      const created = await createAccessLink(deps.db, deps.clock, bearerUser(req), req.params.id, {
        scope: req.body?.scope,
        expiresAt: req.body?.expiresAt,
        recipientHint: req.body?.recipientHint,
        publicWebBaseUrl: webBase,
      });
      res.status(201).json(created);
    }),
  );

  app.delete(
    "/proofs/:id/access-links/:linkId",
    asyncRoute(async (req, res) => {
      await revokeAccessLink(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        req.params.linkId,
      );
      res.status(204).end();
    }),
  );

  app.get(
    "/proofs/:id/shipment-events",
    asyncRoute(async (req, res) => {
      const proof = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json(proof.shipmentObservations);
    }),
  );

  app.get(
    "/proofs/:id/chronology",
    asyncRoute(async (req, res) => {
      const proof = await getProofForUser(deps.db, bearerUser(req), req.params.id);
      res.json({ proofId: proof.proofId, chronology: proof.chronology });
    }),
  );

  app.get(
    "/proofs/:id/shipment-integrity",
    asyncRoute(async (req, res) => {
      await authorizeProofAccess(deps.db, req.params.id, bearerUser(req));
      const result = await getShipmentIntegrity(deps.db, req.params.id);
      res.json(result);
    }),
  );

  app.get(
    "/me",
    asyncRoute(async (req, res) => {
      const result = await getProfile(deps.db, bearerUser(req));
      res.json(result);
    }),
  );

  app.get(
    "/me/identities",
    asyncRoute(async (req, res) => {
      const identities = await listLinkedIdentities(deps.db, bearerUser(req));
      res.json({ identities });
    }),
  );

  app.delete(
    "/me/identities/:provider",
    asyncRoute(async (req, res) => {
      await unlinkIdentity(deps.db, bearerUser(req), req.params.provider);
      res.status(204).end();
    }),
  );

  app.get(
    "/me/connected-accounts",
    asyncRoute(async (req, res) => {
      const result = await listConnectedAccounts(deps.db, bearerUser(req), connectedAccounts);
      res.json(result);
    }),
  );

  app.post(
    "/me/connected-accounts/:provider/connect",
    asyncRoute(async (req, res) => {
      const result = await startConnectedAccountConnect(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.provider,
        connectedAccounts,
        typeof req.body === "object" && req.body && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {},
      );
      res.status(201).json(result);
    }),
  );

  app.post(
    "/me/connected-accounts/:id/reauthorize",
    asyncRoute(async (req, res) => {
      const result = await reauthorizeConnectedAccount(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        connectedAccounts,
      );
      res.status(201).json(result);
    }),
  );

  app.delete(
    "/me/connected-accounts/:id",
    asyncRoute(async (req, res) => {
      await disconnectConnectedAccount(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.id,
        connectedAccounts,
      );
      res.status(204).end();
    }),
  );

  app.get(
    "/me/marketplaces",
    asyncRoute(async (req, res) => {
      const ebayStatus = await getEbayMarketplaceStatus(deps.db, bearerUser(req), ebay);
      res.json({ marketplaces: [ebayStatus] });
    }),
  );

  app.post(
    "/me/marketplaces/ebay/connect",
    asyncRoute(async (req, res) => {
      const result = await startEbayConnect(deps.db, deps.clock, bearerUser(req), ebay);
      res.status(201).json(result);
    }),
  );

  app.post(
    "/me/marketplaces/ebay/disconnect",
    asyncRoute(async (req, res) => {
      await disconnectEbay(deps.db, deps.clock, bearerUser(req), credentialStore);
      res.status(204).end();
    }),
  );

  app.get(
    "/me/marketplaces/ebay/orders",
    asyncRoute(async (req, res) => {
      const result = await listEbaySellerOrders(
        deps.db,
        deps.clock,
        bearerUser(req),
        ebay,
        credentialStore,
      );
      res.json({
        role: "SELLING",
        connection: {
          connectionId: result.connection.connectionId,
          status: result.connection.status,
          displayName: result.connection.externalAccountReference,
        },
        orders: result.orders,
        disclosure:
          "Transaction information was supplied by eBay. PackProof records the supplied information but does not independently verify the listing contents or transaction claims.",
      });
    }),
  );

  app.post(
    "/me/marketplaces/ebay/orders/:orderId/import",
    asyncRoute(async (req, res) => {
      const result = await importEbaySellerOrder(
        deps.db,
        deps.clock,
        bearerUser(req),
        ebay,
        credentialStore,
        req.params.orderId,
        { createProof: req.body?.createProof === true },
      );
      res.status(result.created ? 201 : 200).json(result);
    }),
  );

  app.get(
    "/me/proofs",
    asyncRoute(async (req, res) => {
      if (["view", "q", "limit", "offset"].some(key => req.query[key] !== undefined)) {
        res.json(await queryMyProofs(deps.db, bearerUser(req), parseProofListQuery(req.query), deps.clock.now()));
        return;
      }
      const proofs = await listMyProofs(deps.db, bearerUser(req));
      res.json({ proofs });
    }),
  );

  app.get(
    "/me/fulfillment-queue",
    asyncRoute(async (req, res) => {
      const filter = parseFulfillmentQueueFilter(req.query.filter);
      const items = await listFulfillmentQueue(deps.db, bearerUser(req), filter);
      res.json({ items, filter });
    }),
  );

  app.post(
    "/me/packing-station/resolve",
    asyncRoute(async (req, res) => {
      const parsed = parseStationResolveRequest(req.body);
      const result = await resolvePackingStationTarget(deps.db, bearerUser(req), parsed);
      res.json(result);
    }),
  );

  app.get(
    "/me/integration-connections",
    asyncRoute(async (req, res) => {
      const actor = bearerUser(req);
      const capability = String(req.query.capability ?? "").trim();
      const adapterKeys =
        capability === "commerce" ? integrations.listCommerceAdapterKeys() : undefined;
      const rows = await listOwnerConnections(deps.db, actor, adapterKeys);
      const connections = [];
      for (const row of rows) {
        const sync = syncStateView(await loadCommerceSyncState(deps.db, row.id));
        connections.push({
          connectionId: row.id,
          adapterKey: row.adapter_key,
          provider: row.provider,
          providerDisplay: providerDisplay(row.adapter_key, row.provider),
          externalAccountReference: row.external_account_reference,
          status: row.status,
          lastSyncAt: sync.lastSucceededAt,
          lastErrorCode: sync.lastErrorCode,
          retryable: sync.retryable,
          readyOrderCount: await countReadyFulfillmentOrders(deps.db, row.id, actor),
          ...await getCommerceReviewSummary(deps.db, row.id),
          autoSyncEnabled: row.auto_sync_enabled,
          orderPolicy: commerceOrderPolicy(row.adapter_key),
          sync,
        });
      }
      res.json({ connections });
    }),
  );

  app.post("/me/commerce-connections/:connectionId/automation", asyncRoute(async (req, res) => {
    res.json(await setCommerceAutomation(deps.db, deps.clock, bearerUser(req), req.params.connectionId, req.body?.enabled, integrations));
  }));

  app.post(
    "/me/commerce-connections/:connectionId/sync",
    asyncRoute(async (req, res) => {
      parseEmptyTrustedBody(
        req.body,
        "Commerce sync does not accept client-supplied order payloads",
      );
      const result = await executeCommerceFulfillmentSync(
        deps.db,
        deps.clock,
        bearerUser(req),
        req.params.connectionId,
        { integrations, credentials: credentialStore },
      );
      res.json(result);
    }),
  );

  app.patch(
    "/me/profile",
    asyncRoute(async (req, res) => {
      const result = await updateProfile(deps.db, deps.clock, bearerUser(req), {
        username: req.body?.username,
        displayName: req.body?.displayName,
      });
      res.json(result);
    }),
  );

  app.get(
    "/users/search",
    asyncRoute(async (req, res) => {
      const result = await searchUsers(deps.db, req.query.q);
      res.json({ users: result });
    }),
  );

  app.get(
    "/proofs/:id/users/search",
    asyncRoute(async (req, res) => {
      const result = await searchUsersForProof(
        deps.db,
        bearerUser(req),
        req.params.id,
        req.query.q,
      );
      res.json({ users: result });
    }),
  );

  app.get(
    "/invitations",
    asyncRoute(async (req, res) => {
      const result = await listPendingInvitations(deps.db, bearerUser(req));
      res.json({ invitations: result });
    }),
  );

  app.post(
    "/proofs/:id/invitations",
    asyncRoute(async (req, res) => {
      const result = await createInvitation(deps.db, deps.clock, bearerUser(req), req.params.id, {
        inviteeIdentifier:
          req.body?.inviteeIdentifier == null ? undefined : String(req.body.inviteeIdentifier),
        inviteeUserId:
          req.body?.inviteeUserId == null
            ? req.body?.userId == null
              ? undefined
              : String(req.body.userId)
            : String(req.body.inviteeUserId),
      });
      res.status(201).json(result);
    }),
  );

  app.post(
    "/invitations/:token/accept",
    asyncRoute(async (req, res) => {
      const result = await acceptInvitation(deps.db, deps.clock, bearerUser(req), req.params.token);
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/evidence/uploads",
    asyncRoute(async (req, res) => {
      const idempotencyKey = String(
        req.header("idempotency-key") ?? req.body?.idempotencyKey ?? "",
      );
      const result = await initializeEvidenceUpload(
        deps.db,
        deps.clock,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
        {
          contentType: String(req.body?.contentType ?? ""),
          evidenceType: req.body?.evidenceType,
          captureSessionId: req.body?.captureSessionId,
          byteSize: req.body?.byteSize,
          idempotencyKey,
        },
      );
      res.status(201).json(result);
    }),
  );

  app.get(
    "/proofs/:id/evidence/:evidenceId",
    asyncRoute(async (req, res) => {
      const result = await readCommittedEvidenceStream(
        deps.db,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
        req.params.evidenceId,
        req.header("range"),
      );
      res.setHeader("Content-Type", result.contentType);
      try { await appendAudit(deps.db, {
        proofId: req.params.id,
        actorUserId: bearerUser(req),
        eventType: "PROOF_ACCESSED",
        eventData: { channel: "evidence_playback", evidenceId: req.params.evidenceId },
        at: deps.clock.now(),
      });
      } catch(error) { result.body?.destroy(); throw error; }
      res.status(result.status).set(result.headers);
      if (result.body) await pipeline(result.body, res); else res.end();
    }),
  );

  app.post(
    "/proofs/:id/evidence/:evidenceId/commit",
    asyncRoute(async (req, res) => {
      const result = await commitEvidence(
        deps.db,
        deps.clock,
        deps.objectStore,
        bearerUser(req),
        req.params.id,
        req.params.evidenceId,
        req.body?.sha256,
      );
      res.json(result);
    }),
  );

  app.post(
    "/proofs/:id/attestation-challenges",
    asyncRoute(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(201).json(await createAttestationChallenge(deps.db, deps.clock, bearerUser(req), req.params.id, req.body));
    }),
  );

  app.post(
    "/proofs/:id/attestations",
    asyncRoute(async (req, res) => {
      const result = await commitAttestation(deps.db, deps.clock, bearerUser(req), req.params.id, req.body);
      res.status(201).json(result);
    }),
  );

  app.post(
    "/proofs/:id/finalize",
    asyncRoute(async (req, res) => {
      const result = await finalizeProof(deps.db, deps.clock, bearerUser(req), req.params.id, deps.manifestSigning?.signer, {requireDurableReceipts:deps.requireDurableReceipts === true});
      res.status(result.proof.status === "FINALIZED" ? 200 : 202).json(result);
    }),
  );

  app.get(
    "/proofs/:id/manifest",
    asyncRoute(async (req, res) => {
      const result = await getManifest(deps.db, bearerUser(req), req.params.id);
      res.json(result);
    }),
  );

  app.use(requestBodyErrors);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => safeHttpError(error,res);
  app.use(errors);

  return app;
}

function parseEmptyTrustedBody(body: unknown, message: string): void {
  if (body == null || body === "") {
    return;
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw integrationTrustBoundary(message);
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length === 0) {
    return;
  }
  throw integrationTrustBoundary(message);
}

function parseShipmentSyncRequest(body: unknown): void {
  parseEmptyTrustedBody(body, "Shipment sync does not accept client-supplied provider payloads");
}

function publicSyncResult(result: {
  transactionId: string;
  proofId: string;
  connectionId: string;
  adapterKey: string;
  provider: string;
  createdCount: number;
  eventCount: number;
  events: unknown;
  replayed: boolean;
}) {
  return {
    transactionId: result.transactionId,
    proofId: result.proofId,
    connectionId: result.connectionId,
    adapterKey: result.adapterKey,
    provider: result.provider,
    createdCount: result.createdCount,
    eventCount: result.eventCount,
    events: result.events,
    replayed: result.replayed,
  };
}
