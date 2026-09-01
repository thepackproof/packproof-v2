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
import { submitStationSession } from "../../../mobile/src/packing-station/submit";
import type { StationCandidate } from "../../../mobile/src/packing-station/types";

const COMPLETED_HOLD_MS = 1600;

export function PackingStationScreen(props: {
  api: PackProofApi;
  userId: string;
  queue: FulfillmentQueueItem[];
  error: string | null;
  onAuthExpired: () => void;
}) {
  const [state, dispatch] = useReducer(reduceStation, undefined, initialStationState);
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
  orderRef.current = state.order;

  const candidates: StationCandidate[] = props.queue
    .filter((item) => item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT")
    .map((item) => ({
      proofId: item.proofId,
      transactionId: item.transactionId,
      orderLabel: formatOrderLabel(item.externalReference || item.externalOrderId),
      itemSummary: item.itemSummary,
    }));

  useEffect(() => {
    if (state.phase !== "PROOF_CREATED") {
      return;
    }
    const handle = window.setTimeout(() => dispatch({ type: "RESET" }), COMPLETED_HOLD_MS);
    return () => window.clearTimeout(handle);
  }, [state.phase]);

  useEffect(() => {
    return () => stopLiveTracks();
  }, []);

  function stopLiveTracks() {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
  }

  async function identify(method: "REFERENCE" | "QUEUE_SELECT", reference: string, transactionId?: string) {
    setLocalError(null);
    dispatch({ type: "IDENTIFY_STARTED", method, reference });
    setBusy(true);
    try {
      let proof: CanonicalProof;
      let labels: { orderLabel: string; itemSummary: string } | undefined;
      if (transactionId) {
        proof = await props.api.createOrGetProof(transactionId);
        const selected = candidates.find((item) => item.transactionId === transactionId);
        labels = selected
          ? { orderLabel: selected.orderLabel, itemSummary: selected.itemSummary }
          : undefined;
      } else {
        const resolved = await props.api.resolvePackingStation(reference);
        labels = { orderLabel: resolved.orderLabel, itemSummary: resolved.itemSummary };
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
      dispatch({ type: "CAPTURE_CANCELLED" });
      setLocalError("Camera is unavailable. Choose a packing video instead.");
      fileRef.current?.click();
    }
  }

  async function finishPacking() {
    const recorder = recorderRef.current;
    dispatch({ type: "FINISH_RECORDING", trigger: "MANUAL" });
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
    await acceptVideo(blob, blob.type || "video/webm");
  }

  async function acceptVideo(blob: Blob, contentType: string) {
    if (blob.size < 8) {
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
    dispatch({ type: "CAPTURE_READY", capture, trigger: "MANUAL" });
    await processVideo(blob, contentType || "video/webm", capture.handle);
  }

  async function processVideo(blob: Blob, contentType: string, handle: string) {
    const order = orderRef.current;
    if (!order) {
      return;
    }
    const key = state.evidenceIdempotencyKey ?? newIdempotencyKey();
    dispatch({ type: "PROCESSING_STARTED", idempotencyKey: key, submitStep: "upload" });
    setBusy(true);
    try {
      const proof = await props.api.getProof(order.proofId);
      const result = await submitStationSession({
        proof,
        actorUserId: props.userId,
        capture: { handle, contentType, byteSize: blob.size, durationMs: null },
        idempotencyKey: key,
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
      setHeldBlob(null);
      dispatch({ type: "COMPLETED", completion: result.completion });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      const mapped = stationErrorFromUnknown(error);
      dispatch({
        type: "PROCESSING_FAILED",
        error: mapped,
        canRetry: mapped.code !== "PROOF_ALREADY_FINALIZED",
      });
    } finally {
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
        </div>
      ) : (
        <p className="station-copy">Identify an order, pack in frame, then PackProof finishes the record.</p>
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
        className={state.phase === "RECORDING" ? "station-preview" : "visually-hidden"}
        muted
        playsInline
        autoPlay
      />

      {state.phase === "READY" || (state.phase === "RECOVERY" && !state.capture) ? (
        <form
          className="station-identify"
          onSubmit={(event) => {
            event.preventDefault();
            if (state.referenceInput.trim()) {
              void identify("REFERENCE", state.referenceInput);
            }
          }}
        >
          <label className="field">
            <span className="visually-hidden">Order or tracking number</span>
            <input
              value={state.referenceInput}
              onChange={(event) => dispatch({ type: "SET_REFERENCE", reference: event.target.value })}
              placeholder="Order or tracking number"
              autoComplete="off"
            />
          </label>
          <button className="btn station-btn" type="submit" disabled={busy || !state.referenceInput.trim()}>
            Identify order
          </button>
        </form>
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
        <button className="btn station-btn" type="button" onClick={() => void finishPacking()}>
          Finished Packing
        </button>
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

      <input
        ref={fileRef}
        className="visually-hidden"
        type="file"
        accept="video/*"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) {
            dispatch({ type: "CAPTURE_CANCELLED" });
            return;
          }
          void acceptVideo(file, file.type || "video/mp4");
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
