import type { PackProofApi } from "./api/client";

type PendingCapture = {
  key: string;
  file: File;
  digest: string;
  uploadKey: string;
  evidenceId?: string;
};
async function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("packproof-capture", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("uploads", { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Unable to preserve this recording locally. Check browser storage space."));
  });
}
async function queue<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openQueue();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("uploads", mode),
        request = fn(tx.objectStore("uploads"));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () =>
        reject(new Error("Unable to save the recording. Free browser storage space and retry."));
      tx.onabort = () => reject(new Error("Recording storage was interrupted."));
    });
  } finally {
    db.close();
  }
}
export const captureQueueKey = (userId: string, proofId: string, slot: string) =>
  `${userId}:${proofId}:${slot}`;
export async function recoverCapture(key: string): Promise<File | null> {
  return (
    (await queue<PendingCapture | undefined>("readonly", (store) => store.get(key)))?.file ?? null
  );
}

/** Save bytes before initializing an upload. Retries keep the same evidence ID,
 * including after page reload or a lost commit response. No bearer tokens stored. */
export async function preserveCapture(
  api: PackProofApi,
  userId: string,
  proofId: string,
  slot: string,
  file: File,
  evidenceType: string,
  progress: (value: number) => void,
) {
  if (!file.size || file.size > 200 * 1024 * 1024)
    throw new Error("Choose a recording between 1 byte and 200 MiB.");
  const key = captureQueueKey(userId, proofId, slot);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  let pending = await queue<PendingCapture | undefined>("readonly", (store) => store.get(key));
  if (pending && pending.digest !== digest) {
    const proof = await api.getProof(proofId);
    if (
      !proof.evidence.some(
        (e) => e.evidenceId === pending!.evidenceId && e.validationStatus === "COMMITTED",
      )
    )
      await api.discardUpload(proofId, pending.uploadKey);
    pending = undefined;
  }
  if (!pending) {
    pending = { key, file, digest, uploadKey: crypto.randomUUID() };
    await queue("readwrite", (store) => store.put(pending!));
  }
  if (!pending.evidenceId) {
    const initialized = await api.initializeEvidenceUpload(proofId, {
      contentType: file.type,
      evidenceType,
      idempotencyKey: pending.uploadKey,
    });
    pending.evidenceId = initialized.evidenceId;
    await queue("readwrite", (store) => store.put(pending!));
  }
  const evidenceId = pending.evidenceId;
  const current = await api.getProof(proofId);
  if (
    !current.evidence.some((e) => e.evidenceId === evidenceId && e.validationStatus === "COMMITTED")
  ) {
    await api.uploadResumable(proofId, evidenceId, pending.file, progress);
    await api.commitEvidence(proofId, evidenceId);
  }
  await queue("readwrite", (store) => store.delete(key));
  progress(100);
  return evidenceId;
}
