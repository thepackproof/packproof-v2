import { randomId } from "../random-id";
import {startStationStudy,type StationStudyTimer} from '../analytics/study-capture';
import { RelayStationPanel } from "../components/RelayStationPanel";
import { capturePreflight } from "../capture-preflight";
import { resumeStationRecording } from "../capture-queue";
import { CaptureCoach, type CaptureBookmark } from "../components/CaptureCoach";
import { useEffect, useReducer, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import { ApiError } from "../api/types";
import type { CanonicalProof, FulfillmentQueueItem } from "../api/types";
import { formatOrderLabel, stationContextFromProof, stationErrorFromUnknown } from "../../../mobile/src/packing-station/display";
import {
  initialStationState,
  reduceStation,
  stationPhaseLabel,
} from "../../../mobile/src/packing-station/machine";
import { normalizeStationReference } from "../../../mobile/src/packing-station/scan";
import type { StationCandidate, StationEvent, StationState } from "../../../mobile/src/packing-station/types";
import { detectWebScanAdapter } from "../packing-station/scan-adapter";
import { recoverStationCapture, saveStationCapture, stationCaptureKey, type PendingStationCapture } from "../capture-queue";

const COMPLETED_HOLD_MS = 1600;

export function PackingStationScreen(props: {
  api: PackProofApi;
  userId: string;
  queue: FulfillmentQueueItem[];
  error: string | null;
  initialReference?: string;
  initialProofId?: string;
  onAuthExpired: () => void;
  onLeave?: () => void;
}) {
  const [state, dispatch] = useReducer(
    (current: StationState, event: StationEvent | { type: "RESTORE_LOCAL"; state: StationState }) =>
      event.type === "RESTORE_LOCAL" ? event.state : reduceStation(current, event),
    undefined,
    initialStationState,
  );
  const [relayRole,setRelayRole]=useState<"CAMERA"|"CONTROLLER"|null>(null);
  const [heldBlob, setHeldBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureSessionRef = useRef<string | undefined>(undefined);
  const startedAt = useRef(0);
  const interruptedRef=useRef(false);
  const [bookmarks, setBookmarks] = useState<CaptureBookmark[]>([]);
  const bookmarksRef = useRef<CaptureBookmark[]>([]);
  const durationRef = useRef(0);
  const journalRef = useRef<Promise<void>>(Promise.resolve());
  bookmarksRef.current = bookmarks;
  const orderRef = useRef(state.order);
  const stateRef = useRef(state);
  const heldBlobRef = useRef<Blob | null>(null);
  const bootstrapped = useRef(false);
  const finishingRef = useRef(false);
  const pendingRef = useRef<PendingStationCapture | null>(null);
  const mountedRef = useRef(true);
  const studyTimer=useRef<StationStudyTimer|null>(null);
  useEffect(()=>()=>{studyTimer.current?.end('cancelled','cancelled');studyTimer.current=null;},[props.api,props.userId]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  orderRef.current = state.order;
  stateRef.current = state;
  heldBlobRef.current = heldBlob;
  const webScan = detectWebScanAdapter();

  const candidates: StationCandidate[] = props.queue
    .filter((item) => item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT")
    .map((item) => ({
      proofId: item.proofId,
      transactionId: item.transactionId,
      orderLabel: formatOrderLabel(item.externalReference || item.externalOrderId),
      itemSummary: item.itemSummary,
    }));

  useEffect(() => {
    if (state.phase === "PROOF_CREATED" || state.phase === "READY") {
      finishingRef.current = false;
    }
    if (state.phase !== "PROOF_CREATED") {
      return;
    }
    const handle = window.setTimeout(() => dispatch({ type: "RESET" }), COMPLETED_HOLD_MS);
    return () => window.clearTimeout(handle);
  }, [state.phase]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void recoverStationCapture(props.userId).then(async (pending) => {
      if (cancelled) return;
      if (pending) {
        if (pending.apiScope && pending.apiScope !== props.api.recoveryScope) throw new Error("A recording is saved for the original server. Return there to finish it before starting another shipment.");
        const url = URL.createObjectURL(pending.file);
        pendingRef.current = pending;
        captureSessionRef.current = pending.captureSessionId;
        interruptedRef.current=!!pending.interrupted;
        setBookmarks(pending.bookmarks || []);
        durationRef.current = pending.durationMs || 0;
        setHeldBlob(pending.file);
        setPreviewUrl(url);
        dispatch({ type: "RESTORE_LOCAL", state: {
          ...initialStationState(),
          phase: pending.finishConfirmed ? "RECOVERY" : "FINISH_SCANNING",
          order: pending.order,
          capture: { handle: url, contentType: pending.file.type, byteSize: pending.file.size, durationMs: null },
          evidenceIdempotencyKey: pending.uploadKey,
          canRetry: pending.finishConfirmed,
        } });
        setLocalError(pending.interrupted ? "Recording was interrupted. The recovered segment may be incomplete. Review it before saving; any missing footage remains missing." : "Your packing recording was recovered. Finish saving it without recording again.");
      } else if (!bootstrapped.current) {
        if (props.initialProofId) {
          bootstrapped.current = true;
          dispatch({type:"IDENTIFY_STARTED",method:"QUEUE_SELECT",reference:props.initialProofId});
          const proof = await props.api.getProof(props.initialProofId);
          if (!cancelled) dispatch({ type: "IDENTIFY_RESOLVED", context: stationContextFromProof(proof), method: "QUEUE_SELECT" });
          return;
        }
        const reference = normalizeStationReference(props.initialReference);
        if (reference) {
          bootstrapped.current = true;
          await identify("REFERENCE", reference);
        }
      }
    }).catch((error) => {
      if (!cancelled) setLocalError(error instanceof Error ? error.message : "Unable to recover local recording.");
    }).finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [props.userId, props.initialReference, props.initialProofId]);

  useEffect(() => {
    return () => stopLiveTracks();
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  useEffect(() => {
    if (state.phase !== "RECORDING") {
      return;
    }
    if (state.stopTrigger !== "RESCAN" && state.stopTrigger !== "MANUAL") {
      return;
    }
    if (state.capture || finishingRef.current) {
      return;
    }
    finishingRef.current = true;
    void finishPacking(state.stopTrigger);
  }, [state.phase, state.stopTrigger, state.capture]);

  function stopLiveTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  async function identify(method: "SCAN" | "REFERENCE" | "QUEUE_SELECT", reference: string, transactionId?: string) {
    setLocalError(null);
    dispatch({ type: "IDENTIFY_STARTED", method, reference });
    setBusy(true);
    try {
      let proof: CanonicalProof;
      let labels: { orderLabel: string; itemSummary: string; trackingHint?: string | null } | undefined;
      if (transactionId) {
        proof = await props.api.createOrGetProof(transactionId);
        const selected = candidates.find((item) => item.transactionId === transactionId);
        labels = selected
          ? { orderLabel: selected.orderLabel, itemSummary: selected.itemSummary }
          : undefined;
      } else {
        const resolved = await props.api.resolvePackingStation(reference);
        labels = {
          orderLabel: resolved.orderLabel,
          itemSummary: resolved.itemSummary,
          trackingHint: resolved.trackingHint ?? null,
        };
        proof = await props.api.createOrGetProof(resolved.transactionId);
      }
      dispatch({
        type: "IDENTIFY_RESOLVED",
        context: stationContextFromProof(proof, labels),
        method,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      dispatch({ type: "IDENTIFY_FAILED", error: stationErrorFromUnknown(error) });
    } finally {
      setBusy(false);
    }
  }

  async function startPacking(onSessionIssued?:(id:string)=>void) {
    if (busy || recorderRef.current?.state === "recording" || !orderRef.current) return;
    if(pendingRef.current||heldBlobRef.current){setLocalError("Finish saving the recovered original before starting another recording.");return;}
    if(stateRef.current.phase!=="READY_TO_RECORD")return;
    setBusy(true); setLocalError(null);
    studyTimer.current=await startStationStudy(props.api,props.userId);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      studyTimer.current?.end('failed','capability');studyTimer.current=null;
      setLocalError("This browser cannot record packing. Open PackProof on a supported phone and sign in to the same account. Your order is preserved."); setBusy(false); return;
    }
    try {
      const capabilities = await capturePreflight(props.api);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      streamRef.current = stream;
      const session = await props.api.createCaptureSession(orderRef.current.proofId, newIdempotencyKey());
      captureSessionRef.current = session.id;
      onSessionIssued?.(session.id);
      interruptedRef.current=false;
      chunksRef.current = []; setBookmarks([]); durationRef.current = 0; pendingRef.current = null;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      const mime = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 2_000_000 });
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        chunksRef.current.push(event.data);
        const partial = new Blob(chunksRef.current, {type: recorder.mimeType || "video/webm"});
        durationRef.current = Math.max(1, Math.round(performance.now()-startedAt.current));
        journalRef.current = journalRef.current.then(async () => { await preserveStation(partial, false, true); }).catch(() => { setLocalError("Browser storage is full. Keep this page open and save the recording before leaving."); });
        if (partial.size > capabilities.capture.maxBytes * 0.92 || durationRef.current >= capabilities.capture.maxDurationSeconds * 1000) {
          setLocalError("Recording reached this device’s safe limit. Saving the recorded segment now.");
          if (!finishingRef.current) { finishingRef.current = true; interruptedRef.current = true; void finishPacking("MANUAL", false); }
        }
      };
      recorder.onerror = () => { interruptedRef.current=true; setLocalError("Camera recording was interrupted. Saved segments remain available on this device."); if (!finishingRef.current) { finishingRef.current = true; interruptedRef.current = true; void finishPacking("MANUAL", false); } };
      recorderRef.current = recorder; startedAt.current = performance.now();
      studyTimer.current?.phase('recording');
      dispatch({type:"START_RECORDING",trigger:"MANUAL"}); recorder.start(2000); dispatch({type:"RECORDING_STARTED"});
      return session.id;
    } catch (error) {
      studyTimer.current?.end('failed','capability');studyTimer.current=null;
      stopLiveTracks();
      setLocalError(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow camera access in your browser’s site settings, then retry. No recording has been uploaded." : error instanceof Error ? error.message : "Camera unavailable. Check that another app is not using it, then retry camera.");
    } finally { setBusy(false); }
  }

  async function resolveFinishScan(value: string) {
    setLocalError(null);
    const afterDecode = reduceStation(stateRef.current, { type: "FINISH_SCAN_DECODED", value });
    if (afterDecode.phase !== "VERIFYING_FINISH_SCAN") {
      return;
    }
    dispatch({ type: "FINISH_SCAN_DECODED", value });
    setBusy(true);
    try {
      const resolvedView = await props.api.resolvePackingStation(value);
      const resolved = { transactionId: resolvedView.transactionId, proofId: resolvedView.proofId };
      const next = reduceStation(afterDecode, { type: "FINISH_RESOLVED", resolved });
      dispatch({ type: "FINISH_RESOLVED", resolved });
      const blob = heldBlobRef.current;
      if (next.phase === "PROCESSING" && blob) {
        await processHeld(blob);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      dispatch({ type: "FINISH_SCAN_FAILED", error: stationErrorFromUnknown(error) });
    } finally {
      setBusy(false);
    }
  }

  async function finishManually() {
    const next = reduceStation(stateRef.current, { type: "FINISH_MANUAL" });
    dispatch({ type: "FINISH_MANUAL" });
    const blob = heldBlobRef.current;
    if (next.phase === "PROCESSING" && blob) {
      await processHeld(blob);
    }
  }

  async function processHeld(blob: Blob) {
    await processVideo(blob, blob.type || "video/webm", previewUrl ?? "blob:held");
  }

  async function finishPacking(trigger: "MANUAL" | "RESCAN" = "MANUAL", finishConfirmed = true) {
    const recorder = recorderRef.current;
    dispatch({ type: "FINISH_RECORDING", trigger });
    const blob = await new Promise<Blob>((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        resolve(new Blob(chunksRef.current, { type: "video/webm" }));
        return;
      }
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || "video/webm" }));
      };
      recorder.stop();
    });
    await journalRef.current;
    stopLiveTracks();
    await acceptLiveVideo(blob, blob.type || "video/webm", trigger, finishConfirmed);
  }

  async function preserveStation(file: Blob, finishConfirmed: boolean, interrupted = false) {
    const order = orderRef.current;
    if (!order) throw new Error("Identify the order before saving this recording.");
    const previous = pendingRef.current;
    const pending: PendingStationCapture = {
      key: stationCaptureKey(props.userId), file, order, userId: props.userId, apiScope: props.api.recoveryScope,
      uploadKey: previous?.order.proofId === order.proofId ? previous.uploadKey : newIdempotencyKey(),
      evidenceId: previous?.order.proofId === order.proofId ? previous.evidenceId : undefined,
      finishConfirmed, captureSessionId: captureSessionRef.current, bookmarks: bookmarksRef.current, durationMs: durationRef.current, interrupted,
    };
    await saveStationCapture(pending);
    pendingRef.current = pending;
    return pending;
  }

  async function acceptLiveVideo(blob: Blob, contentType: string, trigger: "MANUAL" | "RESCAN", finishConfirmed = true) {
    if (blob.size < 8) {
      finishingRef.current = false;
      dispatch({ type: "CAPTURE_CANCELLED" });
      setLocalError("Recording was empty. Start packing again.");
      return;
    }
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    setHeldBlob(blob);
    const capture = {
      handle: url,
      contentType: contentType || "video/webm",
      byteSize: blob.size,
      durationMs: null,
    };
    dispatch({ type: "CAPTURE_READY", capture, trigger });
    if (!finishConfirmed) {
      studyTimer.current?.end('failed','unknown');studyTimer.current=null;
      try { await preserveStation(blob, false, true); }
      catch (error) { setLocalError(error instanceof Error ? error.message : "Keep this page open to export the recording."); }
      dispatch({ type: "PROCESSING_FAILED", error: { code: "CAPTURE_INTERRUPTED", message: "Recording stopped automatically. Review the saved segment before confirming; missing footage remains missing." }, canRetry: true });
      finishingRef.current = false;
      return;
    }
    await processVideo(blob, contentType || "video/webm", capture.handle);
  }

  async function processVideo(blob: Blob, _contentType: string, _handle: string) {
    const order = orderRef.current;
    if (!order) {
      return;
    }
    setLocalError(null);
    dispatch({ type: "PROCESSING_STARTED", submitStep: "upload" });
    setBusy(true);
    try {
      const pending = await preserveStation(blob, true, interruptedRef.current);
      dispatch({ type: "PROCESSING_STARTED", idempotencyKey: pending.uploadKey, submitStep: "upload" });
      // Both foreground submission and the app-level worker join one serialized accepted intent.
      // PackProofApi is account-bound by App; its old token supplier returns null after an account change.
      const result = await resumeStationRecording(props.api, props.userId, () => true, progress => {
        studyTimer.current?.phase(progress.step==='finalize'?'finalization':progress.step==='attest'?'confirmation':'upload');
        if (mountedRef.current) dispatch({ type: "PROCESSING_PROGRESS", submitStep: progress.step, uploadPercent: progress.uploadPercent });
      });
      studyTimer.current?.end('succeeded');studyTimer.current=null;
      if (!mountedRef.current) return;
      pendingRef.current = null;
      setHeldBlob(null);
      setPreviewUrl(null);
      dispatch({ type: "COMPLETED", completion: result.completion });
    } catch (error) {
      studyTimer.current?.end('failed',error instanceof ApiError&&error.status===401?'authentication':'network');studyTimer.current=null;
      if (!mountedRef.current) return;
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      const mapped = stationErrorFromUnknown(error);
      if (mapped.code === "UNAUTHENTICATED") {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      dispatch({
        type: "PROCESSING_FAILED",
        error: mapped,
        canRetry: mapped.code !== "PROOF_ALREADY_FINALIZED",
      });
    } finally {
      finishingRef.current = false;
      setBusy(false);
    }
  }

  async function retry() {
    if (!heldBlob) {
      return;
    }
    dispatch({ type: "RETRY" });
    await processVideo(heldBlob, heldBlob.type || "video/webm", previewUrl ?? "blob:held");
  }

  const phase = stationPhaseLabel(state);

  return (
    <main className={`station station-${state.phase.toLowerCase()}`}>
      <RelayStationPanel api={props.api} userId={props.userId} queue={props.queue} localProofId={state.order?.proofId} localPhase={state.phase} onRole={setRelayRole} start={startPacking} finish={async()=>{finishingRef.current=true;await finishPacking();}} selectProof={async(id)=>{if(stateRef.current.phase==="RECORDING"||pendingRef.current)throw new Error("Save the camera’s current recording before selecting another order.");const proof=await props.api.getProof(id);const context=stationContextFromProof(proof);orderRef.current=context;dispatch({type:"RESTORE_LOCAL",state:{...initialStationState(),phase:"READY_TO_RECORD",order:context}});}}/>
      {relayRole!=="CONTROLLER"&&<>
      <p className="station-phase">{phase}</p>
      {state.order ? (
        <div className="station-identity">
          <p className="station-order">{state.order.orderLabel}</p>
          <p className="station-item">{state.order.itemSummary}</p>
          {state.order.trackingHint ? <p className="station-item">{state.order.trackingHint}</p> : null}
        </div>
      ) : (
        <p className="station-copy">Choose an order or scan its reference. Record the item, packing, and seal.</p>
      )}
      {props.error || localError || state.error ? (
        <p className="station-error" role="alert">
          {state.error?.message || localError || props.error}
        </p>
      ) : null}
      {state.phase === "PROCESSING" ? (
        <p className="station-copy">
          Saving packing video{state.uploadPercent != null ? ` ${state.uploadPercent}%` : ""}
        </p>
      ) : null}

      <video
        ref={videoRef}
        className={
          state.phase === "RECORDING" ||
          state.phase === "FINISH_SCANNING" ||
          state.phase === "VERIFYING_FINISH_SCAN"
            ? "station-preview"
            : "visually-hidden"
        }
        muted
        playsInline
        autoPlay
      />

      {state.phase === "RECORDING" || state.phase === "READY_TO_RECORD" ? <CaptureCoach video={videoRef} recording={state.phase === "RECORDING"} startedAt={startedAt.current} bookmarks={bookmarks} onBookmark={mark => setBookmarks(old => [...old,mark])} /> : null}
      {previewUrl && heldBlob && state.phase === "RECOVERY" ? <video src={previewUrl} controls playsInline aria-label="Recovered packing recording" /> : null}
      {state.phase === "READY_TO_RECORD" && localError ? <p><a href={`/station?proof=${encodeURIComponent(state.order?.proofId || "")}`}>Continue on your signed-in phone</a> · Open this same order on your phone. Camera access still requires your account.</p> : null}
      {state.phase === "SCANNING" ? (
        <form
          className="station-identify"
          onSubmit={(event) => {
            event.preventDefault();
            const value = normalizeStationReference(state.referenceInput);
            if (!value) {
              return;
            }
            dispatch({ type: "SCAN_DECODED", value });
            void identify("SCAN", value);
          }}
        >
          <p className="station-copy">
            Scan the shipping label or order barcode
            {webScan.kind === "KEYBOARD" ? " with a USB scanner or type the code, then press Enter." : "."}
          </p>
          <label className="field">
            <span className="visually-hidden">Barcode or order reference</span>
            <input
              value={state.referenceInput}
              onChange={(event) => dispatch({ type: "SET_REFERENCE", reference: event.target.value })}
              placeholder="Scan or enter barcode"
              autoComplete="off"
              autoFocus
            />
          </label>
          <button className="btn station-btn" type="submit" disabled={busy || !normalizeStationReference(state.referenceInput)}>
            Use this code
          </button>
          <button className="btn btn-secondary station-btn" type="button" onClick={() => dispatch({ type: "SCAN_CANCELLED" })}>
            Cancel
          </button>
        </form>
      ) : null}

      {state.phase === "READY" || (state.phase === "RECOVERY" && !state.capture) ? (
        <div className="station-identify">
          <button className="btn station-btn" type="button" disabled={busy} onClick={() => dispatch({ type: "SCAN_STARTED" })}>
            Scan Order / Label
          </button>
          <form
            className="station-identify"
            onSubmit={(event) => {
              event.preventDefault();
              const reference = normalizeStationReference(state.referenceInput);
              if (reference) {
                void identify("REFERENCE", reference);
              }
            }}
          >
            <label className="field">
              <span className="visually-hidden">Enter reference</span>
              <input
                value={state.referenceInput}
                onChange={(event) => dispatch({ type: "SET_REFERENCE", reference: event.target.value })}
                placeholder="Enter reference"
                autoComplete="off"
              />
            </label>
            <button className="btn btn-secondary station-btn" type="submit" disabled={busy || !normalizeStationReference(state.referenceInput)}>
              Identify by reference
            </button>
          </form>
        </div>
      ) : null}

      {state.phase === "READY" || (state.phase === "RECOVERY" && !state.capture) ? (
        candidates.length > 0 ? (
          <div className="station-fallback">
            <p className="station-fallback-label">Imported orders</p>
            {candidates.map((item) => (
              <button
                key={item.proofId}
                className="btn btn-secondary station-btn"
                type="button"
                disabled={busy}
                onClick={() => void identify("QUEUE_SELECT", item.orderLabel, item.transactionId)}
              >
                {item.orderLabel} · {item.itemSummary}
              </button>
            ))}
          </div>
        ) : null
      ) : null}

      {state.phase === "READY_TO_RECORD" ? (
        <button className="btn station-btn" type="button" disabled={busy} onClick={() => void startPacking()}>
          {busy ? "Opening camera…" : "Start recording"}
        </button>
      ) : null}

      {state.phase === "RECORDING" ? (
        <div className="station-identify">
          <button
            className="btn station-btn"
            type="button"
            disabled={busy}
            onClick={() => dispatch({ type: "FINISH_SCAN_STARTED" })}
          >
            Scan Package to Finish
          </button>
          <button className="btn btn-secondary station-btn" type="button" disabled={busy} onClick={() => void finishManually()}>
            Finished Packing
          </button>
        </div>
      ) : null}

      {state.phase === "FINISH_SCANNING" || state.phase === "VERIFYING_FINISH_SCAN" ? (
        <form
          className="station-identify"
          onSubmit={(event) => {
            event.preventDefault();
            const value = normalizeStationReference(state.referenceInput);
            if (!value || state.phase !== "FINISH_SCANNING") {
              return;
            }
            void resolveFinishScan(value);
          }}
        >
          <p className="station-copy">
            Scan the same shipping label to finish this pack
            {webScan.kind === "KEYBOARD" ? " with a USB scanner or type the code, then press Enter." : "."}
          </p>
          <label className="field">
            <span className="visually-hidden">Finish barcode or order reference</span>
            <input
              value={state.referenceInput}
              onChange={(event) => dispatch({ type: "SET_REFERENCE", reference: event.target.value })}
              placeholder="Scan or enter barcode"
              autoComplete="off"
              autoFocus
              disabled={busy || state.phase === "VERIFYING_FINISH_SCAN"}
            />
          </label>
          <button
            className="btn station-btn"
            type="submit"
            disabled={busy || state.phase !== "FINISH_SCANNING" || !normalizeStationReference(state.referenceInput)}
          >
            Use this code
          </button>
          <button
            className="btn btn-secondary station-btn"
            type="button"
            onClick={() => dispatch({ type: "FINISH_SCAN_CANCELLED" })}
          >
            Cancel
          </button>
          <button className="btn btn-secondary station-btn" type="button" disabled={busy} onClick={() => void finishManually()}>
            Finished Packing
          </button>
        </form>
      ) : null}

      {state.phase === "RECOVERY" && state.capture ? (
        <button className="btn station-btn" type="button" disabled={busy} onClick={() => void retry()}>
          Retry upload
        </button>
      ) : null}

      {state.phase === "RECOVERY" && !state.capture ? (
        <button className="btn btn-secondary station-btn" type="button" onClick={() => dispatch({ type: "RESET" })}>
          Ready for next order
        </button>
      ) : null}

      {props.onLeave ? (
        <button className="btn btn-secondary station-btn" type="button" disabled={busy || state.phase === "RECORDING"} onClick={props.onLeave}>
          Leave station
        </button>
      ) : null}

      </>}
    </main>
  );
}

function newIdempotencyKey(): string { return randomId(); }
