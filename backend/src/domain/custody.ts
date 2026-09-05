import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { listProofAssets, type ProofAssetView } from "./assets.js";
import { listAssetBindings, type AssetExternalRefView } from "./asset-bindings.js";
import { listContinuityEvaluations, type ContinuityView } from "./continuity.js";
import { listObservations, originDocumentedAssetIds, type ObservationView } from "./observations.js";
import { listTransfers, type TransferView } from "./transfers.js";
import {
  evaluateWorkflowPolicy,
  requireWorkflowType,
  type NextAction,
  type WorkflowPolicyView,
  type WorkflowType,
} from "./workflow.js";
import type { ProofRow } from "./types.js";

export interface CustodyBundle {
  workflowType: WorkflowType;
  assets: ProofAssetView[];
  observations: ObservationView[];
  transfers: TransferView[];
  continuity: ContinuityView[];
  bindings: AssetExternalRefView[];
  policy: WorkflowPolicyView;
}

export async function loadCustodyBundle(
  db: Database,
  proof: ProofRow,
  actorRole: string | null,
  extras: {
    committedEvidenceCount: number;
    packingAttested: boolean;
    fulfillmentCaptureCount: number;
  },
): Promise<CustodyBundle> {
  const workflowType = requireWorkflowType(proof.workflow_type);
  const [assets, observations, transfers, continuity, bindings] = await Promise.all([
    listProofAssets(db, proof.id),
    listObservations(db, proof.id),
    listTransfers(db, proof.id),
    listContinuityEvaluations(db, proof.id),
    listAssetBindings(db, proof.id),
  ]);
  const documentedAssetIds = [...originDocumentedAssetIds(observations)];
  const packedAssetIds = assetIdsOfType(observations, "PACKED");
  const origin = [...observations].find((row) => row.type === "ORIGIN_CAPTURE") ?? null;
  const policy = evaluateWorkflowPolicy({
    workflowType,
    proofStatus: proof.status,
    actorRole,
    assets: assets.map((asset) => ({ id: asset.assetId, labelIndex: asset.labelIndex })),
    documentedAssetIds,
    packedAssetIds,
    originObservationId: origin?.observationId ?? null,
    packed: observations.some((row) => row.type === "PACKED"),
    released: observations.some((row) => row.type === "RELEASED"),
    received: observations.some((row) => row.type === "RECEIVED"),
    intakeCaptured: observations.some((row) => row.type === "INTAKE_CAPTURE"),
    compared: continuity.length > 0,
    processOutput: observations.some((row) => row.type === "PROCESS_OUTPUT"),
    returnPacked: observations.some((row) => row.type === "RETURN_PACKED"),
    finalReceipt: observations.some((row) => row.type === "FINAL_RECEIPT"),
    openTransferId: transfers.find((row) => row.status === "OPEN")?.transferId ?? null,
    committedEvidenceCount: extras.committedEvidenceCount,
    packingAttested: extras.packingAttested,
    fulfillmentCaptureCount: extras.fulfillmentCaptureCount,
  });
  return { workflowType, assets, observations, transfers, continuity, bindings, policy };
}

export function nextActionView(policy: WorkflowPolicyView): NextAction | null {
  return policy.nextAction;
}

function assetIdsOfType(observations: ObservationView[], type: string): string[] {
  const ids = new Set<string>();
  for (const observation of observations) {
    if (observation.type === type) {
      for (const assetId of observation.assetIds) {
        ids.add(assetId);
      }
    }
  }
  return [...ids];
}
