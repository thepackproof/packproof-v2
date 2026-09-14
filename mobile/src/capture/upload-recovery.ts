/** Shared card copy. A server PENDING row never proves an active transfer. */
export function uploadRecoveryPresentation(input: {
  available: boolean | null; active: boolean; offline: boolean; queued?: boolean; saving?: boolean; committed?: boolean;
  accepted?: boolean; failed?: boolean; discarding?: boolean;
}) {
  if (input.discarding) return { title: input.offline ? "Waiting for connection" : "Discarding recording", message: "The recording stays on this device until PackProof closes the incomplete upload.", resume: null, discard: null };
  if (input.saving) return { title: "Saving Proof", message: "Your video has been received. PackProof is finishing the record; you can keep packing.", resume: null, discard: null };
  if (input.committed) return { title: "Recording received", message: "Your recording is saved in this Proof. Finish any remaining confirmation.", resume: "Finish submission", discard: null };
  if (input.available === null) return { title: "Checking saved recording", message: "Checking this device for the original recording.", resume: null, discard: null };
  if (!input.available) return { title: "Upload could not be completed", message: "The original is not available on this device. Resume on the device used to record, or discard the incomplete evidence and record again.", resume: null, discard: "Discard incomplete evidence" };
  if (input.offline) return { title: "Waiting for connection", message: "Your recording is saved on this device. Upload will retry when the connection returns.", resume: "Resume upload", discard: "Discard recording" };
  if (input.active) return { title: "Uploading", message: "Uploading your saved recording. The original stays on this device.", resume: null, discard: null };
  if (input.queued) return { title: "Waiting to upload", message: "Your recording is queued. You can start another Proof.", resume: null, discard: "Discard recording" };
  if (input.accepted === false) return { title: "Recording saved", message: "Review your saved recording before submitting it.", resume: "Review recording", discard: "Discard recording" };
  return { title: input.failed ? "Upload failed" : "Upload interrupted", message: "Your recording is saved on this device. Resume without recording it again.", resume: "Resume upload", discard: "Discard recording" };
}

/** Rebase only app-owned recording paths when an application container moves. */
export function resolveSavedCaptureUri(uri: string, documentDirectory: string): string | null {
  const suffix = uri.match(/(?:^|\/)(packproof-captures\/cap_[A-Za-z0-9_-]{1,91}\/video\.mp4|packproof-evidence-[A-Za-z0-9_-]+\.mp4|packproof-seller-evidence\.mp4)$/)?.[1];
  return suffix ? documentDirectory + suffix : uri.startsWith(documentDirectory) && !uri.includes('/../') ? uri : null;
}
