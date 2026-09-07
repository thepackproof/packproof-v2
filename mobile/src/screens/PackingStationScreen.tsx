import { completeSavedCapture } from "../capture/completion";
import { captureRecoveryLabel } from "../capture/recovery-model";
import { PressableScale } from "../ui/motion";
import { useEffect, useReducer, useRef, useState } from "react";
import { BackHandler, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { isAuthenticationFailure } from "../copy/errors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SellerAttestation } from "../ui/SellerAttestation";
import {
  localCaptureExists,
  recordPackingEvidence,
  saveCaptureBookmarks,
  type LocalCapture,
} from "../capture";
import {
  formatOrderLabel,
  stationContextFromProof,
  stationErrorFromUnknown,
} from "../packing-station/display";
import {
  initialStationState,
  reduceStation,
  restoreStationState,
  stationPhaseLabel,
} from "../packing-station/machine";
import { normalizeStationReference } from "../packing-station/scan";
import type { StationCandidate, StationState } from "../packing-station/types";
import { PackProofV2Client, newIdempotencyKey, type ProofView } from "../v2-api";
import { BarcodeScanView } from "./BarcodeScanView";

const COMPLETED_HOLD_MS = 1600;

export interface StationPersistSnapshot {
  capture: LocalCapture | null;
  evidenceIdempotencyKey: string | null;
  uploadEvidenceId?: string | null;
  proofId: string | null;
  transactionId: string | null;
  orderLabel: string | null;
  itemSummary: string | null;
  stationActive: boolean;
}

export function PackingStationScreen(props: {
  client: PackProofV2Client;
  apiBaseUrl: string;
  userId: string;
  restoredCapture: LocalCapture | null;
  restoredKey: string | null;
  restoredEvidenceId: string | null;
  restoredProofId: string | null;
  restoredTransactionId: string | null;
  restoredOrderLabel: string | null;
  restoredItemSummary: string | null;
  onPersist: (next: StationPersistSnapshot) => Promise<void>;
  onEnsureAuth: () => Promise<void>;
  onAuthExpired: () => void;
  onLeave: () => void;
}) {
  const [state, dispatch] = useReducer(reduceStation, undefined, () =>
    initialStationForRestore(props),
  );
  const [candidates, setCandidates] = useState<StationCandidate[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [heldCapture, setHeldCapture] = useState<LocalCapture | null>(props.restoredCapture);
  const stateRef = useRef(state);
  const heldCaptureRef = useRef(heldCapture);
  const evidenceIdRef = useRef(props.restoredEvidenceId);
  const mountedRef = useRef(true);
  const contextRef = useRef({ userId: props.userId, client: props.client });
  const actionLock = useRef(false);
  const submitLock = useRef(false);
  const biometricAttestation = Platform.OS === "android";
  stateRef.current = state;
  heldCaptureRef.current = heldCapture;
  contextRef.current = { userId: props.userId, client: props.client };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    void loadCandidates();
  }, [props.client]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (actionLock.current || submitLock.current) return true;
      if (state.phase === "SCANNING") dispatch({ type: "SCAN_CANCELLED" });
      else if (state.phase === "FINISH_SCANNING") dispatch({ type: "FINISH_SCAN_CANCELLED" });
      else void leaveStation();
      return true;
    });
    return () => subscription.remove();
  }, [state.phase, props.onLeave]);

  useEffect(() => {
    if (state.phase !== "PROOF_CREATED") {
      return;
    }
    const handle = setTimeout(() => {
      dispatch({ type: "RESET" });
      void persistFromState(initialStationState(), null);
    }, COMPLETED_HOLD_MS);
    return () => clearTimeout(handle);
  }, [state.phase]);

  async function persistFromState(next: StationState, capture: LocalCapture | null): Promise<void> {
    await props.onPersist({
      capture,
      evidenceIdempotencyKey: next.evidenceIdempotencyKey,
      uploadEvidenceId: capture ? evidenceIdRef.current : null,
      proofId: next.order?.proofId ?? null,
      transactionId: next.order?.transactionId ?? null,
      orderLabel: next.order?.orderLabel ?? null,
      itemSummary: next.order?.itemSummary ?? null,
      stationActive:
        next.phase !== "READY" && next.phase !== "PROOF_CREATED" ? true : Boolean(capture),
    });
  }

  async function loadCandidates(): Promise<void> {
    try {
      const queue = await props.client.listFulfillmentQueue("ready");
      const fromQueue = queue.items
        .filter((item) => item.workflowState !== "COMPLETED")
        .map((item) => ({
          proofId: item.proofId,
          transactionId: item.transactionId,
          orderLabel: formatOrderLabel(item.externalReference || item.externalOrderId),
          itemSummary: item.itemSummary,
        }));
      if (fromQueue.length > 0) {
        setCandidates(fromQueue);
        return;
      }
      const collection = await props.client.listMyProofs();
      setCandidates(
        collection.proofs
          .filter((item) => item.role === "SELLER" && item.status === "READY_FOR_EVIDENCE")
          .map((item) => ({
            proofId: item.proofId,
            transactionId: item.transactionId,
            orderLabel: formatOrderLabel(item.transaction.externalReference),
            itemSummary: item.transaction.itemTitle ?? "Item",
          })),
      );
    } catch {
      // Candidate list is a fallback, not Proof state.
    }
  }

  async function guarded(action: () => Promise<void>, needsAuth = true): Promise<void> {
    if (actionLock.current) return;
    actionLock.current = true;
    setLocalBusy(true);
    try {
      if (needsAuth) await props.onEnsureAuth();
      await action();
    } catch (error) {
      if (isAuthenticationFailure(error)) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      dispatch({
        type: "OPERATION_FAILED",
        error: stationErrorFromUnknown(error),
        canRetry: Boolean(heldCaptureRef.current),
      });
    } finally {
      actionLock.current = false;
      setLocalBusy(false);
    }
  }

  async function identify(
    method: "SCAN" | "REFERENCE" | "QUEUE_SELECT",
    reference: string,
    transactionId?: string,
  ) {
    await guarded(async () => {
      dispatch({ type: "IDENTIFY_STARTED", method, reference });
      try {
        let proof: ProofView;
        let labels:
          | {
              orderLabel: string;
              itemSummary: string;
              trackingHint?: string | null;
            }
          | undefined;
        if (transactionId) {
          proof = await props.client.createOrGetProof(transactionId);
          const selected = candidates.find((item) => item.transactionId === transactionId);
          labels = selected
            ? {
                orderLabel: selected.orderLabel,
                itemSummary: selected.itemSummary,
              }
            : undefined;
        } else {
          const resolved = await props.client.resolvePackingStation(reference);
          labels = {
            orderLabel: resolved.orderLabel,
            itemSummary: resolved.itemSummary,
            trackingHint: resolved.trackingHint ?? null,
          };
          proof = await props.client.createOrGetProof(resolved.transactionId);
        }
        const context = stationContextFromProof(proof, labels);
        dispatch({ type: "IDENTIFY_RESOLVED", context, method });
        await props.onPersist({
          capture: heldCapture,
          evidenceIdempotencyKey: stateRef.current.evidenceIdempotencyKey,
          proofId: context.proofId,
          transactionId: context.transactionId,
          orderLabel: context.orderLabel,
          itemSummary: context.itemSummary,
          stationActive: true,
        });
      } catch (error) {
        const mapped = stationErrorFromUnknown(error);
        if (mapped.code === "UNAUTHENTICATED") {
          dispatch({ type: "AUTH_FAILED", error: mapped });
          props.onAuthExpired();
          return;
        }
        dispatch({ type: "IDENTIFY_FAILED", error: mapped });
      }
    });
  }

  async function startPacking(): Promise<void> {
    await guarded(async () => {
      dispatch({ type: "START_RECORDING", trigger: "MANUAL" });
      const order = stateRef.current.order;
      if (!order) throw new Error("Choose an order before recording.");
      const captured = await recordPackingEvidence({ client: props.client, proofId: order.proofId, userId: props.userId, orderLabel: order.itemSummary || order.orderLabel });
      if (!captured) {
        dispatch({ type: "CAPTURE_CANCELLED" });
        return;
      }
      const key = stateRef.current.evidenceIdempotencyKey ?? newIdempotencyKey();
      evidenceIdRef.current = null;
      dispatch({
        type: "CAPTURE_HELD",
        capture: {
          handle: captured.uri,
          captureSessionId: captured.captureSessionId,
          contentType: captured.contentType,
          byteSize: captured.byteSize,
          durationMs: captured.durationMs,
        },
        idempotencyKey: key,
      });
      setHeldCapture(captured);
      await props.onPersist({
        capture: captured,
        evidenceIdempotencyKey: key,
        proofId: stateRef.current.order?.proofId ?? null,
        transactionId: stateRef.current.order?.transactionId ?? null,
        orderLabel: stateRef.current.order?.orderLabel ?? null,
        itemSummary: stateRef.current.order?.itemSummary ?? null,
        stationActive: true,
      });
      // The finished recording waits for the seller's explicit attestation.
      // A package rescan remains available, but cannot submit on their behalf.
      if (!biometricAttestation) dispatch({ type: "FINISH_SCAN_STARTED" });
    });
  }

  async function resolveFinishScan(value: string): Promise<void> {
    await guarded(async () => {
      const afterDecode = reduceStation(stateRef.current, {
        type: "FINISH_SCAN_DECODED",
        value,
      });
      if (afterDecode.phase !== "VERIFYING_FINISH_SCAN") {
        return;
      }
      dispatch({ type: "FINISH_SCAN_DECODED", value });
      try {
        const resolvedView = await props.client.resolvePackingStation(value);
        const resolved = {
          transactionId: resolvedView.transactionId,
          proofId: resolvedView.proofId,
        };
        const next = reduceStation(afterDecode, {
          type: "FINISH_RESOLVED",
          resolved,
        });
        dispatch({ type: "FINISH_RESOLVED", resolved });
        if (next.phase === "PROCESSING") {
          await persistFromState(next, heldCaptureRef.current);
          if (!biometricAttestation && heldCaptureRef.current) {
            const key = next.evidenceIdempotencyKey ?? newIdempotencyKey();
            dispatch({ type: "PROCESSING_STARTED", idempotencyKey: key, submitStep: "upload" });
            await processCapture(heldCaptureRef.current, key);
          }
        }
      } catch (error) {
        const mapped = stationErrorFromUnknown(error);
        if (mapped.code === "UNAUTHENTICATED") {
          dispatch({ type: "AUTH_FAILED", error: mapped });
          props.onAuthExpired();
          return;
        }
        dispatch({ type: "FINISH_SCAN_FAILED", error: mapped });
      }
    });
  }

  async function finishManually(): Promise<void> {
    if (actionLock.current || submitLock.current) return;
    const captured = heldCaptureRef.current;
    const next = reduceStation(stateRef.current, { type: "FINISH_MANUAL" });
    dispatch({ type: "FINISH_MANUAL" });
    if (next.phase === "PROCESSING" && captured) {
      const key = next.evidenceIdempotencyKey ?? newIdempotencyKey();
      dispatch({
        type: "PROCESSING_STARTED",
        idempotencyKey: key,
        submitStep: biometricAttestation ? "attest" : "upload",
      });
      await processCapture(captured, key);
    }
  }

  async function processCapture(captured: LocalCapture, key: string): Promise<void> {
    const order = stateRef.current.order;
    if (!order) {
      return;
    }
    if (submitLock.current) return;
    submitLock.current = true;
    setLocalBusy(true);
    const isCurrentSubmission = () => mountedRef.current &&
      contextRef.current.userId === props.userId && contextRef.current.client === props.client &&
      stateRef.current.order?.proofId === order.proofId;
    const assertCurrentSubmission = () => {
      if (!isCurrentSubmission()) throw new Error(
        "Your account or Proof changed. Open the original Proof and authenticate again.",
      );
    };
    try {
      await props.onEnsureAuth();
      assertCurrentSubmission();
      const available = await localCaptureExists(captured.uri);
      assertCurrentSubmission();
      if (!available) {
        dispatch({
          type: "PROCESSING_FAILED",
          error: {
            code: "CAPTURE_FAILED",
            message: "Captured video is no longer available. Record packing evidence again.",
          },
          canRetry: false,
        });
        await persistFromState(stateRef.current, null);
        return;
      }
      captured.uploadEvidenceId ??= evidenceIdRef.current ?? undefined;
      const completedProof = await completeSavedCapture({
        client: props.client, capture: captured, userId: props.userId, interactive: true, idempotencyKey: key,
        needsSellerAttestation: biometricAttestation, assertAccount: assertCurrentSubmission,
        onProgress: percent => { if (isCurrentSubmission()) dispatch({ type: "PROCESSING_PROGRESS", submitStep: "upload", uploadPercent: percent }); },
        onChange: capture => {
          if (!isCurrentSubmission()) return;
          evidenceIdRef.current = capture.uploadEvidenceId ?? null;
          setHeldCapture({ ...capture });
          const phase = capture.recovery?.phase;
          dispatch({ type: "PROCESSING_PROGRESS", submitStep: phase === "UPLOADING" ? "upload" : phase === "FINALIZATION_PENDING" ? "finalize" : "commit", uploadPercent: null });
        },
      });
      const result = { proof: completedProof, evidenceId: captured.uploadEvidenceId!, completion: "FINALIZED" as const };
      assertCurrentSubmission();
      await saveCaptureBookmarks(props.client, order.proofId, result.evidenceId, captured).catch(() => undefined);
      assertCurrentSubmission();
      // Completed local originals stay in Account until deliberate, receipt-checked cleanup.
      assertCurrentSubmission();
      setHeldCapture(null);
      dispatch({ type: "COMPLETED", completion: result.completion });
      await persistFromState(initialStationState(), null);
      await loadCandidates();
    } catch (error) {
      // The original account's recovery was already saved before this prompt.
      // A stale continuation must not write capture data into a different session.
      if (!isCurrentSubmission()) return;
      if (isAuthenticationFailure(error)) {
        dispatch({ type: "AUTH_FAILED" });
        await persistFromState(stateRef.current, captured);
        props.onAuthExpired();
        return;
      }
      const mapped = stationErrorFromUnknown(error);
      dispatch({
        type: "PROCESSING_FAILED",
        error: mapped,
        canRetry:
          mapped.code !== "PROOF_ALREADY_FINALIZED" && mapped.code !== "EVIDENCE_ALREADY_COMMITTED",
      });
      await persistFromState(stateRef.current, captured);
    } finally {
      submitLock.current = false;
      if (mountedRef.current) setLocalBusy(false);
    }
  }

  async function leaveStation(): Promise<void> {
    if (actionLock.current || submitLock.current) return;
    await guarded(async () => {
      await persistFromState(stateRef.current, heldCaptureRef.current);
      props.onLeave();
    }, false);
  }

  async function retry(): Promise<void> {
    if (actionLock.current || submitLock.current) return;
    const captured = heldCapture ?? props.restoredCapture;
    const key = state.evidenceIdempotencyKey ?? props.restoredKey ?? newIdempotencyKey();
    if (!captured) {
      return;
    }
    dispatch({ type: "RETRY" });
    dispatch({
      type: "PROCESSING_STARTED",
      idempotencyKey: key,
      submitStep: biometricAttestation ? "attest" : "upload",
    });
    await processCapture(captured, key);
  }

  const tone = toneForPhase(state.phase);
  const leaveBlocked = Boolean(state.capture) && state.phase !== "PROOF_CREATED";
  const awaitingAttestation = Boolean(state.capture) && (
    state.phase === "RECORDING" || state.phase === "RECOVERY" ||
    (state.phase === "PROCESSING" && state.submitStep === null)
  );
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: tone.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Math.max(insets.top, 24),
            paddingBottom: Math.max(insets.bottom, 24),
          },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.phase, { color: tone.ink }]}>
          {biometricAttestation && awaitingAttestation ? "CONFIRM SHIPMENT" : stationPhaseLabel(state)}
        </Text>
        {state.order ? (
          <View style={styles.identity}>
            <Text style={[styles.order, { color: tone.ink }]}>{state.order.orderLabel}</Text>
            <Text style={[styles.item, { color: tone.muted }]}>{state.order.itemSummary}</Text>
            {state.order.trackingHint ? (
              <Text style={[styles.item, { color: tone.muted }]}>{state.order.trackingHint}</Text>
            ) : null}
          </View>
        ) : (
          <Text style={[styles.hint, { color: tone.muted }]}>
            Scan a label, record packing, then confirm what you are shipping.
          </Text>
        )}

        {state.error ? <Text style={styles.error}>{state.error.message}</Text> : null}
        {localBusy && state.phase !== "RECORDING" && state.phase !== "PROCESSING" ? (
          <Text style={[styles.hint, { color: tone.muted }]}>Working…</Text>
        ) : null}
        {state.phase === "PROCESSING" && state.submitStep !== null ? (
          <Text style={[styles.hint, { color: tone.muted }]}>
            {heldCapture?.recovery ? captureRecoveryLabel(heldCapture.recovery.phase) : "Preparing your saved recording"}
            {state.uploadPercent != null ? ` ${state.uploadPercent}%` : ""}
          </Text>
        ) : null}

        {state.phase === "SCANNING" ? (
          <BarcodeScanView
            prompt="Scan the shipping label or order barcode."
            lockKey="identify"
            onDecoded={(value) => {
              dispatch({ type: "SCAN_DECODED", value });
              void identify("SCAN", value);
            }}
            onCancel={() => dispatch({ type: "SCAN_CANCELLED" })}
            onPermissionDenied={() =>
              dispatch({
                type: "SCAN_FAILED",
                error: {
                  code: "CAMERA_PERMISSION_DENIED",
                  message: "Camera permission is required to scan labels.",
                },
              })
            }
            onUnavailable={() =>
              dispatch({
                type: "SCAN_FAILED",
                error: {
                  code: "SCANNER_UNAVAILABLE",
                  message: "The camera scanner is unavailable. Enter a reference instead.",
                },
              })
            }
          />
        ) : null}

        {state.phase === "READY" || (state.phase === "RECOVERY" && !state.capture) ? (
          <View style={styles.block}>
            <StationButton
              label="Scan Order / Label"
              disabled={localBusy}
              onPress={() => dispatch({ type: "SCAN_STARTED" })}
            />
            <TextInput
              style={styles.input}
              value={state.referenceInput}
              onChangeText={(value) => dispatch({ type: "SET_REFERENCE", reference: value })}
              placeholder="Enter reference"
              placeholderTextColor="#777"
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => {
                const reference = normalizeStationReference(state.referenceInput);
                if (reference) {
                  void identify("REFERENCE", reference);
                }
              }}
            />
            <StationButton
              label="Identify by reference"
              disabled={localBusy || !normalizeStationReference(state.referenceInput)}
              secondary
              onPress={() => void identify("REFERENCE", state.referenceInput)}
            />
            {candidates.length > 0 ? (
              <View style={styles.fallback}>
                <Text style={[styles.fallbackLabel, { color: tone.muted }]}>Imported orders</Text>
                {candidates.map((item) => (
                  <StationButton
                    key={item.proofId}
                    label={`${item.orderLabel} · ${item.itemSummary}`}
                    disabled={localBusy}
                    secondary
                    onPress={() =>
                      void identify("QUEUE_SELECT", item.orderLabel, item.transactionId)
                    }
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {state.phase === "FINISH_SCANNING" || state.phase === "VERIFYING_FINISH_SCAN" ? (
          <BarcodeScanView
            prompt="Scan the same shipping label to confirm this package."
            lockKey={`finish:${state.order?.transactionId ?? "none"}`}
            onDecoded={(value) => {
              void resolveFinishScan(value);
            }}
            onCancel={() => dispatch({ type: "FINISH_SCAN_CANCELLED" })}
            onPermissionDenied={() =>
              dispatch({
                type: "FINISH_SCAN_FAILED",
                error: {
                  code: "CAMERA_PERMISSION_DENIED",
                  message:
                    "Camera permission is required to scan the package. The packing video is kept.",
                },
              })
            }
            onUnavailable={() =>
              dispatch({
                type: "FINISH_SCAN_FAILED",
                error: {
                  code: "SCANNER_UNAVAILABLE",
                  message:
                    "The camera scanner is unavailable. Confirm your shipment below. The packing video is kept.",
                },
              })
            }
          />
        ) : null}

        {state.phase === "READY_TO_RECORD" ? (
          <StationButton
            label="Start Packing"
            disabled={localBusy}
            onPress={() => void startPacking()}
          />
        ) : null}

        {state.phase === "RECORDING" && !state.capture ? (
          <Text style={[styles.hint, { color: tone.muted }]}>
            Keep the item, pack, seal, and label in frame. Stop when the package is sealed.
          </Text>
        ) : null}

        {state.phase === "RECORDING" && state.capture ? (
          <View style={styles.block}>
            <StationButton
              label="Check package label"
              disabled={localBusy}
              onPress={() => dispatch({ type: "FINISH_SCAN_STARTED" })}
            />
          </View>
        ) : null}

        {state.phase === "FINISH_SCANNING" || state.phase === "VERIFYING_FINISH_SCAN" ? (
          <StationButton
            label={biometricAttestation ? "Review shipment" : "Finished Packing"}
            disabled={localBusy}
            secondary
            onPress={() => biometricAttestation
              ? dispatch({ type: "FINISH_SCAN_CANCELLED" })
              : void finishManually()}
          />
        ) : null}

        {awaitingAttestation && biometricAttestation ? (
          <SellerAttestation
            disabled={localBusy}
            loading={localBusy}
            onPress={() => void (state.phase === "RECOVERY" ? retry() : finishManually())}
          />
        ) : null}

        {awaitingAttestation && !biometricAttestation ? (
          <StationButton
            label={state.phase === "RECOVERY" ? "Retry upload" : "Finished Packing"}
            disabled={localBusy}
            onPress={() => void (state.phase === "RECOVERY" ? retry() : finishManually())}
          />
        ) : null}

        {state.phase === "RECOVERY" && !state.capture ? (
          <StationButton
            label="Ready for next order"
            disabled={localBusy}
            secondary
            onPress={() => {
              dispatch({ type: "RESET" });
              void persistFromState(initialStationState(), null);
            }}
          />
        ) : null}

        <StationButton
          label={leaveBlocked ? "Keep video and leave" : "Leave station"}
          disabled={localBusy}
          secondary
          onPress={() => {
            void leaveStation();
          }}
        />
      </ScrollView>
    </View>
  );
}

function initialStationForRestore(props: {
  restoredCapture: LocalCapture | null;
  restoredKey: string | null;
  restoredProofId: string | null;
  restoredTransactionId: string | null;
  restoredOrderLabel: string | null;
  restoredItemSummary: string | null;
}): StationState {
  if (!props.restoredCapture || !props.restoredProofId) {
    return initialStationState();
  }
  return restoreStationState({
    phase: "RECOVERY",
    evidenceIdempotencyKey: props.restoredKey,
    capture: {
      handle: props.restoredCapture.uri,
      contentType: props.restoredCapture.contentType,
      byteSize: props.restoredCapture.byteSize,
      durationMs: props.restoredCapture.durationMs,
    },
    order: {
      transactionId: props.restoredTransactionId ?? "",
      proofId: props.restoredProofId,
      proofStatus: "READY_FOR_EVIDENCE",
      participationPolicy: null,
      orderLabel: props.restoredOrderLabel ?? "Order",
      itemSummary: props.restoredItemSummary ?? "Item",
      alreadyFinalized: false,
      alreadyHasCommittedEvidence: false,
      captureReady: true,
      trackingHint: null,
      blockReason: null,
    },
  });
}

function toneForPhase(phase: StationState["phase"]): {
  background: string;
  ink: string;
  muted: string;
} {
  switch (phase) {
    case "RECORDING": case "FINISH_SCANNING": case "VERIFYING_FINISH_SCAN":
      return { background: "#F5F7FA", ink: "#102A43", muted: "#243746" };
    case "PROOF_CREATED": return { background: "#F0FDF4", ink: "#166534", muted: "#243746" };
    case "RECOVERY": return { background: "#FFFBEB", ink: "#78350F", muted: "#243746" };
    default: return { background: "#FFFFFF", ink: "#102A43", muted: "#243746" };
  }
}

function StationButton(props: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled }}
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.button,
        props.secondary ? styles.buttonSecondary : null,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Text style={[styles.buttonText, props.secondary ? styles.buttonSecondaryText : null]}>
        {props.label}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 18,
  },
  phase: {
    fontSize: 42,
    fontWeight: "800",
    letterSpacing: 1,
  },
  identity: { gap: 6 },
  order: { fontSize: 28, fontWeight: "700" },
  item: { fontSize: 22, fontWeight: "600" },
  hint: { fontSize: 18, lineHeight: 26 },
  error: { color: "#9F1239", fontSize: 16 },
  block: { gap: 12 },
  fallback: { gap: 8, marginTop: 8 },
  fallbackLabel: { fontSize: 14, fontWeight: "700", letterSpacing: 0.6 },
  input: {
    borderWidth: 2,
    borderColor: "#D8E0E8",
    backgroundColor: "#F5F7FA",
    color: "#102A43",
    padding: 16,
    fontSize: 20,
  },
  button: {
    backgroundColor: "#1769E0",
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  buttonSecondary: {
    backgroundColor: "transparent",
    borderWidth: 2,
    borderColor: "#D8E0E8",
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: {
    color: "#FFFFFF",
    textAlign: "center",
    fontSize: 20,
    fontWeight: "800",
  },
  buttonSecondaryText: { color: "#102A43" },
});
