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
import { submitStationSession } from "../../../mobile/src/packing-station/submit";
import type { StationCandidate, StationEvent, StationState } from "../../../mobile/src/packing-station/types";
import { detectWebScanAdapter } from "../packing-station/scan-adapter";
import { clearStationCapture, recoverStationCapture, saveStationCapture, stationCaptureKey, type PendingStationCapture } from "../capture-queue";

const COMPLETED_HOLD_MS = 1600;

export function PackingStationScreen(props: {
  api: PackProofApi;
  userId: string;
  queue: FulfillmentQueueItem[];
  error: string | null;
  initialReference?: string;
  onAuthExpired: () => void;
  onLeave?: () => void;
}) {
  const [state, dispatch] = useReducer(
    (current: StationState, event: StationEvent | { type: "RESTORE_LOCAL"; state: StationState }) =>
      event.type === "RESTORE_LOCAL" ? event.state : reduceStation(current, event),
    undefined,
    initialStationState,
  );
  const [heldBlob, setHeldBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const orderRef = useRef(state.order);
  const stateRef = useRef(state);
  const heldBlobRef = useRef<Blob | null>(null);
  const bootstrapped = useRef(false);
  const finishingRef = useRef(false);
  const pendingRef = useRef<PendingStationCapture | null>(null);
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
        const url = URL.createObjectURL(pending.file);
        pendingRef.current = pending;
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
        setLocalError("Your packing recording was recovered. Finish saving it without recording again.");
      } else if (!bootstrapped.current) {
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
  }, [props.userId, props.initialReference]);

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

  async function startPacking() {
    setLocalError(null);
    dispatch({ type: "START_RECORDING", trigger: "MANUAL" });
    if (!navigator.mediaDevices?.getUserMedia) {
      fileRef.current?.click();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      chunksRef.current = [];
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm"
          : "";
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorderRef.current = recorder;
      recorder.start();
      dispatch({ type: "RECORDING_STARTED" });
    } catch {
      stopLiveTracks();
      setLocalError("Camera is unavailable. Choose a packing video instead.");
      fileRef.current?.click();
    }
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

  async function finishPacking(trigger: "MANUAL" | "RESCAN" = "MANUAL") {
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
    stopLiveTracks();
    await acceptLiveVideo(blob, blob.type || "video/webm", trigger);
  }

  async function holdCapturedFile(file: Blob, contentType: string) {
    if (file.size < 8) {
      setLocalError("Recording was empty. Start packing again.");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setHeldBlob(file);
    dispatch({
      type: "CAPTURE_HELD",
      capture: {
        handle: url,
        contentType: contentType || "video/webm",
        byteSize: file.size,
        durationMs: null,
      },
    });
    dispatch({ type: "FINISH_SCAN_STARTED" });
    try {
      await preserveStation(file, false);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : "Unable to preserve the recording locally.");
    }
  }

  async function preserveStation(file: Blob, finishConfirmed: boolean) {
    const order = orderRef.current;
    if (!order) throw new Error("Identify the order before saving this recording.");
    const previous = pendingRef.current;
    const pending: PendingStationCapture = {
      key: stationCaptureKey(props.userId), file, order,
      uploadKey: previous?.order.proofId === order.proofId ? previous.uploadKey : newIdempotencyKey(),
      evidenceId: previous?.order.proofId === order.proofId ? previous.evidenceId : undefined,
      finishConfirmed,
    };
    await saveStationCapture(pending);
    pendingRef.current = pending;
    return pending;
  }

  async function acceptLiveVideo(blob: Blob, contentType: string, trigger: "MANUAL" | "RESCAN") {
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
    await processVideo(blob, contentType || "video/webm", capture.handle);
  }

  async function processVideo(blob: Blob, contentType: string, handle: string) {
    const order = orderRef.current;
    if (!order) {
      return;
    }
    setLocalError(null);
    dispatch({ type: "PROCESSING_STARTED", submitStep: "upload" });
    setBusy(true);
    try {
      const pending = await preserveStation(blob, true);
      dispatch({ type: "PROCESSING_STARTED", idempotencyKey: pending.uploadKey, submitStep: "upload" });
      const proof = await props.api.getProof(order.proofId);
      const result = await submitStationSession({
        proof,
        actorUserId: props.userId,
        capture: { handle, contentType, byteSize: blob.size, durationMs: null },
        idempotencyKey: pending.uploadKey,
        evidenceId: pending.evidenceId,
        onEvidenceInitialized: async (evidenceId) => {
          pending.evidenceId = evidenceId;
          await saveStationCapture(pending);
        },
        deps: {
          api: props.api,
          newIdempotencyKey,
          upload: async (target, _capture, onProgress) => {
            onProgress(10);
            await props.api.uploadObject(target, blob, contentType);
            onProgress(100);
          },
        },
        onProgress: (progress) => {
          dispatch({
            type: "PROCESSING_PROGRESS",
            submitStep: progress.step,
            uploadPercent: progress.uploadPercent,
          });
        },
      });
      await clearStationCapture(props.userId);
      pendingRef.current = null;
      setHeldBlob(null);
      setPreviewUrl(null);
      dispatch({ type: "COMPLETED", completion: result.completion });
    } catch (error) {
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
      <p className="station-phase">{phase}</p>
      {state.order ? (
        <div className="station-identity">
          <p className="station-order">{state.order.orderLabel}</p>
          <p className="station-item">{state.order.itemSummary}</p>
          {state.order.trackingHint ? <p className="station-item">{state.order.trackingHint}</p> : null}
        </div>
      ) : (
        <p className="station-copy">Scan a label, pack in frame, then PackProof finishes the record.</p>
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
          Start Packing
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
        <button className="btn btn-secondary station-btn" type="button" disabled={busy && state.phase === "PROCESSING"} onClick={props.onLeave}>
          Leave station
        </button>
      ) : null}

      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        accept="video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) {
            return;
          }
          void holdCapturedFile(file, file.type || "video/mp4");
        }}
      />
    </main>
  );
}

function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `idem_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
