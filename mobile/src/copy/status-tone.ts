export type StatusTone = "neutral" | "info" | "success" | "warning" | "error";

export function statusTone(label: string): StatusTone {
  const value = label.trim().toLowerCase();
  if (/\b(failed|error|could not|unable)\b/.test(value)) return "error";
  if (/\b(needed|required|offline|interrupted|attention|retry|exception)\b/.test(value) || value === "finish saving") return "warning";
  if (/\b(pending|waiting|awaiting|not|no)\b/.test(value)) return "neutral";
  if (/\b(saved|completed|secured|delivered|sealed|finalized)\b/.test(value) || value === "attestation recorded" || value === "connected") return "success";
  if (/\b(recording|packing|uploading|securing|finishing)\b/.test(value) && value !== "recording ready") return "info";
  return "neutral";
}
