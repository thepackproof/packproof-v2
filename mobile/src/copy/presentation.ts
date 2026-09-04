import {
  formatDate,
  moneyLabel,
  orderReferenceLabel,
  roleLabel,
  shippingSummary,
} from "./format";
import { deriveNextAction, type NextAction } from "./next-action";
import {
  humanProofStatus,
  integrityState,
  type IntegrityState,
  type LocalCaptureStatus,
} from "./status";

export type ProofLibraryView = "in_progress" | "completed";
export type ProofLibrarySort = "newest" | "oldest" | "price_high" | "price_low";
export type ProofRoleFilter = "all" | "seller" | "buyer";

export interface ProofSummaryLike {
  proofId: string;
  role: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  transaction: {
    externalReference: string | null;
    itemTitle: string | null;
    transactionDate: string | null;
    carrier: string | null;
    trackingNumber: string | null;
    transactionValue?: number | null;
    currency?: string | null;
    service?: string | null;
  };
}

export interface ProofCardModel {
  proofId: string;
  title: string;
  orderRef: string;
  roleLabel: string;
  statusLabel: string;
  priceLabel: string;
  shipping: string;
  dateLabel: string;
  integrity: IntegrityState;
  thumbnailUri: string | null;
}

export interface AttentionModel {
  proofId: string | null;
  invitationId: string | null;
  title: string;
  statusLabel: string;
  shipping: string;
  cta: string;
  kind: "proof" | "invitation";
}

export interface HomeSummaryModel {
  greeting: string;
  activeCount: number;
  awaitingEvidenceCount: number;
  readyToFinalizeCount: number;
  invitationCount: number;
  summaryLine: string;
  attention: AttentionModel | null;
}

export function proofTitle(item: { transaction?: { itemTitle?: string | null }; itemTitle?: string | null }): string {
  return item.transaction?.itemTitle?.trim() || item.itemTitle?.trim() || "Untitled item";
}

export function toProofCardModel(
  item: ProofSummaryLike,
  extras?: {
    captureStatus?: LocalCaptureStatus;
    hasLocalCapture?: boolean;
    captureProofId?: string | null;
    latestShipmentEventType?: string | null;
    thumbnailUri?: string | null;
  },
): ProofCardModel {
  const belongs = extras?.captureProofId === item.proofId;
  return {
    proofId: item.proofId,
    title: proofTitle(item),
    orderRef: orderReferenceLabel(item.transaction.externalReference),
    roleLabel: roleLabel(item.role),
    statusLabel: humanProofStatus({
      proofStatus: item.status,
      captureStatus: extras?.captureStatus,
      hasLocalCapture: extras?.hasLocalCapture,
      captureBelongsToProof: belongs,
      latestShipmentEventType: extras?.latestShipmentEventType,
      hasShipping: Boolean(item.transaction.carrier || item.transaction.trackingNumber),
    }),
    priceLabel: moneyLabel(item.transaction.transactionValue, item.transaction.currency),
    shipping: shippingSummary({
      carrier: item.transaction.carrier,
      service: item.transaction.service,
      trackingNumber: item.transaction.trackingNumber,
    }),
    dateLabel: formatDate(item.finalizedAt ?? item.updatedAt ?? item.createdAt),
    integrity: integrityState({ proofStatus: item.status }),
    thumbnailUri: extras?.thumbnailUri ?? null,
  };
}

export function isActiveProof(status: string): boolean {
  return status !== "FINALIZED";
}

export function proofLibraryGroup(status: string): ProofLibraryView {
  return status === "FINALIZED" ? "completed" : "in_progress";
}

export function proofSearchHaystack(item: ProofSummaryLike): string {
  return [
    proofTitle(item),
    item.transaction.externalReference,
    item.transaction.carrier,
    item.transaction.service,
    item.transaction.trackingNumber,
    item.role,
    extrasParticipantText(item),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function extrasParticipantText(item: ProofSummaryLike): string {
  return "participantText" in item && typeof item.participantText === "string" ? item.participantText : "";
}

export function matchesProofSearch(item: ProofSummaryLike, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return proofSearchHaystack(item).includes(normalized);
}

export function sortProofLibrary<T extends ProofSummaryLike>(items: T[], sort: ProofLibrarySort): T[] {
  const copy = [...items];
  copy.sort((left, right) => {
    if (sort === "price_high" || sort === "price_low") {
      const leftPrice = left.transaction.transactionValue ?? Number.NEGATIVE_INFINITY;
      const rightPrice = right.transaction.transactionValue ?? Number.NEGATIVE_INFINITY;
      const delta = sort === "price_high" ? rightPrice - leftPrice : leftPrice - rightPrice;
      if (delta !== 0) {
        return delta;
      }
    }
    const leftTime = Date.parse(left.updatedAt || left.createdAt);
    const rightTime = Date.parse(right.updatedAt || right.createdAt);
    return sort === "oldest" ? leftTime - rightTime : rightTime - leftTime;
  });
  return copy;
}

export function filterProofInvitations<T extends {
  transaction: { itemTitle: string | null };
  inviter: { displayName: string | null; username: string | null };
}>(items: T[], input: {
  view: ProofLibraryView; role?: ProofRoleFilter; carrier?: string | null; query?: string;
}): T[] {
  if (input.view !== "in_progress" || (input.role && input.role !== "all") || input.carrier) return [];
  const query = input.query?.trim().toLowerCase() ?? "";
  return items.filter((invite) => !query ||
    [invite.transaction.itemTitle, invite.inviter.displayName, invite.inviter.username]
      .filter(Boolean).join(" ").toLowerCase().includes(query));
}

export function filterProofLibrary<T extends ProofSummaryLike>(
  items: T[],
  input: {
    view: ProofLibraryView;
    query?: string;
    sort?: ProofLibrarySort;
    role?: ProofRoleFilter;
    carrier?: string | null;
    source?: string | null;
  },
): T[] {
  const filtered = items.filter((item) => {
    if (proofLibraryGroup(item.status) !== input.view) {
      return false;
    }
    if (input.role === "seller" && item.role !== "SELLER") {
      return false;
    }
    if (input.role === "buyer" && item.role !== "BUYER") {
      return false;
    }
    if (input.carrier && item.transaction.carrier !== input.carrier) {
      return false;
    }
    if (input.source) {
      const provider = "provider" in item.transaction ? String(item.transaction.provider ?? "") : "";
      if (provider.toLowerCase() !== input.source.toLowerCase()) {
        return false;
      }
    }
    return matchesProofSearch(item, input.query ?? "");
  });
  return sortProofLibrary(filtered, input.sort ?? "newest");
}

export function uniqueCarriers(items: Array<{ transaction: { carrier?: string | null } }>): string[] {
  return [...new Set(items.map((item) => item.transaction.carrier).filter((value): value is string => Boolean(value)))].sort();
}

export function marketplaceImportAvailable(
  connections: Array<{ status?: string | null; readyOrderCount?: number | null }>,
): boolean {
  return connections.some((connection) => {
    const status = (connection.status ?? "").toUpperCase();
    return status === "CONNECTED" || status === "READY" || status === "ACTIVE" || (connection.readyOrderCount ?? 0) > 0;
  });
}

export function awaitingEvidenceCount(
  items: Array<{ status: string; role: string }>,
): number {
  return items.filter((item) => item.role === "SELLER" && item.status === "READY_FOR_EVIDENCE").length;
}

export function readyToFinalizeCount(items: Array<{ status: string; role: string }>): number {
  return items.filter((item) => item.role === "SELLER" && item.status === "EVIDENCE_COMMITTED").length;
}

export function homeSummaryLine(input: {
  activeCount: number;
  awaitingEvidenceCount: number;
  readyToFinalizeCount: number;
  invitationCount: number;
}): string {
  const parts: string[] = [];
  if (input.activeCount > 0) {
    parts.push(`${input.activeCount} active ${input.activeCount === 1 ? "Proof" : "Proofs"}`);
  }
  if (input.awaitingEvidenceCount > 0) {
    parts.push(
      `${input.awaitingEvidenceCount} awaiting evidence`,
    );
  } else if (input.readyToFinalizeCount > 0) {
    parts.push(
      `${input.readyToFinalizeCount} ready to finalize`,
    );
  }
  if (input.invitationCount > 0) {
    parts.push(
      `${input.invitationCount} ${input.invitationCount === 1 ? "invitation" : "invitations"}`,
    );
  }
  if (parts.length === 0) {
    return "Nothing needs your attention";
  }
  return parts.join(" · ");
}

export function selectAttention(input: {
  proofs: ProofSummaryLike[];
  invitations: Array<{
    invitationId: string;
    transaction: { itemTitle: string | null };
    inviter: { displayName: string | null; username: string | null };
  }>;
  captureProofId?: string | null;
  captureStatus?: LocalCaptureStatus;
  hasLocalCapture?: boolean;
}): AttentionModel | null {
  const captureProof = input.proofs.find((item) => item.proofId === input.captureProofId);
  if (captureProof && input.hasLocalCapture) {
    const action = deriveNextAction({
      role: captureProof.role,
      proofStatus: captureProof.status,
      committedEvidenceCount: 0,
      captureStatus: input.captureStatus ?? "captured",
      hasLocalCapture: true,
      captureBelongsToProof: true,
      uploadPercent: null,
      offline: false,
    });
    return {
      proofId: captureProof.proofId,
      invitationId: null,
      title: proofTitle(captureProof),
      statusLabel: humanProofStatus({
        proofStatus: captureProof.status,
        captureStatus: input.captureStatus,
        hasLocalCapture: true,
        captureBelongsToProof: true,
      }),
      shipping: shippingSummary({
        carrier: captureProof.transaction.carrier,
        trackingNumber: captureProof.transaction.trackingNumber,
      }),
      cta: action.label || "Continue",
      kind: "proof",
    };
  }

  const actionable = input.proofs.find(
    (item) =>
      item.role === "SELLER" &&
      (item.status === "READY_FOR_EVIDENCE" || item.status === "EVIDENCE_COMMITTED"),
  );
  if (actionable) {
    const action = deriveNextAction({
      role: actionable.role,
      proofStatus: actionable.status,
      committedEvidenceCount: actionable.status === "EVIDENCE_COMMITTED" ? 1 : 0,
      captureStatus: "idle",
      hasLocalCapture: false,
      captureBelongsToProof: false,
      uploadPercent: null,
      offline: false,
    });
    return {
      proofId: actionable.proofId,
      invitationId: null,
      title: proofTitle(actionable),
      statusLabel: humanProofStatus({ proofStatus: actionable.status }),
      shipping: shippingSummary({
        carrier: actionable.transaction.carrier,
        trackingNumber: actionable.transaction.trackingNumber,
      }),
      cta: action.label || "Continue",
      kind: "proof",
    };
  }

  const firstActive = input.proofs.find((item) => item.status !== "FINALIZED");
  if (firstActive) {
    return {
      proofId: firstActive.proofId,
      invitationId: null,
      title: proofTitle(firstActive),
      statusLabel: humanProofStatus({ proofStatus: firstActive.status }),
      shipping: shippingSummary({
        carrier: firstActive.transaction.carrier,
        trackingNumber: firstActive.transaction.trackingNumber,
      }),
      cta: "Continue",
      kind: "proof",
    };
  }

  const invite = input.invitations[0];
  if (invite) {
    return {
      proofId: null,
      invitationId: invite.invitationId,
      title: invite.transaction.itemTitle?.trim() || "PackProof invitation",
      statusLabel: "Pending invitation",
      shipping: "",
      cta: "Review",
      kind: "invitation",
    };
  }

  return null;
}

export function purchaseLine(input: {
  quantity?: number | null;
  transactionValue?: number | null;
  currency?: string | null;
}): string {
  const qty = input.quantity == null ? "" : input.quantity === 1 ? "1 item" : `${input.quantity} items`;
  const money = moneyLabel(input.transactionValue, input.currency);
  return [qty, money].filter(Boolean).join(" • ");
}

export function invitationCardModel(invite: {
  invitationId: string;
  createdAt?: string;
  transaction: { itemTitle?: string | null; externalReference?: string | null };
  inviter?: { displayName?: string | null; username?: string | null };
}): ProofCardModel {
  return {
    proofId: invite.invitationId,
    title: invite.transaction.itemTitle?.trim() || "PackProof invitation",
    orderRef: orderReferenceLabel(invite.transaction.externalReference),
    roleLabel: "Buyer",
    statusLabel: "Invitation received",
    priceLabel: "",
    shipping: invite.inviter?.displayName || invite.inviter?.username ? `From ${invite.inviter.displayName || `@${invite.inviter.username}`}` : "",
    dateLabel: formatDate(invite.createdAt),
    integrity: "none",
    thumbnailUri: null,
  };
}

export function nextActionForProof(input: {
  role: string | null | undefined;
  status: string;
  participationPolicy?: string | null;
  committedEvidenceCount: number;
  captureStatus: LocalCaptureStatus;
  hasLocalCapture: boolean;
  captureBelongsToProof: boolean;
  uploadPercent: number | null;
  offline: boolean;
}): NextAction {
  return deriveNextAction({
    role: input.role,
    proofStatus: input.status,
    participationPolicy: input.participationPolicy,
    committedEvidenceCount: input.committedEvidenceCount,
    captureStatus: input.captureStatus,
    hasLocalCapture: input.hasLocalCapture,
    captureBelongsToProof: input.captureBelongsToProof,
    uploadPercent: input.uploadPercent,
    offline: input.offline,
  });
}
