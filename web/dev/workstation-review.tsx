/**
 * Local visual review only. The production entry point does not import this file.
 * The real App and styles run against fictional, memory-only API responses.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { saveSession } from "../src/auth/session";
import type { CanonicalProof, CommerceConnectionView, ConnectedAccountProviderCatalogView, ProofCollectionItem } from "../src/api/types";
import type { ProofSearchItem, ProofSearchResult, ProofSearchState } from "../../packages/evidence-contracts/api-dashboard";
import type { ConnectionHealthView } from "../src/api/connection-health";
import { classifyProofPresentation } from "../../backend/src/domain/proof-presentation";
import "../src/styles.css";
import "../src/site/site.css";
import "../src/site/refinements.css";
import "../src/site/experience.css";
import "../src/components/workspace-proof-record.css";
import "../src/site/proof-diagram.css";
import "../src/site/workflow-visual.css";
import "../src/site/brand-palette.css";
import "../src/site/paper-system.css";
import "../src/site/material-polish.css";
import "../src/workspace/workstation.css";

if (!import.meta.env.DEV || window.location.origin !== "http://127.0.0.1:5180") {
  throw new Error("Design review can run only on http://127.0.0.1:5180 in development.");
}

const apiBaseUrl = "http://127.0.0.1:5180/__review-api";
const userId = "user_local_design_review";
let profile = { userId, username: "sample.workspace", displayName: "Sample workspace", status: "ACTIVE", createdAt: "2026-09-01T12:00:00Z", updatedAt: "2026-10-07T12:00:00Z" };
const reviewScenario = new URLSearchParams(window.location.search).get("review-state") || "mixed";
const titles = ["Comic Book · Silver Horizon #1", "Trading Card · Forest Guardian", "Grading submission", "Comic Book Collection", "Packing demonstration"];
const dates = ["2026-10-06T20:51:00Z", "2026-10-06T16:55:00Z", "2026-10-04T14:50:00Z", "2026-10-02T12:03:00Z", "2026-10-01T11:11:00Z"];
let proofs: ProofCollectionItem[] = titles.map((title, index) => {
  const completed = index > 2;
  const proofId = `proof_review_${index + 1}`;
  const status = completed ? "FINALIZED" : "READY_FOR_EVIDENCE";
  return {
    schema: "packproof.proof.summary/v1", proofId, transactionId: `transaction_review_${index + 1}`, role: "SELLER", status,
    createdAt: dates[index], updatedAt: dates[index], finalizedAt: completed ? dates[index] : null, accessKind: "PARTICIPANT",
    transaction: { externalReference: title, itemTitle: title, transactionDate: dates[index].slice(0, 10), carrier: null, trackingNumber: null },
    presentation: classifyProofPresentation({ proofId, status, role: "SELLER", finalizedAt: completed ? dates[index] : null, workflowType: "GRADING_SUBMISSION", workflowNextAction: { type: "DOCUMENT_ITEM", title: "Document item 1 of 1", actorRole: "SELLER" } }),
  };
});
if (reviewScenario === "empty") proofs = [];
if (reviewScenario === "completed") proofs = proofs.filter(proof => proof.status === "FINALIZED");
if (reviewScenario === "pagination") {
  proofs = Array.from({ length: 57 }, (_, index) => {
    const source = proofs[index % proofs.length];
    const proofId = `proof_review_${index + 1}`;
    return { ...source, proofId, transactionId: `transaction_review_${index + 1}`,
      transaction: { ...source.transaction, externalReference: `SAMPLE-${String(index + 1).padStart(4, "0")}`, itemTitle: `${source.transaction.itemTitle} · shipment ${index + 1}` } };
  });
}
if (reviewScenario === "offline") Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
if (reviewScenario === "large-text") {
  const scale = document.createElement("style");
  scale.textContent = ".workspace-shell :is(p,button,a,span,input,select,summary,time) { font-size: 24px!important; } .workspace-shell :is(h1,h2,h3) { font-size: 30px!important; }";
  document.head.appendChild(scale);
}
let staleRefresh = false;
const searchStates: ProofSearchState[] = ["AWAITING_CAPTURE", "IN_PROGRESS", "NEEDS_ATTENTION", "READY", "IN_PROGRESS"];
const connectionId = "connection_review_shopify";
const searchRows: ProofSearchItem[] = proofs.map((proof, index) => {
  const state = reviewScenario === "ready" || reviewScenario === "completed" ? "READY" : searchStates[index % searchStates.length];
  const finalized = state === "READY" || state === "NEEDS_ATTENTION" || index % 5 === 4;
  const number = String(index + 1).padStart(4, "0");
  return { proofId: proof.proofId, transactionId: proof.transactionId,
    status: finalized ? "FINALIZED" : "READY_FOR_EVIDENCE", createdAt: proof.createdAt,
    updatedAt: proof.updatedAt, finalizedAt: finalized ? proof.updatedAt : null,
    externalId: `SAMPLE-${number}`, itemTitle: proof.transaction.itemTitle, itemCount: index % 3 === 0 ? 3 : 1,
    trackingNumber: index % 2 === 0 ? `SAMPLE-TRACK-${number}` : null,
    connectionId, provider: "shopify", recordedBy: state === "AWAITING_CAPTURE" ? null : "Sample packing operator",
    serverReceivedAt: state === "AWAITING_CAPTURE" ? null : proof.createdAt,
    readiness: { state, reason: state === "READY" ? null : state === "AWAITING_CAPTURE" ? "CAPTURE_REQUIRED" : state === "NEEDS_ATTENTION" ? "LEGACY_UNCONFIRMED" : index % 5 === 1 ? "CONFIRMATION_REQUIRED" : "PRESERVATION_PENDING", preserved: state === "READY" } };
});
// Keep the legacy summary/detail fixtures consistent with this explicitly fictional projection.
proofs = proofs.map(proof => {
  const row = searchRows.find(item => item.proofId === proof.proofId)!;
  return { ...proof, status: row.status, finalizedAt: row.finalizedAt,
    transaction: { ...proof.transaction, externalReference: row.externalId, trackingNumber: row.trackingNumber },
    presentation: classifyProofPresentation({ proofId: proof.proofId, status: row.status, role: "SELLER", finalizedAt: row.finalizedAt, workflowType: "GRADING_SUBMISSION", workflowNextAction: { type: "DOCUMENT_ITEM", title: "Document item 1 of 1", actorRole: "SELLER" } }) };
});
const connections: CommerceConnectionView[] = reviewScenario === "empty" ? [] : [{
  connectionId, adapterKey: "shopify-fulfillment", provider: "shopify", providerDisplay: "Shopify",
  externalAccountReference: "sample-packing-store.myshopify.com", status: "ACTIVE", lastSyncAt: new Date(Date.now() - 120_000).toISOString(),
  lastErrorCode: null, retryable: null, readyOrderCount: searchRows.filter(row => row.readiness.state === "AWAITING_CAPTURE").length,
  autoSyncEnabled: true, automationAvailable: true, orderReadVerified: true,
}];
if (reviewScenario === "connection-issues") connections.push({
  ...connections[0], connectionId: "connection_review_reconnect", externalAccountReference: "second-sample-store.myshopify.com",
  status: "RECONNECT_REQUIRED", lastSyncAt: null, lastErrorCode: "REAUTH_REQUIRED", retryable: false,
  readyOrderCount: 0, automationAvailable: false, automationUnavailableReason: "RECONNECT_REQUIRED", orderReadVerified: false,
});
function connectionHealth(connection: CommerceConnectionView): ConnectionHealthView {
  const reconnect = connection.status !== "ACTIVE";
  const stale = reviewScenario === "connection-issues";
  const lastRead = reconnect ? null : new Date(Date.now() - (stale ? 3_600_000 : 120_000)).toISOString();
  const rows = searchRows.filter(row => row.connectionId === connection.connectionId);
  const count = (state: ProofSearchState) => rows.filter(row => row.readiness.state === state).length;
  const finalized = rows.filter(row => row.status === "FINALIZED").length;
  return { schema: "packproof.connection-health/v1", connectionId: connection.connectionId, provider: connection.provider,
    observedAt: new Date().toISOString(), status: connection.status,
    capabilities: { stableAccountId: `sample-account-${connection.connectionId}`, automationAvailable: !reconnect,
      automationUnavailableReason: reconnect ? "RECONNECT_REQUIRED" : null, exactOrderReadSupported: true,
      incrementalListSupported: true, orderReadVerified: !reconnect, lastOrderReadAt: lastRead,
      webhookSubscriptionsVerified: !reconnect, webhookDeliveryVerified: !reconnect, lastWebhookReceivedAt: lastRead },
    automation: { optedIn: true, paused: reconnect },
    sync: { runStatus: reconnect ? "PAUSED" : stale ? "FAILED" : "IDLE", retryable: stale && !reconnect,
      reconnectRequired: reconnect, sourceWatermarkAt: lastRead, sourceAgeSeconds: reconnect ? null : stale ? 3600 : 120,
      stale: reconnect ? null : stale, pageResumePending: stale && !reconnect, expiredLease: false,
      pendingProviderEvents: stale && !reconnect ? 2 : 0, oldestPendingProviderEventAt: stale && !reconnect ? lastRead : null },
    coverage: { basis: "DISCOVERED_SOURCE_RECORDS", discovered: rows.length, eligible: rows.length, excluded: 0,
      eligibleWithoutProof: 0, awaitingCapture: count("AWAITING_CAPTURE"),
      inProgress: rows.length - finalized - count("AWAITING_CAPTURE"), finalized, otherEligible: 0,
      oldestAwaitingCaptureAt: rows.find(row => row.readiness.state === "AWAITING_CAPTURE")?.createdAt ?? null,
      reviewOrderCount: 0, reviewReasons: [] },
    nextAction: reconnect ? "RECONNECT" : stale ? "RETRY_SYNC" : "NONE" };
}
// Fixture cursors are opaque and bound to filter/limit, like the real API contract.
// They are in-memory review tokens, not production signing material.
const searchCursors = new Map<string, { filter: string; offset: number; expiresAt: number }>();
let nextCursorId = 0;
function searchPage(parameters: URLSearchParams): Response {
  const filter = JSON.stringify(["q", "state", "from", "through", "connectionId", "integrationAccountId", "limit"].map(key => parameters.get(key) || ""));
  const after = parameters.get("after");
  const cursor = after ? searchCursors.get(after) : undefined;
  if (after && (!cursor || cursor.filter !== filter || cursor.expiresAt <= Date.now()))
    return json({ error: { code: "INVALID_CURSOR", message: "The sample page expired or its filters changed. Refresh the search." } }, 400);
  const query = (parameters.get("q") || "").trim().toLowerCase();
  const from = parameters.get("from"), through = parameters.get("through");
  const rows = searchRows.filter(row =>
    (!query || `${row.externalId} ${row.itemTitle} ${row.trackingNumber} ${row.proofId}`.toLowerCase().includes(query)) &&
    (!parameters.get("state") || row.readiness.state === parameters.get("state")) &&
    (!parameters.get("connectionId") || row.connectionId === parameters.get("connectionId")) &&
    (!from || row.createdAt.slice(0, 10) >= from) && (!through || row.createdAt.slice(0, 10) <= through));
  const requestedLimit = Number(parameters.get("limit") || 50);
  const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(50, requestedLimit)) : 50;
  const offset = cursor?.offset ?? 0;
  const hasMore = offset + limit < rows.length;
  const nextCursor = hasMore ? `local-review-page-${++nextCursorId}` : null;
  const expiresAt = Date.now() + 3_600_000;
  if (nextCursor) searchCursors.set(nextCursor, { filter, offset: offset + limit, expiresAt });
  const page: ProofSearchResult = { apiVersion: "v1", schema: "packproof.proof-search/v1", proofs: rows.slice(offset, offset + limit),
    nextCursor, hasMore, refreshedAt: new Date().toISOString(), cursorExpiresAt: new Date(expiresAt).toISOString() };
  return json(page);
}
const providers: ConnectedAccountProviderCatalogView[] = [
  ["ebay", "eBay", false, true], ["etsy", "Etsy", false, true], ["shopify", "Shopify", true, true], ["google", "Google", false, false], ["facebook", "Meta", false, false],
].map(([provider, providerDisplay, enabled, transactions]) => ({
  provider: String(provider), providerDisplay: String(providerDisplay), enabled: Boolean(enabled),
  capabilities: { identity: true, transactions: Boolean(transactions), fulfillment: Boolean(transactions), shipping: false, webhooks: false },
  limitations: [enabled ? "Connections are simulated in this local design review." : "Unavailable in this sample environment."],
  multipleAccounts: false, requiresShop: provider === "shopify",
}));
const onboarding = { first_experience_version:1, automatic_tour:false, activation_status:reviewScenario === 'empty' ? 'NOT_ACTIVATED' : 'ACTIVATED', first_finalized_packing_proof_id:reviewScenario === 'empty' ? null : 'proof_review_4', first_finalized_packing_at:reviewScenario === 'empty' ? null : dates[3], onboarding_completed: true, onboarding_version: 1, first_proof_coaching_completed: true, onboarding_last_step: 5, onboarding_enrolled: false, current_version: 1, first_proof_id: null, first_proof_completed: false };
let notificationPreferences = { enabled: true, uploads: true, evidence: true, participants: true, shipments: true, returns: true };

function canonicalProof(summary: ProofCollectionItem): CanonicalProof {
  return {
    schema: "packproof.proof.canonical/v1", proofId: summary.proofId, transactionId: summary.transactionId, status: summary.status,
    version: 1, createdAt: summary.createdAt, updatedAt: summary.updatedAt, finalizedAt: summary.finalizedAt,
    manifestId: summary.finalizedAt ? `manifest_${summary.proofId}` : null, participationPolicy: "COUNTERPARTY_OPTIONAL", presentation: summary.presentation,
    transaction: { ...summary.transaction, transactionId: summary.transactionId, quantity: 1, itemDescription: "Fictional shipment for local visual review.",
      transactionValue: null, currency: "USD", createdBy: userId, createdAt: summary.createdAt, updatedAt: summary.updatedAt, metadata: {},
      shipping: { carrier: null, service: null, trackingNumber: null, shipmentDate: null }, proofId: summary.proofId, proofStatus: summary.status, sellerUserId: userId, buyerUserId: null },
    participants: [{ participantId: `participant_${summary.proofId}`, userId, role: "SELLER", status: "JOINED", joinedAt: summary.createdAt }],
    invitations: [], evidence: [], attestations: [], events: [], facts: [], external: { records: [], references: [] },
    integrity: { algorithm: "SHA-256", evidence: [], manifestSha256: null },
    shipmentObservations: { shippingId: null, identity: { carrier: null, service: null, trackingNumber: null, shipmentDate: null }, events: [], latest: null }, chronology: [],
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "X-PackProof-Review": "fictional-data" } });
const unsupported = () => json({ error: { code: "LOCAL_REVIEW_ONLY", message: "This action is unavailable in the local design review. No live account or evidence was changed." } }, 409);
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
  // Even a newly added feature must not reach a live provider/API from this harness.
  if (url.origin !== window.location.origin) return unsupported();
  if (!url.pathname.startsWith("/__review-api/")) return realFetch(input, init);
  const path = url.pathname.slice("/__review-api".length);
  const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  const body = typeof init?.body === "string" && init.body ? JSON.parse(init.body) as Record<string, unknown> : {};
  if (path === "/me/notification-preferences" && method === "PATCH") {
    notificationPreferences = { ...notificationPreferences, ...body };
    return json(notificationPreferences);
  }
  if (path === "/me/profile" && method === "PATCH") {
    if (typeof body.displayName === "string") profile = { ...profile, displayName: body.displayName };
    return json(profile);
  }
  if (method !== "GET") {
    if (path === "/me/onboarding") return json(onboarding);
    return unsupported();
  }
  if (path === "/me") return json(profile);
  if (path === "/me/capabilities") return json({ userId, roles: [], isAdmin: false, environment: "local-design-review" });
  if (path === "/me/developer-access") return json({ allowed: false });
  if (path === "/me/onboarding") return json(onboarding);
  if (path === "/me/proofs/search") {
    if (reviewScenario === "offline") throw new TypeError("The sample browser is offline.");
    if (reviewScenario === "error" || reviewScenario === "stale" && staleRefresh)
      return json({ error: { code: "REVIEW_NETWORK_UNAVAILABLE", message: "Sample refresh failure. Previously loaded records may be out of date." } }, 503);
    return searchPage(url.searchParams);
  }
  if (path === "/me/proofs") {
    if (reviewScenario === "error" || reviewScenario === "stale" && staleRefresh) return json({ error: { code: "REVIEW_NETWORK_UNAVAILABLE", message: "Sample refresh failure. Cached records are retained." } }, 503);
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const view = url.searchParams.get("view");
    return json({ proofs: proofs.filter(proof => `${proof.transaction.itemTitle} ${proof.transaction.externalReference}`.toLowerCase().includes(query) && (view === "attention" ? proof.presentation?.needsAttention : view === "completed" ? proof.presentation?.completed : true)), nextOffset: null });
  }
  if (path === "/me/fulfillment-queue") return json({ items: [], filter: url.searchParams.get("filter") || "ready" });
  if (path === "/me/integration-connections") return json({ connections });
  const healthMatch = path.match(/^\/me\/commerce-connections\/([^/]+)\/health$/);
  if (healthMatch) {
    if (reviewScenario === "connection-error")
      return json({ error: { code: "REVIEW_NETWORK_UNAVAILABLE", message: "Sample connection diagnostics are temporarily unavailable." } }, 503);
    const connection = connections.find(item => item.connectionId === decodeURIComponent(healthMatch[1]));
    return connection ? json(connectionHealth(connection)) : json({ error: { code: "NOT_FOUND", message: "Unknown sample connection." } }, 404);
  }
  if (path === "/me/connected-accounts") return json({ accounts: [], providers });
  if (path === "/me/marketplaces") return json({ marketplaces: [{ provider: "ebay", adapterKey: "ebay-seller", enabled: false, environment: "local-design-review", connection: null }] });
  if (path === "/invitations") return json({ invitations: [] });
  if (path === "/me/notifications") return json({ notifications: [] });
  if (path === "/me/notification-preferences") return json(notificationPreferences);
  if (path === "/me/intake/capabilities") return json({ enabled: false, emailEnabled: false, browserEnabled: false, devicesEnabled: false, mailDomainConfigured: false });
  if (path === "/me/intake/orders") return json({ orders: [] });
  if (path === "/me/intake/devices") return json({ devices: [] });
  if (path === "/me/intake/mail") return json({ aliases: [] });
  if (path === "/me/account-deletion-request") return json({ request: null, retentionNotice: "This is a fictional local account. No deletion request can be sent from this review." });
  if (path === "/me/billing/status") return json({ enabled: false, subscriptions: [], pendingCheckout: null });
  if (path === "/me/billing/invoices") return json({ enabled: false, invoices: [] });
  if (path === "/study/consent") return json({ enabled: false, datasetRef: null, granted: false });
  if (path === "/me/usage") return json({ window: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" }, finalizedWithDurabilityReceipt: 0, finalizedWithoutConfirmedDurability: 2, recordedUsageUnits: 0, currentOffer: null, message: "Fictional usage for local review." });
  // Selecting a sample Proof cannot start a real capture or invent preservation.
  if (path === "/capabilities") return unsupported();
  const proofMatch = path.match(/^\/proofs\/(proof_review_\d{1,3})(?:\/(.*))?$/);
  if (proofMatch) {
    const proof = proofs.find(item => item.proofId === proofMatch[1]);
    if (!proof) return json({ error: { code: "NOT_FOUND", message: "Unknown sample Proof." } }, 404);
    const feature = proofMatch[2] || "";
    if (!feature) return json(canonicalProof(proof));
    if (feature === "recovery") return json({ proofId: proof.proofId, evidence: [], declarations: [], finalization: { status: proof.finalizedAt ? "FINALIZED" : "NOT_FINALIZED", receipt: null } });
    if (feature === "shipment-integrity") return json({ schema: "packproof.shipment.integrity/v1", proofId: proof.proofId, transactionId: proof.transactionId, status: "NO_SHIPMENT", shippingId: null, coreManifestSha256: null, shipmentSupplementSha256: null, eventCount: 0, firstEventSha256: null, latestEventSha256: null, supplement: null, verification: { valid: false, issues: [], result: "NOT_EVALUATED" } });
    if (feature === "signature/") return json({ snapshot: { data: { anchors: [] } } });
    if (feature === "notification-mute") return json({ muted: false });
  }
  return json({ error: { code: "REVIEW_FIXTURE_MISSING", message: "This view has no local design-review fixture." } }, 404);
};

saveSession({ apiBaseUrl, authMode: "dev", userId, username: profile.username, displayName: profile.displayName,
  token: "local-design-review-not-a-real-token", refreshToken: null, accessExpiresAt: null, subject: "sample@packproof.invalid" });
if (["/", "/review.html"].includes(window.location.pathname)) window.history.replaceState({}, "", `/proofs${window.location.search}`);
if (!localStorage.getItem("packproof-v2.appearance")) localStorage.setItem("packproof-v2.appearance", "dark");

const bannerStyle = document.createElement("style");
bannerStyle.textContent = `.local-design-review-label { position:relative; z-index:1; margin:8px 16px 90px; display:flex; flex-wrap:wrap; align-items:center; gap:12px; max-width:calc(100vw - 36px); padding:12px; background:#18344d; color:#eaf4ff; border:1px solid #597a98; border-radius:6px; font:600 12px/1.5 Inter,"Segoe UI",sans-serif; } .local-design-review-label :is(button,select) { min-height:36px; border:1px solid #8294aa; border-radius:5px; background:#18344d; color:#eaf4ff; padding:5px 9px; font:inherit; } .local-design-review-label label { display:flex; align-items:center; gap:8px; } .local-design-review-label button:focus-visible,.local-design-review-label select:focus-visible { outline:3px solid white; outline-offset:3px; }`;
document.head.appendChild(bannerStyle);
const root = document.getElementById("root");
if (!root) throw new Error("Missing local review root.");
const scenarios = ["mixed", "ready", "empty", "pagination", "error", "offline", "stale", "connection-issues", "connection-error", "large-text"];
function ReviewControls() {
  const go = (scenario: string) => { window.location.href = `/proofs?review-state=${encodeURIComponent(scenario)}`; };
  return <aside className="local-design-review-label" aria-label="Local review environment">
    <strong>LOCAL DESIGN REVIEW · FICTIONAL DATA</strong>
    <label>Sample scenario<select value={reviewScenario} onChange={event => go(event.target.value)}>{scenarios.map(scenario => <option key={scenario} value={scenario}>{scenario}</option>)}</select></label>
    <button type="button" onClick={() => window.dispatchEvent(new Event("packproof:replay-dashboard-tour"))}>Replay sample tour</button>
    <button type="button" onClick={() => {
      localStorage.removeItem(`packproof:dashboard-tour:v1:${encodeURIComponent(`${apiBaseUrl}:${userId}`)}`);
      window.location.reload();
    }}>Reset sample tour</button>
    <button type="button" onClick={() => { staleRefresh = false; window.dispatchEvent(new Event("packproof:records-updated")); }}>Restore sample refresh</button>
    <span>Recording, provider changes, sharing and downloads remain unavailable here.</span>
  </aside>;
}
createRoot(root).render(<StrictMode><App /><ReviewControls /></StrictMode>);

if (reviewScenario === "stale") window.setTimeout(() => { staleRefresh = true; window.dispatchEvent(new Event("packproof:records-updated")); }, 1500);
