import type { LocalCaptureStatus } from "./status";
import { OFFLINE_CAPTURE_MESSAGE } from "./errors";

export type NextActionKey =
  | "start_capture"
  | "review_recording"
  | "uploading"
  | "securing"
  | "retry_upload"
  | "offline_held"
  | "finalize"
  | "completed"
  | "add_participant"
  | "getting_started"
  | "view_record"
  | "none";

export type NextActionKind = "primary" | "secondary" | "success" | "progress" | "locked";

export interface NextActionInput {
  role: string | null | undefined;
  proofStatus: string | null | undefined;
  committedEvidenceCount: number;
  pendingEvidenceCount?: number;
  captureStatus: LocalCaptureStatus;
  hasLocalCapture: boolean;
  captureBelongsToProof: boolean;
  uploadPercent: number | null;
  offline: boolean;
}

export interface NextAction {
  key: NextActionKey;
  label: string;
  hint: string;
  kind: NextActionKind;
  enabled: boolean;
}

export function deriveNextAction(input: NextActionInput): NextAction {
  const status = input.proofStatus ?? "OPEN";
  const seller = input.role === "SELLER";
  const local = input.captureBelongsToProof && input.hasLocalCapture;
  const committed = input.committedEvidenceCount > 0 || status === "EVIDENCE_COMMITTED";

  if (status === "FINALIZED") {
    return {
      key: "completed",
      label: "Proof completed",
      hint: "This record is sealed. Later carrier observations do not change the finalized evidence.",
      kind: "success",
      enabled: false,
    };
  }

  if (seller && local && input.captureStatus === "uploading") {
    const percent = input.uploadPercent != null ? ` • ${input.uploadPercent}%` : "";
    return {
      key: "uploading",
      label: `Uploading evidence${percent}`,
      hint: "Bytes are transferring. Evidence is not secured until PackProof confirms the commit.",
      kind: "progress",
      enabled: false,
    };
  }

  if (seller && local && input.captureStatus === "uploaded") {
    return {
      key: "securing",
      label: "Securing evidence…",
      hint: "PackProof is confirming this recording. It is not secured until the server confirms.",
      kind: "progress",
      enabled: false,
    };
  }

  if (seller && local && (input.captureStatus === "retry" || input.offline)) {
    return {
      key: input.offline ? "offline_held" : "retry_upload",
      label: input.offline ? "Waiting for connection" : "Try again",
      hint: OFFLINE_CAPTURE_MESSAGE,
      kind: "primary",
      enabled: !input.offline,
    };
  }

  if (seller && local && (input.captureStatus === "captured" || input.captureStatus === "capturing")) {
    return {
      key: "review_recording",
      label: "Review recording",
      hint: "Your recording is saved on this device. It is not Proof evidence until it is secured.",
      kind: "primary",
      enabled: true,
    };
  }

  if (seller && status === "READY_FOR_EVIDENCE" && !committed) {
    return {
      key: "start_capture",
      label: "Start evidence capture",
      hint: "Record the item being packed and sealed.",
      kind: "primary",
      enabled: true,
    };
  }

  if (seller && committed && status !== "FINALIZED") {
    return {
      key: "finalize",
      label: "Finalize PackProof",
      hint: "Review the record, then seal it. This cannot be undone.",
      kind: "primary",
      enabled: true,
    };
  }

  if (seller && (status === "OPEN" || status === "AWAITING_PARTICIPANT")) {
    return {
      key: status === "OPEN" ? "getting_started" : "add_participant",
      label: status === "OPEN" ? "Continue setup" : "Add a participant",
      hint:
        status === "OPEN"
          ? "Add purchase details, then invite the buyer if needed."
          : "Invite the buyer to this PackProof. Joining records participation; it does not confirm the item.",
      kind: "primary",
      enabled: true,
    };
  }

  if (input.role === "BUYER") {
    return {
      key: "view_record",
      label: "View PackProof",
      hint: "This is the shared evidence record. Joining does not confirm the contents of the package.",
      kind: "secondary",
      enabled: false,
    };
  }

  return {
    key: "none",
    label: "",
    hint: "",
    kind: "secondary",
    enabled: false,
  };
}

export function canCaptureEvidence(input: {
  role: string | null | undefined;
  proofStatus: string | null | undefined;
  committedEvidenceCount: number;
  finalized?: boolean;
}): boolean {
  return (
    input.role === "SELLER" &&
    input.proofStatus === "READY_FOR_EVIDENCE" &&
    input.committedEvidenceCount === 0 &&
    input.finalized !== true
  );
}

export function fieldsLocked(proofStatus: string | null | undefined): boolean {
  return proofStatus === "FINALIZED";
}
