import { beginBrowserEngine, BrowserCaptureJournal, captureEngineEnabled, type EngineSession } from "../capture/engine";
import { randomId } from "../random-id";
import type { IntakeSnapshot } from '../intake-types';
import {startStationStudy,resumeStationStudy,type StationStudyTimer} from '../analytics/study-capture';
import { RelayStationPanel } from "../components/RelayStationPanel";
import { capturePreflight } from "../capture-preflight";
import { resumeStationRecording } from "../capture-queue";
import { type CaptureBookmark } from "../components/CaptureCoach";
import { useEffect, useReducer, useRef, useState } from "react";
import type { PackProofApi } from "../api/client";
import { ApiError } from "../api/types";
import type { CanonicalProof, FulfillmentQueueItem } from "../api/types";
import { formatOrderLabel, stationContextFromProof, stationErrorFromUnknown } from "../../../mobile/src/packing-station/display";
import {
  initialStationState,
  reduceStation,
} from "../../../mobile/src/packing-station/machine";
import { normalizeStationReference } from "../../../mobile/src/packing-station/scan";
import type { StationCandidate, StationEvent, StationState } from "../../../mobile/src/packing-station/types";
import { recoverStationCapture, saveStationCapture, updateStationCaptureScans, stationCaptureKey, type PendingStationCapture } from "../capture-queue";


export function PackingStationScreen(props: {
  authorizedEngineSession?:EngineSession|null;
  api: PackProofApi;
  userId: string;
  queue: FulfillmentQueueItem[];
  error: string | null;
  initialReference?: string;
  initialProofId?: string;
  acceptedIntakeSnapshot?: IntakeSnapshot | null;
  onIntakeIntentConsumed?: () => void;
  onAuthExpired: () => void;
  onLeave?: () => void;
  onCompleted?: (proofId: string) => void;
  onRecoverProof?: (proofId: string) => void;
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
  const engineRef = useRef<EngineSession|null>(null);
  const engineJournalRef = useRef<BrowserCaptureJournal|null>(null);
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
  const finishJob = useRef<Promise<void> | null>(null);
  const startingRef = useRef(false);
  const submittingRef = useRef(false);
  const reviewRevision = useRef(0);
  const pendingRef = useRef<PendingStationCapture | null>(null);
  const mountedRef = useRef(true);
  const studyTimer=useRef<StationStudyTimer|null>(null);
  const studyStart = useRef<Promise<StationStudyTimer | null> | null>(null);
  const studyScope = useRef(`${props.api.recoveryScope}:${props.userId}`);
  studyScope.current = `${props.api.recoveryScope}:${props.userId}`;
  useEffect(()=>()=>{studyTimer.current?.suspend();studyTimer.current=null;studyStart.current=null;},[props.api,props.userId]);
  async function beginStudy() {
    if (studyTimer.current) return studyTimer.current;
    const scope = studyScope.current;
    const promise = studyStart.current ?? startStationStudy(props.api, props.userId);
    studyStart.current = promise;
    const timer = await promise;
    if (!mountedRef.current || studyScope.current !== scope) { timer?.suspend(); return null; }
    studyTimer.current = timer;
    if (studyStart.current === promise) studyStart.current = null;
    return timer;
  }
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  orderRef.current = state.order;
  stateRef.current = state;
  heldBlobRef.current = heldBlob;
  const [cameraReady, setCameraReady] = useState(false);
  const intakeStarted=useRef(false);
  const intakeSnapshot=useRef(props.acceptedIntakeSnapshot);
  const intakeRetryKey=useRef(randomId());
  // This intent exists only after the user presses Record on the ready-order card.
  useEffect(()=>{
    if(props.acceptedIntakeSnapshot && !intakeStarted.current && cameraReady && !busy && state.phase==='READY_TO_RECORD' && state.order?.proofId===props.acceptedIntakeSnapshot.proofId){
      intakeStarted.current=true;
      props.onIntakeIntentConsumed?.();
      void startPacking();
    }
  },[cameraReady,busy,state.phase,state.order?.proofId,props.acceptedIntakeSnapshot]);
  const preparingCamera = useRef(false);
  const [elapsed, setElapsed] = useState(0);
  const [confirmed, setConfirmed] = useState(false);
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [labelNotice, setLabelNotice] = useState("");
  const acceptedCodes = useRef(new Set<string>());
  const candidateCodes = useRef(new Map<string, { count:number; time:number }>());
  const scanRequests = useRef<Promise<unknown>>(Promise.resolve());
  const [shippingReview, setShippingReview] = useState<Awaited<ReturnType<PackProofApi["getCaptureShippingReview"]>> | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const scanResultsRef = useRef<NonNullable<PendingStationCapture["shippingScans"]>>([]);
  const [scanResults, setScanResults] = useState<Array<{rawValue:string;format:string;detectedAtMs:number;idempotencyKey:string;status:string;trackingNumber?:string}>>([]);


  function updateScans(updater: (rows: NonNullable<PendingStationCapture["shippingScans"]>) => NonNullable<PendingStationCapture["shippingScans"]>) {
    const next = updater(scanResultsRef.current).map(scan => {
      const current = scanResultsRef.current.find(row => row.idempotencyKey === scan.idempotencyKey);
      return current?.status === "BOUND" && scan.status !== "BOUND" ? current : scan;
    });
    scanResultsRef.current = next;
    setScanResults(next);
    reviewRevision.current += 1;
    setShippingReview(null);
    const sessionId = captureSessionRef.current;
    engineJournalRef.current?.recordScans(next);
    if (sessionId) journalRef.current = journalRef.current.then(() => updateStationCaptureScans(props.userId, sessionId, next)).catch(() => {
      if (mountedRef.current) setLocalError("Label details could not be saved locally. Keep this page open and retry before leaving.");
    });
  }
  const candidates: StationCandidate[] = props.queue
    .filter((item) => !savedIds.has(item.proofId) && item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT")
    .map((item) => ({
      proofId: item.proofId,
      transactionId: item.transactionId,
      orderLabel: formatOrderLabel(item.externalReference || item.externalOrderId),
      itemSummary: item.itemSummary,
    }));

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void recoverStationCapture(props.userId,props.api.recoveryScope).then(async (pending) => {
      if (cancelled) return;
      if (pending) {
        if(pending.captureContext)engineRef.current={id:pending.captureSessionId!,state:"RECORDED",context:pending.captureContext};
        if (pending.apiScope && pending.apiScope !== props.api.recoveryScope) throw new Error("A recording is saved for the original server. Return there to finish it before starting another shipment.");
        if (props.initialProofId && pending.order.proofId !== props.initialProofId && props.onRecoverProof) { props.onRecoverProof(pending.order.proofId); return; }
        studyTimer.current = await resumeStationStudy(props.api, props.userId, pending.studyTaskRef);
        if (cancelled) { studyTimer.current?.suspend(); return; }
        studyTimer.current?.event('recovery_started');
        studyTimer.current?.phase(pending.finishConfirmed ? 'upload' : 'confirmation');
        studyTimer.current?.event('review_opened');
        const url = URL.createObjectURL(pending.file);
        pendingRef.current = pending;
        captureSessionRef.current = pending.captureSessionId;
        interruptedRef.current=!!pending.interrupted;
        scanResultsRef.current = pending.shippingScans ?? [];
        setScanResults(scanResultsRef.current);
        setBookmarks(pending.bookmarks || []);
        durationRef.current = pending.durationMs || 0;
        setHeldBlob(pending.file);
        setPreviewUrl(url);
        dispatch({ type: "RESTORE_LOCAL", state: {
          ...initialStationState(),
          phase: "RECOVERY",
          order: pending.order,
          capture: { handle: url, contentType: pending.file.type, byteSize: pending.file.size, durationMs: null },
          evidenceIdempotencyKey: pending.uploadKey,
          canRetry: pending.finishConfirmed,
        } });
        setLocalError(pending.interrupted ? "Recording was interrupted. The recovered segment may be incomplete. Review it before saving; any missing footage remains missing." : "Your packing recording was recovered. Finish saving it without recording again.");
      } else if (!bootstrapped.current) {
        if (props.initialProofId) {
          bootstrapped.current = true;
          const timer = await beginStudy();
          if (cancelled) { timer?.suspend(); return; }
          timer?.event('order_selected');
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
    const warn = (event: BeforeUnloadEvent) => {
      if (recorderRef.current?.state !== "recording") return;
      event.preventDefault(); event.returnValue = "";
    };
    const interrupt = () => { if (recorderRef.current?.state === "recording") { interruptedRef.current=true; void finishPacking("MANUAL",false); } };
    window.addEventListener("beforeunload",warn);
    window.addEventListener("pagehide",interrupt);
    return () => { window.removeEventListener("beforeunload",warn);window.removeEventListener("pagehide",interrupt);interrupt(); if (!finishJob.current) stopLiveTracks(); };
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
    setCameraReady(false);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }

  async function identify(method: "SCAN" | "REFERENCE" | "QUEUE_SELECT", reference: string, transactionId?: string) {
    setLocalError(null);
    setBusy(true);
    (await beginStudy())?.event('order_selected');
    dispatch({ type: "IDENTIFY_STARTED", method, reference });
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
      studyTimer.current?.problem('network');
      dispatch({ type: "IDENTIFY_FAILED", error: stationErrorFromUnknown(error) });
    } finally {
      setBusy(false);
    }
  }

  async function loadShippingReview() {
    const proofId=orderRef.current?.proofId,sessionId=captureSessionRef.current,revision=reviewRevision.current;
    if(!proofId || !sessionId) return;
    setReviewLoading(true);
    try {
      const review = await props.api.getCaptureShippingReview(proofId,sessionId);
      if (mountedRef.current && revision === reviewRevision.current && sessionId === captureSessionRef.current) setShippingReview(review);
    } catch { if (mountedRef.current && revision === reviewRevision.current) {setLocalError("Label review couldn’t load. Your recording is kept; try again before submitting.");setShippingReview(null);} }
    finally { if (mountedRef.current && revision === reviewRevision.current) setReviewLoading(false); }
  }
  useEffect(()=>{if(heldBlob && state.phase==="RECOVERY") void loadShippingReview();},[heldBlob,state.phase]);
  async function prepareCamera() {
    if (preparingCamera.current || streamRef.current || !orderRef.current || pendingRef.current) return;
    const proofId = orderRef.current.proofId;
    preparingCamera.current = true;
    try {
      await beginStudy();
      await capturePreflight(props.api, true);
      if (!mountedRef.current || stateRef.current.phase !== "READY_TO_RECORD" || orderRef.current?.proofId !== proofId) return;
      const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:"environment" }, audio:false });
      if (!mountedRef.current || stateRef.current.phase !== "READY_TO_RECORD" || orderRef.current?.proofId !== proofId) { stream.getTracks().forEach(t => t.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCameraReady(true);
    } catch (error) { studyTimer.current?.problem('capability'); stopLiveTracks(); setLocalError(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow camera access in your browser settings, then try again." : error instanceof Error ? error.message : "The camera couldn’t open. Try again."); }
    finally { preparingCamera.current = false; }
  }
  useEffect(() => { if (state.phase === "READY_TO_RECORD") { setConfirmed(false); scanResultsRef.current=[]; setScanResults([]); setShippingReview(null); setElapsed(0); setLabelNotice(""); acceptedCodes.current.clear(); candidateCodes.current.clear(); void prepareCamera(); } }, [state.phase, state.order?.proofId]);
  useEffect(() => {
    if (state.phase !== "RECORDING") return;
    const timer = window.setInterval(() => setElapsed(Math.max(0, Math.round((performance.now()-startedAt.current)/1000))),500);
    return () => clearInterval(timer);
  },[state.phase]);
  useEffect(() => {
    if (state.phase !== "RECORDING") return;
    type Detected = { rawValue:string; format:string };
    const Detector = (globalThis as unknown as {BarcodeDetector?:new(input:{formats:string[]})=>{detect:(video:HTMLVideoElement)=>Promise<Detected[]>}}).BarcodeDetector;
    if (!Detector) { setLabelNotice("This browser cannot read labels automatically. Your video still records the label you show."); return; }
    let detector:InstanceType<NonNullable<typeof Detector>>;
    try { detector = new Detector({formats:["code_128","code_39","itf","pdf417","data_matrix","qr_code"]}); }
    catch { setLabelNotice("Automatic label reading is unavailable in this browser."); return; }
    let active = true, analyzing = false;
    const timer = window.setInterval(async () => {
      if(analyzing || !videoRef.current?.videoWidth || document.hidden || acceptedCodes.current.size >= 8) return;
      analyzing = true;
      try {
        const codes = await detector.detect(videoRef.current);
        if(!active) return;
        for(const code of codes) {
          const normalized = code.rawValue.replace(/[ \t\r\n-]/g,"").toUpperCase();
          if(!/^[A-Z0-9]{10,26}$/.test(normalized) || !/\d/.test(normalized) || acceptedCodes.current.has(normalized)) continue;
          const now=performance.now(), prior=candidateCodes.current.get(normalized);
          const count=prior && now-prior.time<1800 ? prior.count+1 : 1;
          candidateCodes.current.set(normalized,{count,time:now});
          if(count<3) continue;
          acceptedCodes.current.add(normalized);
          studyTimer.current?.event('label_read');
          const scan={rawValue:code.rawValue,format:code.format.toUpperCase(),detectedAtMs:Math.round(now-startedAt.current),idempotencyKey:randomId()};
          setLabelNotice("Label code read · check it when you review");
          const proofId=orderRef.current?.proofId,sessionId=captureSessionRef.current;
          if(!proofId || !sessionId) continue;
          updateScans(rows => [...rows, { ...scan, status: "QUEUED" }]);
          scanRequests.current=scanRequests.current.then(async()=>{
            try {
              const result=await props.api.bindCaptureShipping(proofId,sessionId,scan);
              if (result.status === "CONFLICT") studyTimer.current?.event('label_mismatch');
              if (mountedRef.current && captureSessionRef.current === sessionId) {
                updateScans(rows=>rows.map(row=>row.idempotencyKey===scan.idempotencyKey?{...scan,...result}:row));
                setLabelNotice(result.status === "BOUND" ? "Tracking number read" : result.status === "UNRECOGNIZED" ? "This code wasn’t recognized as shipping tracking." : "Label read · review its tracking before submitting");
                if (heldBlobRef.current) void loadShippingReview();
              } else await updateStationCaptureScans(props.userId,sessionId,[{...scan,...result}]);
            }
            catch { if(mountedRef.current) { setReviewLoading(false); setLabelNotice("Label read. Its details still need to finish saving."); } }
          });
        }
      } catch { if(active) setLabelNotice("Label reading paused. Your recording is continuing."); }
      finally {analyzing=false;}
    },450);
    return ()=>{active=false;clearInterval(timer);};
  },[state.phase,props.api]);

  async function startPacking(onSessionIssued?:(id:string)=>void) {
    if (startingRef.current || busy || recorderRef.current?.state === "recording" || !orderRef.current) return;
    if(pendingRef.current||heldBlobRef.current){setLocalError("Finish saving the recovered original before starting another recording.");return;}
    if(stateRef.current.phase!=="READY_TO_RECORD")return;
    const order = orderRef.current;
    const stillReady = () => mountedRef.current && stateRef.current.phase === "READY_TO_RECORD" && orderRef.current?.proofId === order.proofId;
    let issuedSessionId: string | null = null;
    let recordingStarted = false;
    startingRef.current=true;
    setBusy(true); setLocalError(null);
    await beginStudy();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      studyTimer.current?.problem('capability');
      setLocalError("This browser cannot record packing. Open PackProof on a supported phone and sign in to the same account. Your order is preserved."); setBusy(false); startingRef.current=false; return;
    }
    try {
      const capabilities = await capturePreflight(props.api, true);
      if (!stillReady()) return;
      const stream = streamRef.current ?? await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!stillReady()) { stream.getTracks().forEach(track => track.stop()); return; }
      streamRef.current = stream;
      const snapshot=intakeSnapshot.current;
      const usesIntakeSnapshot=!!snapshot && snapshot.proofId===order.proofId;
      const authorizeIntakeCapture=async()=> (await props.api.intakeRequest<{session:{id:string;state:string}}>('/orders/'+encodeURIComponent(snapshot!.id)+'/capture','POST',{idempotencyKey:intakeRetryKey.current,client:'WEB_CAMERA'})).session;
      engineRef.current = props.authorizedEngineSession ?? (captureEngineEnabled() ? await beginBrowserEngine(props.api,order.proofId) : null);
      if(engineRef.current&&engineRef.current.context.proofId!==order.proofId)throw new Error("Open the original order for this capture link.");
      let session = engineRef.current ?? (usesIntakeSnapshot
        ? await authorizeIntakeCapture()
        : await props.api.createCaptureSession(order.proofId, newIdempotencyKey()));
      if(usesIntakeSnapshot && session.state==='CANCELLED') {
        // A cancellation may have succeeded even when its response was lost.
        // The authoritative replay confirms cancellation; this explicit Record
        // action may now issue a fresh key, once, for the same accepted snapshot.
        intakeRetryKey.current=randomId();
        session=await authorizeIntakeCapture();
      }
      if(session.state!=='ISSUED')throw new Error('This order already has a recording. Recover it before recording again.');
      issuedSessionId = session.id;
      if (!stillReady()) { stopLiveTracks(); return; }
      captureSessionRef.current = session.id;
      onSessionIssued?.(session.id);
      interruptedRef.current=false;
      chunksRef.current = []; setBookmarks([]); durationRef.current = 0; pendingRef.current = null;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (!stillReady()) { stopLiveTracks(); return; }
      const mime = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 2_000_000 });
      engineJournalRef.current = engineRef.current ? new BrowserCaptureJournal(props.api.recoveryScope,props.userId,engineRef.current.context,{
        key:stationCaptureKey(props.userId),order,userId:props.userId,apiScope:props.api.recoveryScope,uploadKey:newIdempotencyKey(),captureSessionId:session.id,finishConfirmed:false,
      }) : null;
      await engineJournalRef.current?.start();
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        chunksRef.current.push(event.data);
        const partial = new Blob(chunksRef.current, {type: recorder.mimeType || "video/webm"});
        durationRef.current = Math.max(1, Math.round(performance.now()-startedAt.current));
        if(engineJournalRef.current) {
          engineJournalRef.current.append(event.data,durationRef.current);
          journalRef.current=engineJournalRef.current.flush().catch(()=>{
            interruptedRef.current=true;
            setLocalError("Browser storage is full. Keep this page open and save the original recording.");
            if(recorder.state==='recording')recorder.stop();
          });
        } else journalRef.current = journalRef.current.then(async () => { await preserveStation(partial, false, true); }).catch(() => { setLocalError("Browser storage is full. Keep this page open and save the recording before leaving."); });
        if (partial.size > capabilities.capture.maxBytes * 0.92 || durationRef.current >= capabilities.capture.maxDurationSeconds * 1000) {
          setLocalError("Recording reached this device’s safe limit. Saving the recorded segment now.");
          if (!finishingRef.current) { finishingRef.current = true; interruptedRef.current = true; void finishPacking("MANUAL", false); }
        }
      };
      recorder.onerror = () => { studyTimer.current?.problem('capability'); interruptedRef.current=true; setLocalError("Camera recording was interrupted. Saved segments remain available on this device."); if (!finishingRef.current) { finishingRef.current = true; interruptedRef.current = true; void finishPacking("MANUAL", false); } };
      recorderRef.current = recorder; startedAt.current = performance.now();
      recorder.onstart = () => { studyTimer.current?.phase('recording'); studyTimer.current?.event('recording_started'); };
      dispatch({type:"START_RECORDING",trigger:"MANUAL"}); recorder.start(2000); recordingStarted = true; dispatch({type:"RECORDING_STARTED"});
      return session.id;
    } catch (error) {
      studyTimer.current?.problem('capability');
      stopLiveTracks();
      setLocalError(error instanceof DOMException && error.name === "NotAllowedError" ? "Allow camera access in your browser’s site settings, then retry. No recording has been uploaded." : error instanceof Error ? error.message : "Camera unavailable. Check that another app is not using it, then retry camera.");
    } finally {
      if (issuedSessionId && !recordingStarted) {
        // Only abandon an unused session. Recorded originals always remain recoverable.
        try {
          const cancellation=await props.api.featureRequest<{cancelled:boolean}>(order.proofId, `capture-sessions/${encodeURIComponent(issuedSessionId)}/cancel`, "POST", {});
          if(cancellation?.cancelled===true)intakeRetryKey.current=randomId();
        } catch { /* Keep the same retry identity until cancellation is confirmed. */ }
      }
      startingRef.current=false;
      if (mountedRef.current) setBusy(false);
    }
  }

  function finishPacking(trigger: "MANUAL" | "RESCAN" = "MANUAL", finishConfirmed = true): Promise<void> {
    if (finishJob.current) return finishJob.current;
    finishingRef.current = true;
    setBusy(true);
    const job = (async () => {
      const recorder = recorderRef.current;
      dispatch({ type: "FINISH_RECORDING", trigger });
      const blob = await new Promise<Blob>((resolve) => {
        const assembled = () => new Blob(chunksRef.current, { type: recorder?.mimeType || "video/webm" });
        if (!recorder || recorder.state === "inactive") { resolve(assembled()); return; }
        recorder.onstop = () => { studyTimer.current?.event('recording_stopped'); resolve(assembled()); };
        recorder.stop();
      });
      await journalRef.current;
      await engineJournalRef.current?.finish();
      stopLiveTracks();
      // Preserve the final original immediately. Carrier-network work never blocks review.
      await acceptLiveVideo(blob, blob.type || "video/webm", trigger, finishConfirmed);
    })().catch(error => {
      if (mountedRef.current) setLocalError(error instanceof Error ? error.message : "The recording could not finish saving. Keep this page open and download the local original.");
    }).finally(() => {
      finishJob.current=null; finishingRef.current=false;
      if (mountedRef.current) setBusy(false);
    });
    finishJob.current=job;
    return job;
  }

  async function preserveStation(file: Blob, finishConfirmed: boolean, interrupted = false) {
    const order = orderRef.current;
    if (!order) throw new Error("Identify the order before saving this recording.");
    const previous = pendingRef.current;
    const pending: PendingStationCapture = {
      key: stationCaptureKey(props.userId), file, order, userId: props.userId, apiScope: props.api.recoveryScope,
      uploadKey: previous?.order.proofId === order.proofId ? previous.uploadKey : newIdempotencyKey(),
      evidenceId: previous?.order.proofId === order.proofId ? previous.evidenceId : undefined,
      shippingScans:scanResultsRef.current,
      studyTaskRef: previous?.studyTaskRef ?? studyTimer.current?.localRef,
      captureContext: engineRef.current?.context,
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
      studyTimer.current?.problem('capability');
      setLocalError("Recording was empty. Start packing again.");
      return;
    }
    const url = URL.createObjectURL(blob);
    setPreviewUrl(url);
    heldBlobRef.current = blob;
    setHeldBlob(blob);
    const capture = {
      handle: url,
      contentType: contentType || "video/webm",
      byteSize: blob.size,
      durationMs: null,
    };
    dispatch({ type: "CAPTURE_READY", capture, trigger });
    await preserveStation(blob, false, interruptedRef.current || !finishConfirmed);
    dispatch({ type:"RESTORE_LOCAL", state:{...stateRef.current,phase:"RECOVERY",capture,canRetry:true,error:null} });
    setConfirmed(false);
    studyTimer.current?.phase('confirmation'); studyTimer.current?.event('review_opened');
    void loadShippingReview();
    finishingRef.current = false;
  }

  async function processVideo(blob: Blob, _contentType: string, _handle: string) {
    const order = orderRef.current;
    if (!order || submittingRef.current || !confirmed || !shippingReview || shippingReview.reviewRequired || reviewLoading || scanResultsRef.current.some(scan=>scan.status === "QUEUED")) return;
    submittingRef.current=true;
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
      // The shared queue ends this task only after canonical FINALIZED success.
      if (result.completion === "FINALIZED") studyTimer.current=null;
      if (!mountedRef.current) return;
      pendingRef.current = null;
      heldBlobRef.current = null;
      setHeldBlob(null);
      setPreviewUrl(null);
      if (result.completion === "FINALIZED") setSavedIds(previous => new Set([...previous, order.proofId]));
      dispatch({ type: "COMPLETED", completion: result.completion });
      if (orderRef.current?.proofId) props.onCompleted?.(orderRef.current.proofId);
    } catch (error) {
      studyTimer.current?.problem(error instanceof ApiError&&error.status===401?'authentication':'network');
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
      submittingRef.current = false;
      setBusy(false);
    }
  }

  async function retry() {
    if (!heldBlob) {
      return;
    }
    if (!studyTimer.current && pendingRef.current?.studyTaskRef)
      studyTimer.current = await resumeStationStudy(props.api, props.userId, pendingRef.current.studyTaskRef);
    studyTimer.current?.phase('confirmation');
    // The checkbox is editable; this explicit submit action confirms the declaration.
    studyTimer.current?.event('consent_confirmed');
    dispatch({ type: "RETRY" });
    await processVideo(heldBlob, heldBlob.type || "video/webm", previewUrl ?? "blob:held");
  }

  return <main className="page packing-page">
    <div className="section-head"><h1 className="page-title">{heldBlob ? "Review recording" : state.order ? state.order.itemSummary : "Pack multiple orders"}</h1></div>
    {state.order ? <p className="meta">{state.order.orderLabel}</p> : <p>Finish one package, then move to the next.</p>}
    {props.error || localError || state.error ? <p role="alert" className="banner banner-error">{state.error?.message || localError || props.error}</p> : null}
    {(state.phase === "READY" || state.phase === "RECOVERY" && !state.capture) ? <div className="order-list">
      {candidates.map(item => <button type="button" className="order-row" key={item.proofId} disabled={busy} onClick={() => void identify("QUEUE_SELECT",item.orderLabel,item.transactionId)}><span className="order-row-copy"><strong>{item.itemSummary}</strong><span>{item.orderLabel}</span></span><span>Ready to pack</span></button>)}
      {!candidates.length ? <p>{savedIds.size ? "You’re caught up" : "No orders ready to pack"}</p> : null}
    </div> : null}
    <video ref={videoRef} className={state.phase === "READY_TO_RECORD" || state.phase === "RECORDING" ? "packing-preview" : "visually-hidden"} muted playsInline autoPlay aria-label="Packing camera preview" />
    {state.phase === "READY_TO_RECORD" ? <><p>Keep the item and package in view as you pack and seal it. Show the shipping label during the recording.</p><button className="btn" type="button" disabled={busy || !cameraReady} onClick={() => void startPacking()}>{busy ? "Preparing…" : "Record packing"}</button>{!cameraReady && localError ? <button className="btn btn-secondary" onClick={() => void prepareCamera()}>Try camera again</button> : null}</> : null}
    {state.phase === "RECORDING" ? <><p role="status">● Recording · {Math.floor(elapsed/60)}:{String(elapsed%60).padStart(2,"0")}</p>{labelNotice ? <p aria-live="polite">{labelNotice}</p> : null}<button className="btn" type="button" disabled={busy} onClick={() => { void finishPacking(); }}>Finish recording</button></> : null}
    {previewUrl && heldBlob ? <div className="stack"><video src={previewUrl} controls playsInline className="packing-preview" aria-label="Recorded packing video" />
      {interruptedRef.current ? <p className="banner">This recording was interrupted. Review what was recorded; missing footage remains missing.</p> : null}
      <p>Recording saved in this browser. Keep this browser’s data until your Proof is saved.</p>
      <p>{scanResults.length ? "Label readings come from the camera preview. Check that the label is visible in the saved recording." : "We couldn’t read a shipping label automatically. Your video has been kept."}</p>
      {scanResults.map(scan => <div className="stack" key={scan.idempotencyKey}><p>{scan.status === "BOUND" ? "Tracking number read" : "Review tracking"} · {scan.trackingNumber || scan.rawValue}</p>{scan.status === "NEEDS_CONFIRMATION" || scan.status === "QUEUED" ? <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => {setBusy(true); void props.api.bindCaptureShipping(state.order!.proofId,captureSessionRef.current!,{...scan,confirmed:true,idempotencyKey:scan.idempotencyKey+":confirmed"}).then(result=>{updateScans(rows=>rows.map(row=>row.idempotencyKey===scan.idempotencyKey?{...scan,...result}:row));void loadShippingReview();}).catch(()=>setLocalError("This label differs from the order, or could not be saved. Keep the recording and review this order before submitting.")).finally(()=>setBusy(false));}}>Use this tracking number</button> : null}</div>)}
      {shippingReview?.observations.filter(observation=>!observation.associated && !observation.resolution).map(observation=><div className="banner" key={observation.observationId}><p>This label differs from the order’s tracking or still needs a decision: {observation.trackingNumber}</p><button className="btn btn-secondary" type="button" disabled={busy} onClick={()=>{if(!window.confirm("Confirm this is another label visible in the video, not the package you are shipping. The observation will remain in your Proof."))return;setBusy(true);void props.api.resolveCaptureShippingObservation(state.order!.proofId,captureSessionRef.current!,observation.observationId).then(()=>loadShippingReview()).catch(()=>setLocalError("The label decision could not be saved. Try again.")).finally(()=>setBusy(false));}}>This is another label in view</button></div>)}
      {!shippingReview ? <button type="button" className="btn btn-secondary" disabled={reviewLoading} onClick={()=>void loadShippingReview()}>Retry label review</button> : null}
      <label className="declaration"><input type="checkbox" checked={confirmed} onChange={e => { setConfirmed(e.target.checked); studyTimer.current?.phase('confirmation'); if (!e.target.checked) studyTimer.current?.event('consent_cancelled'); }} disabled={busy} /><span>The item shown and attached in this Proof is the item I am shipping.</span></label>
      <button className="btn" type="button" disabled={busy || !confirmed || reviewLoading || !shippingReview || shippingReview.reviewRequired || scanResults.some(scan=>scan.status==="QUEUED")} onClick={() => void retry()}>{busy ? "Finishing your Proof…" : "Confirm and submit"}</button>
      <a href={previewUrl} download="packproof-recording.webm">Download local recording</a>
    </div> : null}
    {state.phase === "PROCESSING" ? <p role="status">Finishing your Proof…{state.uploadPercent != null ? ` ${state.uploadPercent}%` : ""}</p> : null}
    {state.phase === "PROOF_CREATED" ? <section className="section stack"><h2>{state.completion === "FINALIZED" ? "Proof saved" : "Recording received"}</h2><p>{state.completion === "FINALIZED" ? "Packing record locked" : "Your Proof still needs attention before it can be locked."}</p><a className="btn" href={`/proofs/${encodeURIComponent(state.order?.proofId || "")}`}>View Proof</a>{state.completion === "FINALIZED" ? <button className="btn btn-secondary" onClick={() => dispatch({type:"RESET"})}>Pack next order</button> : null}</section> : null}
    <details><summary>Remote camera controls</summary><RelayStationPanel api={props.api} userId={props.userId} queue={props.queue} localProofId={state.order?.proofId} localPhase={state.phase} onRole={setRelayRole} start={startPacking} finish={async()=>{await finishPacking();}} selectProof={async(id)=>{if(stateRef.current.phase==="RECORDING"||pendingRef.current)throw new Error("Finish saving the current recording before selecting another order.");(await beginStudy())?.event('order_selected');const proof=await props.api.getProof(id);const context=stationContextFromProof(proof);orderRef.current=context;dispatch({type:"RESTORE_LOCAL",state:{...initialStationState(),phase:"READY_TO_RECORD",order:context}});}}/>{relayRole === "CONTROLLER" ? <p>Recording is controlled on the connected camera.</p> : null}</details>
    {props.onLeave ? <button className="btn btn-tertiary" disabled={busy || state.phase === "RECORDING"} onClick={props.onLeave}>Back to Proof</button> : null}
  </main>;

}

function newIdempotencyKey(): string { return randomId(); }
