import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { loadCustodyBundle } from "./custody.js";
import { DomainError } from "./errors.js";
import { loadProof } from "./proof-access.js";
import { resolveAccessToken, type ProofAccessLinkRow } from "./access-links.js";
import type { AccessLinkScope } from "./workflow.js";
import { isQualifyingFulfillmentCapture } from "./evidence-types.js";
import { buildProofTracker, type ProofTrackerView } from "./proof-tracker.js";

export interface PublicProofView {
  schema: "packproof.proof.public/v1";
  proofId: string;
  status: string;
  workflowType: string;
  workflowStage: string;
  custodyOutcome: string | null;
  nextAction: { type: string; title: string; hint: string } | null;
  scope: string;
  tracker: ProofTrackerView;
  join: {
    eligible: boolean;
    requiresAuthentication: true;
    message: string;
  };
  assets?: Array<{ label: string; assetType: string }>;
  observations?: Array<{
    label: string;
    occurredAt: string;
    type?: never;
  }>;
  transfers?: Array<{
    status: string;
    intervalNote: string | null;
  }>;
  continuity?: Array<{
    result: string;
    summary: string;
  }>;
  evidence?: Array<{
    slot: string;
    committed: true;
    contentType?: string;
  }>;
}

export async function getPublicProof(
  db: Database,
  clock: Clock,
  token: string,
): Promise<PublicProofView> {
  const link = await resolveAccessToken(db, clock, token);
  return projectPublicProof(db, link);
}

export async function projectPublicProof(
  db: Database,
  link: ProofAccessLinkRow,
): Promise<PublicProofView> {
  const proof = await loadProof(db, link.proof_id);
  const evidence = await db.query<{
    id: string;
    evidence_type: string;
    validation_status: string;
    content_type: string;
  }>(
    `SELECT id, evidence_type, validation_status, content_type FROM evidence WHERE proof_id = $1`,
    [proof.id],
  );
  const attestations = await db.query<{ statement: string; attested_by: string }>(
    `SELECT statement, attested_by FROM attestations WHERE proof_id = $1`,
    [proof.id],
  );
  const custody = await loadCustodyBundle(db, proof, null, {
    committedEvidenceCount: evidence.rows.filter((row) => row.validation_status === "COMMITTED").length,
    packingAttested: attestations.rows.some((row) => row.statement === "PACKED_DESCRIBED_ITEM"),
    fulfillmentCaptureCount: evidence.rows.filter((row) =>
      isQualifyingFulfillmentCapture({
        evidenceType: row.evidence_type,
        validationStatus: row.validation_status,
      }),
    ).length,
  });
  const tracker = await buildProofTracker(db, proof.id);

  const view: PublicProofView = {
    schema: "packproof.proof.public/v1",
    proofId: proof.id,
    status: proof.status,
    workflowType: custody.workflowType,
    workflowStage: custody.policy.workflowStage,
    custodyOutcome: custody.policy.custodyOutcome,
    nextAction: custody.policy.nextAction
      ? {
          type: custody.policy.nextAction.type,
          title: custody.policy.nextAction.title,
          hint: custody.policy.nextAction.hint,
        }
      : null,
    scope: link.scope,
    tracker,
    join: {
      eligible: proof.status !== "FINALIZED",
      requiresAuthentication: true,
      message: "Join PackProof to participate in this Proof.",
    },
  };

  const scope = link.scope as AccessLinkScope;
  if (scope === "STATUS_ONLY") {
    view.tracker = {
      ...tracker,
      reference: null,
      itemTitle: null,
      shipment: null,
      milestones: tracker.milestones.map((milestone) => ({ ...milestone, detail: null })),
    };
    return view;
  }

  view.assets = custody.assets.map((asset) => ({
    label: asset.label,
    assetType: asset.assetType,
  }));
  view.observations = custody.observations.map((observation) => ({
    label: observation.label,
    occurredAt: observation.occurredAt,
  }));
  view.transfers = custody.transfers.map((transfer) => ({
    status: transfer.status === "OPEN" ? "In transit" : "Received",
    intervalNote: transfer.intervalNote,
  }));
  view.continuity = custody.continuity.map((row) => ({
    result: row.result,
    summary: row.summary,
  }));

  if (scope === "EVIDENCE_VIEW") {
    view.evidence = custody.observations.flatMap((observation) =>
      observation.evidence.map((item) => ({
        slot: humanSlot(item.slot),
        committed: true as const,
      })),
    );
  }

  return view;
}

function humanSlot(slot: string): string {
  switch (slot) {
    case "FRONT":
    case "ITEM_FRONT":
      return "Front";
    case "BACK":
    case "ITEM_BACK":
      return "Back";
    case "PACKING_VIDEO":
      return "Packing";
    case "LABEL_CAPTURE":
      return "Label";
    case "PACKAGE":
      return "Package";
    default:
      return "Capture";
  }
}

export function assertGuestCannotMutate(): never {
  throw new DomainError(
    "PARTICIPANT_NOT_AUTHORIZED",
    "A viewing link cannot change this Proof",
    403,
  );
}
