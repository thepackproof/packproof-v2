import type { ProofView, TransactionView } from "../v2-api";

type CorrectionPolicy = {
  canCorrectOrderDetails: boolean;
  canCorrectShipping: boolean;
  reason: string | null;
};
type SourceTransaction = TransactionView & { correctionPolicy?: CorrectionPolicy };

/** Origin and lifecycle come from the server. These local checks also cover stale screens. */
export function recordCorrectionState(proof: ProofView | null | undefined, transaction: SourceTransaction | null | undefined, role: string | null | undefined, hasLocalCapture = false) {
  const source = transaction?.provenance?.source?.toUpperCase() ?? "";
  const policy = transaction?.correctionPolicy;
  const imported = policy?.reason === "IMPORTED_FACTS_READ_ONLY" || ["MARKETPLACE", "STOREFRONT", "SHIPPING_PROVIDER"].some(kind => source.includes(kind));
  const captured = hasLocalCapture || (proof?.evidence ?? []).some(item => ["PENDING", "COMMITTED"].includes(item.validationStatus)) || proof?.status === "EVIDENCE_COMMITTED";
  const finalized = proof?.status === "FINALIZED";
  const seller = role === "SELLER";
  const knownContext = Boolean(proof && transaction);
  const allowed = knownContext && seller && !imported && !captured && !finalized;
  const provider = transaction?.provenance?.provider;
  const names: Record<string, string> = { ebay: "eBay", etsy: "Etsy", shopify: "Shopify", shippo: "Shippo", easypost: "EasyPost" };
  const sourceLabel = imported ? `From ${provider ? names[provider.toLowerCase()] ?? provider : "connected order"}` : "Added by a participant";
  const reason = finalized ? "These details are locked with the saved Proof. Later observations are recorded separately."
    : imported ? `${sourceLabel}. Imported order details stay as received from their source.`
    : captured || policy?.reason === "CAPTURE_CONTEXT_LOCKED" ? "Recording has started. These details stay attached to that recording."
    : !seller ? "These details were supplied by the seller."
    : "Correct the details before recording. Changes are recorded with their source.";
  return {
    canCorrectOrder: allowed && (policy?.canCorrectOrderDetails ?? true),
    canCorrectShipping: allowed && (policy?.canCorrectShipping ?? true),
    imported, sourceLabel, reason,
  };
}
