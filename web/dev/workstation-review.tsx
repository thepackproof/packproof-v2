/**
 * Local visual review only. The production entry point does not import this file.
 * The real App and styles run against fictional, memory-only API responses.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";
import { saveSession } from "../src/auth/session";
import type { CanonicalProof, ConnectedAccountProviderCatalogView, ProofCollectionItem } from "../src/api/types";
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
const titles = ["Comic Book · Silver Horizon #1", "Trading Card · Forest Guardian", "Grading submission", "Comic Book Collection", "Packing demonstration"];
const dates = ["2026-10-06T20:51:00Z", "2026-10-06T16:55:00Z", "2026-10-04T14:50:00Z", "2026-10-02T12:03:00Z", "2026-10-01T11:11:00Z"];
const proofs: ProofCollectionItem[] = titles.map((title, index) => {
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
const providers: ConnectedAccountProviderCatalogView[] = [
  ["ebay", "eBay", false, true], ["etsy", "Etsy", false, true], ["shopify", "Shopify", true, true], ["google", "Google", false, false], ["facebook", "Meta", false, false],
].map(([provider, providerDisplay, enabled, transactions]) => ({
  provider: String(provider), providerDisplay: String(providerDisplay), enabled: Boolean(enabled),
  capabilities: { identity: true, transactions: Boolean(transactions), fulfillment: Boolean(transactions), shipping: false, webhooks: false },
  limitations: [enabled ? "Connections are simulated in this local design review." : "Unavailable in this sample environment."],
  multipleAccounts: false, requiresShop: provider === "shopify",
}));
const onboarding = { onboarding_completed: true, onboarding_version: 1, first_proof_coaching_completed: true, onboarding_last_step: 5, onboarding_enrolled: false, current_version: 1, first_proof_id: null, first_proof_completed: false };
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
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/__review-api/")) return realFetch(input, init);
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
  if (path === "/me/proofs") {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const view = url.searchParams.get("view");
    return json({ proofs: proofs.filter(proof => `${proof.transaction.itemTitle} ${proof.transaction.externalReference}`.toLowerCase().includes(query) && (view === "attention" ? proof.presentation?.needsAttention : view === "completed" ? proof.presentation?.completed : true)), nextOffset: null });
  }
  if (path === "/me/fulfillment-queue") return json({ items: [], filter: url.searchParams.get("filter") || "ready" });
  if (path === "/me/integration-connections") return json({ connections: [] });
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
  const proofMatch = path.match(/^\/proofs\/(proof_review_[1-5])(?:\/(.*))?$/);
  if (proofMatch) {
    const proof = proofs.find(item => item.proofId === proofMatch[1])!;
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
if (["/", "/review.html"].includes(window.location.pathname)) window.history.replaceState({}, "", "/app");
if (!localStorage.getItem("packproof-v2.appearance")) localStorage.setItem("packproof-v2.appearance", "dark");

const bannerStyle = document.createElement("style");
bannerStyle.textContent = `.local-design-review-label { position:fixed; z-index:10000; right:18px; bottom:12px; display:flex; align-items:center; gap:12px; max-width:calc(100vw - 36px); padding:8px 11px; background:#18344d; color:#eaf4ff; border:1px solid #597a98; border-radius:6px; box-shadow:0 3px 14px #0002; font:600 9px/1.5 Inter,"Segoe UI",sans-serif; letter-spacing:.7px; } .local-design-review-label a { color:#bddbff; font-weight:500; text-decoration:underline; letter-spacing:0; } @media(max-width:600px) { .local-design-review-label { bottom:8px; right:8px; font-size:8px; } }`;
document.head.appendChild(bannerStyle);
const root = document.getElementById("root");
if (!root) throw new Error("Missing local review root.");
createRoot(root).render(<StrictMode><App /><aside className="local-design-review-label" aria-label="Local review environment">LOCAL DESIGN REVIEW · SAMPLE DATA<a href="/app" title="Reload the local sample workspace">Reset review</a></aside></StrictMode>);
