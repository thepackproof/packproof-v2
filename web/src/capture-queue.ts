import { randomId } from "./random-id";
import { resumeStationStudy } from "./analytics/study-capture";
import { requiresDurableReceipts } from "./capture-preflight";
import { submitStationSession, type StationSubmitResult } from "../../mobile/src/packing-station/submit";
import type { SubmitStep } from "../../mobile/src/packing-station/types";
import type { PackProofApi } from "./api/client";
import type { StationOrderContext } from "../../mobile/src/packing-station/types";

export type PendingCapture = {
  kind?: "generic" | "archived";
  apiScope?: string;
  stageId?: string;
  finalized?: boolean;
  submitted?: boolean;
  key: string;
  file: File;
  digest: string;
  uploadKey: string;
  evidenceId?: string;
  uploadReceived?: boolean;
  userId?: string;
  proofId?: string;
  slot?: string;
  evidenceType?: string;
  committed?: boolean;
  errorMessage?: string;
  preserved?: boolean;
  attempts?: number;
  nextAttemptAt?: number;
  retryStopped?: boolean;
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
const journalWrites = new Map<string, Promise<void>>();
function serializeJournalWrite(key: string, write: () => Promise<void>): Promise<void> {
  const previous = journalWrites.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => withBrowserLock(`journal:${key}`, write));
  journalWrites.set(key, current);
  return current.finally(() => { if (journalWrites.get(key) === current) journalWrites.delete(key); });
}

export const captureQueueKey = (userId: string, proofId: string, slot: string) =>
  `${userId}:${proofId}:${slot}`;
export async function recoverCapture(key: string): Promise<File | null> {
  return (
    (await queue<PendingCapture | undefined>("readonly", (store) => store.get(key)))?.file ?? null
  );
}

export type PendingStationCapture = {
  /** Opaque local timing journal reference; never sent with capture/evidence data. */
  studyTaskRef?: string;
  shippingScans?: Array<{rawValue:string;format:string;detectedAtMs:number;idempotencyKey:string;status:string;trackingNumber?:string}>;
  kind?: "station";
  committed?: boolean;
  preserved?: boolean;
  userId?: string;
  apiScope?: string;
  digest?: string;
  attempts?: number;
  nextAttemptAt?: number;
  retryStopped?: boolean;
  errorMessage?: string;
  key: string;
  file: Blob;
  order: StationOrderContext;
  uploadKey: string;
  evidenceId?: string;
  finishConfirmed: boolean;
  captureSessionId?: string;
  bookmarks?: Array<{id:string;label:string;startMs:number;sourceType:"USER_MARKED"|"SCANNER_TRIGGERED";recipeVersion?:string}>;
  durationMs?: number;
  interrupted?: boolean;
};
export const stationCaptureKey = (userId: string) => `${userId}:station`;
export async function recoverStationCapture(userId: string): Promise<PendingStationCapture | null> {
  return (await queue<PendingStationCapture | undefined>("readonly", (store) =>
    store.get(stationCaptureKey(userId)),
  )) ?? null;
}
export async function saveStationCapture(capture: PendingStationCapture): Promise<void> {
  return serializeJournalWrite(capture.key, async () => {
  if (!capture.file.size || capture.file.size > 250_000_000)
    throw new Error("Choose a recording between 1 byte and 250 MB.");
  const previous = await recoverStationCapture(capture.userId ?? capture.key.slice(0, -":station".length));
  // Once finishing is accepted, a stale UI cannot replace its bytes or erase a known upload identity.
  if (previous && (previous.uploadKey !== capture.uploadKey || (previous.apiScope && capture.apiScope && previous.apiScope !== capture.apiScope)))
    throw new Error("A recording is already saved for the original order and account. Finish it before recording another shipment.");
  if (previous?.uploadKey === capture.uploadKey && previous.finishConfirmed) {
    const existingDigest = previous.digest ?? await fileDigest(previous.file);
    const incomingDigest = await fileDigest(capture.file);
    if (existingDigest !== incomingDigest) throw new Error("Finish the accepted original before replacing this recording.");
    capture = { ...previous, ...capture, digest: existingDigest, evidenceId: previous.evidenceId ?? capture.evidenceId, finishConfirmed: true };
  }
  capture = { ...capture, shippingScans: mergeStationScans(previous?.shippingScans, capture.shippingScans) };
  await queue("readwrite", (store) => store.put({ ...capture, kind: "station" }));

  });
}
/** Late barcode responses can update only their original, still-pending capture. */
export async function updateStationCaptureScans(userId: string, sessionId: string, scans: NonNullable<PendingStationCapture["shippingScans"]>): Promise<void> {
  return serializeJournalWrite(stationCaptureKey(userId), async () => {
    const pending = await recoverStationCapture(userId);
    if (!pending || pending.captureSessionId !== sessionId) return;
    await queue("readwrite", store => store.put({ ...pending, shippingScans: mergeStationScans(pending.shippingScans, scans) }));
  });
}
function mergeStationScans(previous: PendingStationCapture["shippingScans"] = [], incoming: PendingStationCapture["shippingScans"] = []) {
  const priority = (status: string) => status === "BOUND" ? 2 : status === "QUEUED" ? 0 : 1;
  const scans = new Map(previous.map(scan => [scan.idempotencyKey, scan]));
  for (const scan of incoming) {
    const current = scans.get(scan.idempotencyKey);
    if (!current || priority(scan.status) >= priority(current.status)) scans.set(scan.idempotencyKey, scan);
  }
  return [...scans.values()];
}
export async function clearStationCapture(userId: string, uploadKey?: string): Promise<void> {
  return serializeJournalWrite(stationCaptureKey(userId), async () => {
  if (uploadKey && (await recoverStationCapture(userId))?.uploadKey !== uploadKey) return;
  await queue("readwrite", (store) => store.delete(stationCaptureKey(userId)));

  });
}

/** Save bytes before initializing an upload. Retries keep the same evidence ID,
 * including after page reload or a lost commit response. No bearer tokens stored. */
const activeCaptures = new Map<string, Promise<string>>();
export function preserveCapture(
  api: PackProofApi, userId: string, proofId: string, slot: string,
  file: File, evidenceType: string, progress: (value:number)=>void,
): Promise<string> {
  const key = `${api.recoveryScope || ""}:${captureQueueKey(userId, proofId, slot)}`;
  if (!activeCaptures.has(key) && activeJobCount() >= 2) return Promise.reject(uploadBusy());
  const previous = activeCaptures.get(key) ?? Promise.resolve("");
  const current = previous.catch(() => "").then(() => preserveCaptureUnlocked(api,userId,proofId,slot,file,evidenceType,progress));
  activeCaptures.set(key,current);
  void current.finally(() => { if(activeCaptures.get(key)===current) activeCaptures.delete(key); }).catch(()=>{});
  return current;
}
async function preserveCaptureUnlocked(
  api: PackProofApi,
  userId: string,
  proofId: string,
  slot: string,
  file: File,
  evidenceType: string,
  progress: (value: number) => void,
) {
  if (!file.size || file.size > 250_000_000)
    throw new Error("Choose a recording between 1 byte and 250 MB.");
  const key = captureQueueKey(userId, proofId, slot);
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  let pending = await queue<PendingCapture | undefined>("readonly", (store) => store.get(key));
  if (pending?.apiScope && !scopeMatches(pending.apiScope,api)) throw new Error("Open the original account and server to resume this recording.");
  if (pending && pending.digest !== digest) {
    throw new Error("A different recording is already saved for this step. Recover that recording before replacing it.");
  }
  if (!pending) {
    pending = { key, file, digest, uploadKey: randomId(), userId, proofId, slot, evidenceType, apiScope: api.recoveryScope };
    await queue("readwrite", (store) => store.put(pending!));
  }
  const resuming = !!pending.evidenceId;
  if (!pending.evidenceId) {
    const initialized = await api.initializeEvidenceUpload(proofId, {
      contentType: file.type,
      evidenceType,
      idempotencyKey: pending.uploadKey,
      byteSize: file.size,
    });
    pending.evidenceId = initialized.evidenceId;
    pending.uploadReceived = (initialized.upload as typeof initialized.upload & {received?:boolean})?.received === true;
    await queue("readwrite", (store) => store.put(pending!));
  }
  const evidenceId = pending.evidenceId;
  const current = await api.getProof(proofId);
  if (
    !current.evidence.some((e) => e.evidenceId === evidenceId && e.validationStatus === "COMMITTED")
  ) {
    if (resuming) {
      const renewed = await api.initializeEvidenceUpload(proofId,{contentType:file.type,evidenceType,idempotencyKey:pending.uploadKey,byteSize:file.size});
      if (renewed.evidenceId !== evidenceId) throw new Error("Upload recovery returned another recording identity. Your local original was kept.");
      pending.uploadReceived = (renewed.upload as typeof renewed.upload & {received?:boolean})?.received === true;
      await queue("readwrite",store=>store.put(pending!));
    }
    if (!pending.uploadReceived) await api.uploadResumable(proofId, evidenceId, pending.file, progress);
    await api.commitEvidence(proofId, evidenceId);
  }
  pending.committed = true;
  pending.retryStopped = false;
  pending.attempts = 0;
  await queue("readwrite", (store) => store.put(pending!));
  progress(100);
  return evidenceId;
}

export async function listLocalRecordings(userId: string): Promise<PendingCapture[]> {
  const entries = await queue<PendingCapture[]>("readonly", store => store.getAll());
  return entries.filter(entry => entry.userId === userId && !!entry.proofId && !!entry.digest && !("order" in entry) && !(entry.key.includes(":stage:") && "captureSessionId" in entry));
}

export async function archiveReceivedRecording(userId:string, proofId:string, evidenceId:string, file:Blob, preserved=false, context: {stageId?:string;apiScope?:string;finalized?:boolean;submitted?:boolean} = {}):Promise<void> {
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer())),byte=>byte.toString(16).padStart(2,"0")).join("");
  await queue("readwrite",store=>store.put({key:captureQueueKey(userId,proofId,evidenceId),userId,proofId,slot:evidenceId,file,digest,uploadKey:evidenceId,evidenceId,committed:true,preserved,kind:"archived",...context}));
}

/** Restarts accepted upload intents when the signed-in app resumes, independent of its current screen. */
export async function resumeLocalRecordings(api: PackProofApi, userId: string, active: () => boolean): Promise<void> {
  const station = await recoverStationCapture(userId);
  if (station?.finishConfirmed && scopeMatches(station.apiScope, api) && !station.retryStopped && (station.nextAttemptAt ?? 0) <= Date.now() && active()) {
    try { await resumeStationRecording(api, userId, active); } catch { /* Its originating journal contains the next retry or intervention. */ }
  }
  for (const stage of await listStageCaptures(userId)) {
    if (!active()) return;
    if (stage.submitRequested && scopeMatches(stage.apiScope, api) && !stage.retryStopped && (stage.nextAttemptAt ?? 0) <= Date.now())
      try { await resumeStageRecording(api, userId, stage.key, active); } catch { /* Original remains in the stage journal. */ }
  }
  for (const item of await listLocalRecordings(userId)) {
    if (!active()) return;
    if (!scopeMatches(item.apiScope, api) || (item.preserved && item.finalized) || item.retryStopped || (item.nextAttemptAt ?? 0) > Date.now()) continue;
    try {
      if (!item.committed) {
        await preserveCapture(api, userId, item.proofId!, item.slot!, item.file, item.evidenceType!, () => {});
      }
      // Keep local originals until an explicit durable receipt is available.
      // The server recovery view is also queried after lost HTTP responses.
      const status = await api.getRecoveryStatus(item.proofId!);
      const current = await queue<PendingCapture | undefined>("readonly", store => store.get(item.key));
      if (!active() || !current) return;
      current.preserved = Boolean(status.evidence?.some((e: {evidenceId:string;status?:string;receipt?:unknown}) =>
        e.evidenceId === current.evidenceId && e.status === "PRESERVED" && e.receipt));
      const stageStatus = (status as typeof status & { stages?: Array<{stageId:string;status:string;receipt:unknown}> }).stages?.find(stage => stage.stageId === current.stageId);
      current.finalized = current.stageId ? !!(stageStatus?.status === "PRESERVED" && stageStatus.receipt) : status.finalization?.status === "PRESERVED" && !!status.finalization.receipt;
      current.nextAttemptAt = Date.now() + 30_000;
      await queue("readwrite", store => store.put(current));
    } catch (error) {
      if (!active()) return;
      const current = await queue<PendingCapture | undefined>("readonly", store => store.get(item.key));
      if (!current) continue;
      const status = (error as {status?:number}).status;
      if (status === 401) return;
      current.attempts = Math.min((current.attempts ?? 0) + 1, 12);
      current.retryStopped = status != null && status >= 400 && status < 500 && ![408,429].includes(status);
      current.nextAttemptAt = Date.now() + Math.min(300_000, 2000 * 2 ** current.attempts) * (0.8 + Math.random() * 0.4);
      await queue("readwrite", store => store.put(current));
    }
  }
}

export async function removePreservedLocalRecording(userId: string, key: string, api?: PackProofApi): Promise<void> {
  const item = await queue<PendingCapture | undefined>("readonly", store => store.get(key));
  if (!item || item.userId !== userId || !item.preserved || !item.finalized) throw new Error("Keep this local recording until preservation and finalization are confirmed.");
  if (api) {
    if (!scopeMatches(item.apiScope,api)) throw new Error("Open the original account and server to remove this local copy.");
    const status = await api.getRecoveryStatus(item.proofId!);
    const stage = (status as typeof status & {stages?:Array<{stageId:string;status:string;receipt:unknown}>}).stages?.find(stage=>stage.stageId===item.stageId);
    const finalization = item.stageId ? stage : status.finalization;
    if (!status.evidence.some(evidence=>evidence.evidenceId===item.evidenceId&&evidence.status==="PRESERVED"&&evidence.receipt)||finalization?.status!=="PRESERVED"||!finalization.receipt)
      throw new Error("Preservation could not be reconfirmed. Your local original was kept.");
  }
  await queue("readwrite", store => store.delete(key));
}

export type PendingStageCapture = {
  key:string; stageId:string; captureSessionId:string; uploadKey:string; file:Blob; interrupted:boolean;
  userId?:string; proofId?:string; stageType?:string; apiScope?:string; evidenceId?:string; submitRequested?:boolean;
  digest?:string; attempts?:number; nextAttemptAt?:number; retryStopped?:boolean; errorMessage?:string;
  bookmarks:Array<{label:string;startMs:number;sourceType?:string;recipeVersion?:string}>;
};
export const stageCaptureKey=(userId:string,proofId:string,stageType:string)=>`${userId}:${proofId}:stage:${stageType}`;
export async function recoverStageCapture(key:string):Promise<PendingStageCapture|null>{return (await queue<PendingStageCapture|undefined>("readonly",store=>store.get(key)))??null;}
export async function saveStageCapture(capture:PendingStageCapture){
  return serializeJournalWrite(capture.key, async () => {
  if(!capture.file.size||capture.file.size>250_000_000)throw new Error("Choose a recording between 1 byte and 250 MB.");
  const previous=await recoverStageCapture(capture.key);
  if(previous&&(previous.uploadKey!==capture.uploadKey||(previous.apiScope&&capture.apiScope&&previous.apiScope!==capture.apiScope)))throw new Error("Recover the original saved stage before starting another recording.");
  if(previous?.submitRequested){
    const digest=previous.digest??await fileDigest(previous.file);
    if(digest!==await fileDigest(capture.file))throw new Error("An accepted stage original cannot be replaced during retry.");
    capture={...previous,...capture,digest,evidenceId:previous.evidenceId??capture.evidenceId,submitRequested:true};
  }
  await queue("readwrite",store=>store.put(capture));

  });
}
export async function clearStageCapture(key:string){await serializeJournalWrite(key,async()=>{await queue("readwrite",store=>store.delete(key));});}

function scopeMatches(scope: string | undefined, api: PackProofApi): boolean { return !scope || scope === api.recoveryScope; }
function assertCurrent(active: () => boolean): void {
  if (!active()) throw Object.assign(new Error("Sign in to the original account to resume. Your local recording is kept."), { code: "UNAUTHENTICATED", status: 401 });
}
async function fileDigest(file: Blob): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), byte => byte.toString(16).padStart(2,"0")).join("");
}
function retryState(error: unknown, attempts = 0) {
  const value = error as {status?:number;code?:string;message?:string};
  const stopped = (value.status != null && value.status >= 400 && value.status < 500 && ![401,408,429].includes(value.status)) || /CAPTURE_SESSION|CONFIRMATION_REQUIRED/.test(value.code ?? "");
  const count = Math.min(attempts + 1, 12);
  return { attempts:count, retryStopped:stopped, nextAttemptAt:Date.now()+Math.min(300_000,2000*2**count)*(0.8+Math.random()*0.4), errorMessage:value.message || "Your recording is saved. Reconnect and retry." };
}
function uploadBusy(): Error { return Object.assign(new Error("Two recordings are already resuming. This original remains queued."), {code:"UPLOAD_LIMIT",status:429}); }
function activeJobCount(): number { return activeCaptures.size + stationJobs.size + stageJobs.size; }
async function withBrowserLock<T>(key:string, run:()=>Promise<T>):Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks ? await navigator.locks.request(`packproof:${key}`, {mode:"exclusive"}, run) : await run();
}
const stationJobs = new Map<string, Promise<StationSubmitResult>>();
/** The station page and app-level worker join the same accepted operation. No new declaration prompt. */
export function resumeStationRecording(api:PackProofApi,userId:string,active:()=>boolean,onProgress?:(progress:{step:SubmitStep;uploadPercent:number|null})=>void):Promise<StationSubmitResult> {
  const jobKey = `${api.recoveryScope || ""}:${stationCaptureKey(userId)}`;
  const running = stationJobs.get(jobKey); if (running) return running;
  if (activeJobCount() >= 2) return Promise.reject(uploadBusy());
  const job = withBrowserLock(jobKey,async()=>{
    assertCurrent(active);
    const pending = await recoverStationCapture(userId);
    if (!pending || !pending.finishConfirmed) throw Object.assign(new Error("Review the saved recording and confirm finishing first."),{code:"CONFIRMATION_REQUIRED",status:409});
    if (pending.key !== stationCaptureKey(userId) || !scopeMatches(pending.apiScope,api)) throw Object.assign(new Error("Open the original account and server to resume."),{status:403});
    const study = await resumeStationStudy(api, userId, pending.studyTaskRef);
    const studyState = { step: 'upload' as SubmitStep };
    study?.phase('upload');
    if (pending.attempts || pending.evidenceId) study?.event('recovery_started');
    study?.event('upload_pending');
    try {
      assertCurrent(active);
      let proof = await api.getProof(pending.order.proofId); assertCurrent(active);
      if (pending.evidenceId && proof.evidence.some(item=>item.evidenceId===pending.evidenceId&&item.validationStatus==="COMMITTED")) {
        pending.committed = true; await saveStationCapture(pending); assertCurrent(active);
      }
      if (!pending.captureSessionId) throw Object.assign(new Error("This older recording has no direct-capture session. Keep or export its original; record a new eligible session to finish."),{code:"CAPTURE_SESSION_REQUIRED",status:422});
      if (proof.status !== "FINALIZED") {
        for (const scan of pending.shippingScans ?? []) {
          if (scan.status !== "QUEUED") continue;
          const result = await api.bindCaptureShipping(pending.order.proofId, pending.captureSessionId, scan); assertCurrent(active);
          Object.assign(scan, result);
          await updateStationCaptureScans(userId, pending.captureSessionId, [scan]); assertCurrent(active);
        }
        const review = await api.getCaptureShippingReview(pending.order.proofId, pending.captureSessionId); assertCurrent(active);
        if (review.reviewRequired || pending.shippingScans?.some(scan => scan.status === "QUEUED"))
          throw Object.assign(new Error("Review the detected label before submitting. Your recording remains saved in this browser."), { code: "SHIPPING_REVIEW_REQUIRED", status: 409 });
      }
      if (proof.status !== "FINALIZED" && !proof.evidence.some(item=>item.evidenceId===pending.evidenceId&&item.validationStatus==="COMMITTED")) {
        pending.digest ??= await fileDigest(pending.file); assertCurrent(active); await saveStationCapture(pending); assertCurrent(active);
        await api.completeCaptureSession(pending.order.proofId,pending.captureSessionId,{sha256:pending.digest,byteSize:pending.file.size,contentType:pending.file.type,interrupted:pending.interrupted,recordedDurationMs:pending.durationMs}); assertCurrent(active);
      }
      const result = await submitStationSession({
        proof, actorUserId:userId,
        capture:{handle:`local:${pending.uploadKey}`,contentType:pending.file.type,byteSize:pending.file.size,durationMs:pending.durationMs??null,captureSessionId:pending.captureSessionId},
        idempotencyKey:pending.uploadKey,evidenceId:pending.evidenceId,
        onEvidenceInitialized:async evidenceId=>{assertCurrent(active);pending.evidenceId=evidenceId;await saveStationCapture(pending);assertCurrent(active);},
        deps:{
          newIdempotencyKey:()=>pending.uploadKey,
          api:{
            getProof:async id=>{assertCurrent(active);const value=await api.getProof(id);assertCurrent(active);return value;},
            initializeEvidenceUpload:async(id,input)=>{assertCurrent(active);const value=await api.initializeEvidenceUpload(id,{...input,byteSize:pending.file.size});assertCurrent(active);return value;},
            commitEvidence:async(id,evidenceId)=>{assertCurrent(active);const value=await api.commitEvidence(id,evidenceId);assertCurrent(active);return value;},
            createAttestation:async(id,input)=>{assertCurrent(active);const value=await api.createAttestation(id,input);assertCurrent(active);return value;},
            finalizeProof:async id=>{assertCurrent(active);const value=await api.finalizeProof(id);assertCurrent(active);return value;},
          },
          upload:async(target,_capture,progress)=>{
            assertCurrent(active); if ((target as typeof target & {received?:boolean}).received) {progress(100);return;}
            if(!pending.evidenceId)throw new Error("Upload identity is unavailable. Original retained.");
            await api.uploadResumable(pending.order.proofId,pending.evidenceId,pending.file,value=>{assertCurrent(active);progress(value);});assertCurrent(active);
          },
        },onProgress:progress=>{assertCurrent(active);studyState.step=progress.step;study?.phase(progress.step==='finalize'?'finalization':progress.step==='attest'?'confirmation':'upload');onProgress?.(progress);},
      });
      pending.committed = true; await saveStationCapture(pending); assertCurrent(active);
      proof=await api.getProof(pending.order.proofId);assertCurrent(active);
      const recovery=await api.getRecoveryStatus(pending.order.proofId);assertCurrent(active);
      pending.preserved = !!recovery.evidence?.some(item=>item.evidenceId===pending.evidenceId&&item.status==="PRESERVED"&&item.receipt);
      await saveStationCapture(pending); assertCurrent(active);
      const durablyFinalized = !!(pending.preserved && recovery.finalization?.status === "PRESERVED" && recovery.finalization.receipt);
      const requiresDurability = durablyFinalized || await requiresDurableReceipts(api); assertCurrent(active);
      if(proof.status!=="FINALIZED" || (!durablyFinalized && (requiresDurability || !proof.evidence.some(item=>item.evidenceId===pending.evidenceId&&item.validationStatus==="COMMITTED"))))
        throw Object.assign(new Error("Recording received. Preservation in progress. Your local original remains saved."),{code:"PRESERVATION_PENDING",status:503});
      for(const mark of pending.bookmarks??[])try{assertCurrent(active);await api.featureRequest(pending.order.proofId,"signature/anchors","POST",{evidenceId:pending.evidenceId,startMs:mark.startMs,endMs:Math.min(mark.startMs+1000,pending.durationMs||mark.startMs+1000),label:mark.label,sourceType:mark.sourceType,recipeVersion:mark.recipeVersion,idempotencyKey:mark.id});}catch{assertCurrent(active);}
      assertCurrent(active);await archiveReceivedRecording(userId,pending.order.proofId,pending.evidenceId!,pending.file,!!pending.preserved,{apiScope:api.recoveryScope,finalized:durablyFinalized,submitted:true});assertCurrent(active);
      await clearStationCapture(userId,pending.uploadKey);
      if (proof.status === "FINALIZED" && result.completion === "FINALIZED") {
        study?.phase('finalization'); study?.event('server_completed'); study?.end('succeeded');
      } else { study?.suspend(); }
      return result;
    } catch(error) {
      const failure = error as {status?:number;code?:string};
      if (failure.code === "CONFIRMATION_REQUIRED" || studyState.step === "attest") study?.event('consent_failed');
      study?.problem(failure.status === 401 ? 'authentication' : failure.code === "PRESERVATION_PENDING" ? 'provider' : 'network');
      study?.suspend();
      const latest=await recoverStationCapture(userId);
      if(latest?.uploadKey===pending.uploadKey)await saveStationCapture({...latest,...retryState(error,latest.attempts)});
      throw error;
    }
  }).finally(()=>{stationJobs.delete(jobKey);});
  stationJobs.set(jobKey,job);return job;
}

export async function listStageCaptures(userId:string):Promise<PendingStageCapture[]> {
  const entries=await queue<PendingStageCapture[]>("readonly",store=>store.getAll());
  return entries.filter(item=>!!item.stageId&&!!item.captureSessionId&&item.key.startsWith(`${userId}:`)&&item.key.includes(":stage:"));
}
const stageJobs=new Map<string,Promise<string>>();
/** Only an explicit persisted Save intent permits unattended stage upload; finalization remains separate. */
export function resumeStageRecording(api:PackProofApi,userId:string,key:string,active:()=>boolean):Promise<string>{
  const jobKey=`${api.recoveryScope || ""}:${key}`;
  const running=stageJobs.get(jobKey);if(running)return running;
  if(activeJobCount()>=2)return Promise.reject(uploadBusy());
  const job=withBrowserLock(jobKey,async()=>{
    assertCurrent(active);const pending=await recoverStageCapture(key);
    if(!pending||!pending.submitRequested||pending.userId!==userId||!pending.proofId||!scopeMatches(pending.apiScope,api))throw Object.assign(new Error("Review this stage recording before saving."),{code:"CONFIRMATION_REQUIRED",status:409});
    try{
      const proofId=pending.proofId;assertCurrent(active);
      const current=await api.lifecycleRequest<{stages:Array<{stageId:string;evidence:Array<{evidenceId:string;committedAt:string|null}>}>}>(proofId,"");assertCurrent(active);
      if(!pending.evidenceId||!current.stages.find(stage=>stage.stageId===pending.stageId)?.evidence.some(item=>item.evidenceId===pending.evidenceId&&item.committedAt)){
        pending.digest??=await fileDigest(pending.file);assertCurrent(active);await saveStageCapture(pending);assertCurrent(active);
        await api.completeCaptureSession(proofId,pending.captureSessionId,{sha256:pending.digest,byteSize:pending.file.size,contentType:pending.file.type,interrupted:pending.interrupted});assertCurrent(active);
        const initialized=await api.lifecycleRequest<{evidenceId:string;upload:Parameters<PackProofApi["uploadObject"]>[0]&{received?:boolean}}>(proofId,`/stages/${pending.stageId}/evidence`,"POST",{contentType:pending.file.type,byteSize:pending.file.size,idempotencyKey:pending.uploadKey,captureSessionId:pending.captureSessionId});assertCurrent(active);
        pending.evidenceId=initialized.evidenceId;await saveStageCapture(pending);assertCurrent(active);
        if(!initialized.upload.received){await api.uploadObject(initialized.upload,pending.file,pending.file.type);assertCurrent(active);}
        await api.lifecycleRequest(proofId,`/stages/${pending.stageId}/evidence/${pending.evidenceId}/commit`,"POST",{});assertCurrent(active);
      }
      for(const [index,mark]of pending.bookmarks.entries())try{assertCurrent(active);await api.featureRequest(proofId,"signature/anchors","POST",{evidenceId:pending.evidenceId,stageId:pending.stageId,startMs:mark.startMs,endMs:mark.startMs+1,label:mark.label,sourceType:mark.sourceType||"USER_MARKED",recipeVersion:mark.recipeVersion,idempotencyKey:`${pending.uploadKey}-chapter-${index}`});}catch{assertCurrent(active);}
      await archiveReceivedRecording(userId,proofId,pending.evidenceId!,pending.file,false,{stageId:pending.stageId,apiScope:api.recoveryScope});assertCurrent(active);
      await clearStageCapture(key);return pending.evidenceId!;
    }catch(error){const latest=await recoverStageCapture(key);if(latest?.uploadKey===pending.uploadKey)await saveStageCapture({...latest,...retryState(error,latest.attempts)});throw error;}
  }).finally(()=>{stageJobs.delete(jobKey);});stageJobs.set(jobKey,job);return job;
}

export type LocalRecordingSummary={key:string;kind:"ordinary"|"station"|"stage";file:Blob;proofId:string;preserved:boolean;finalized:boolean;submitted?:boolean;committed:boolean;accepted:boolean;errorMessage?:string;retryStopped?:boolean};
export async function listRecoverableRecordings(userId:string,api?:PackProofApi):Promise<LocalRecordingSummary[]>{
  const ordinary=(await listLocalRecordings(userId)).filter(item=>!api||scopeMatches(item.apiScope,api));
  const station=await recoverStationCapture(userId);
  const stages=(await listStageCaptures(userId)).filter(item=>!api||scopeMatches(item.apiScope,api));
  return [
    ...ordinary.map(item=>({key:item.key,kind:"ordinary" as const,file:item.file,proofId:item.proofId!,preserved:!!item.preserved,finalized:!!item.finalized,submitted:!!item.submitted,committed:!!item.committed,accepted:true,errorMessage:item.errorMessage,retryStopped:item.retryStopped})),
    ...(station&&(!api||scopeMatches(station.apiScope,api))?[{key:station.key,kind:"station" as const,file:station.file,proofId:station.order.proofId,preserved:!!station.preserved,finalized:false,committed:!!station.committed,accepted:station.finishConfirmed,errorMessage:station.errorMessage,retryStopped:station.retryStopped}]:[]),
    ...stages.map(item=>({key:item.key,kind:"stage" as const,file:item.file,proofId:item.proofId??item.key.slice(userId.length+1,item.key.lastIndexOf(":stage:")),preserved:false,finalized:false,committed:false,accepted:!!item.submitRequested,errorMessage:item.errorMessage,retryStopped:item.retryStopped})),
  ];
}
