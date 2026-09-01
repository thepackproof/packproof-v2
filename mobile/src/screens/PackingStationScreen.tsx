import { useEffect, useReducer, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  discardLocalCapture,
  localCaptureExists,
  recordPackingEvidence,
  uploadCaptureFile,
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
import { submitStationSession } from "../packing-station/submit";
import type { StationCandidate, StationState } from "../packing-station/types";
import { ApiError, PackProofV2Client, newIdempotencyKey, type ProofView } from "../v2-api";
import { BarcodeScanView } from "./BarcodeScanView";

const COMPLETED_HOLD_MS = 1600;

export interface StationPersistSnapshot {
  capture: LocalCapture | null;
  evidenceIdempotencyKey: string | null;
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
  restoredProofId: string | null;
  restoredTransactionId: string | null;
  restoredOrderLabel: string | null;
  restoredItemSummary: string | null;
  onPersist: (next: StationPersistSnapshot) => Promise<void>;
  onEnsureAuth: () => Promise<void>;
  onAuthExpired: () => void;
  onLeave: () => void;
}) {
  const [state, dispatch] = useReducer(
    reduceStation,
    undefined,
    () => initialStationForRestore(props),
  );
  const [candidates, setCandidates] = useState<StationCandidate[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [heldCapture, setHeldCapture] = useState<LocalCapture | null>(props.restoredCapture);
  const stateRef = useRef(state);
  const heldCaptureRef = useRef(heldCapture);
  stateRef.current = state;
  heldCaptureRef.current = heldCapture;

  useEffect(() => {
    void loadCandidates();
  }, [props.client]);

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

  async function persistFromState(
    next: StationState,
    capture: LocalCapture | null,
  ): Promise<void> {
    await props.onPersist({
      capture,
      evidenceIdempotencyKey: next.evidenceIdempotencyKey,
      proofId: next.order?.proofId ?? null,
      transactionId: next.order?.transactionId ?? null,
      orderLabel: next.order?.orderLabel ?? null,
      itemSummary: next.order?.itemSummary ?? null,
      stationActive: next.phase !== "READY" && next.phase !== "PROOF_CREATED" ? true : Boolean(capture),
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

  async function guarded(action: () => Promise<void>): Promise<void> {
    setLocalBusy(true);
    try {
      await props.onEnsureAuth();
      await action();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        props.onAuthExpired();
        return;
      }
      throw error;
    } finally {
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
        let labels: { orderLabel: string; itemSummary: string; trackingHint?: string | null } | undefined;
        if (transactionId) {
          proof = await props.client.createOrGetProof(transactionId);
          const selected = candidates.find((item) => item.transactionId === transactionId);
          labels = selected
            ? { orderLabel: selected.orderLabel, itemSummary: selected.itemSummary }
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
      const captured = await recordPackingEvidence();
      if (!captured) {
        dispatch({ type: "CAPTURE_CANCELLED" });
        return;
      }
      const key = stateRef.current.evidenceIdempotencyKey ?? newIdempotencyKey();
      dispatch({
        type: "CAPTURE_HELD",
        capture: {
          handle: captured.uri,
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
      dispatch({ type: "FINISH_SCAN_STARTED" });
    });
  }

  async function resolveFinishScan(value: string): Promise<void> {
    await guarded(async () => {
      const afterDecode = reduceStation(stateRef.current, { type: "FINISH_SCAN_DECODED", value });
      if (afterDecode.phase !== "VERIFYING_FINISH_SCAN") {
        return;
      }
      dispatch({ type: "FINISH_SCAN_DECODED", value });
      try {
        const resolvedView = await props.client.resolvePackingStation(value);
        const resolved = { transactionId: resolvedView.transactionId, proofId: resolvedView.proofId };
        const next = reduceStation(afterDecode, { type: "FINISH_RESOLVED", resolved });
        dispatch({ type: "FINISH_RESOLVED", resolved });
        const captured = heldCaptureRef.current;
        if (next.phase === "PROCESSING" && captured) {
          const key = next.evidenceIdempotencyKey ?? newIdempotencyKey();
          dispatch({ type: "PROCESSING_STARTED", idempotencyKey: key, submitStep: "upload" });
          await processCapture(captured, key);
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
    const captured = heldCaptureRef.current;
    const next = reduceStation(stateRef.current, { type: "FINISH_MANUAL" });
    dispatch({ type: "FINISH_MANUAL" });
    if (next.phase === "PROCESSING" && captured) {
      const key = next.evidenceIdempotencyKey ?? newIdempotencyKey();
      dispatch({ type: "PROCESSING_STARTED", idempotencyKey: key, submitStep: "upload" });
      await processCapture(captured, key);
    }
  }

  async function processCapture(captured: LocalCapture, key: string): Promise<void> {
    const order = stateRef.current.order;
    if (!order) {
      return;
    }
    try {
      const available = await localCaptureExists(captured.uri);
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
      const proof = await props.client.getProof(order.proofId);
      const result = await submitStationSession({
        proof,
        actorUserId: props.userId,
        capture: {
          handle: captured.uri,
          contentType: captured.contentType,
          byteSize: captured.byteSize,
          durationMs: captured.durationMs,
        },
        idempotencyKey: key,
        deps: {
          api: props.client,
          newIdempotencyKey,
          upload: async (target, _capture, onProgress) => {
            await uploadCaptureFile({
              baseUrl: props.apiBaseUrl,
              target,
              fileUri: captured.uri,
              contentType: captured.contentType,
              onProgress,
            });
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
      await discardLocalCapture(captured.uri);
      setHeldCapture(null);
      dispatch({ type: "COMPLETED", completion: result.completion });
      await persistFromState(initialStationState(), null);
      await loadCandidates();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        dispatch({ type: "AUTH_FAILED" });
        await persistFromState(stateRef.current, captured);
        props.onAuthExpired();
        return;
      }
      const mapped = stationErrorFromUnknown(error);
      dispatch({
        type: "PROCESSING_FAILED",
        error: mapped,
        canRetry: mapped.code !== "PROOF_ALREADY_FINALIZED" && mapped.code !== "EVIDENCE_ALREADY_COMMITTED",
      });
      await persistFromState(stateRef.current, captured);
    }
  }

  async function retry(): Promise<void> {
    const captured = heldCapture ?? props.restoredCapture;
    const key = state.evidenceIdempotencyKey ?? props.restoredKey ?? newIdempotencyKey();
    if (!captured) {
      return;
    }
    dispatch({ type: "RETRY" });
    dispatch({ type: "PROCESSING_STARTED", idempotencyKey: key, submitStep: "upload" });
    await processCapture(captured, key);
  }

  const tone = toneForPhase(state.phase);
  const leaveBlocked = Boolean(state.capture) && state.phase !== "PROOF_CREATED";
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { backgroundColor: tone.background }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: Math.max(insets.top, 24), paddingBottom: Math.max(insets.bottom, 24) },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.phase, { color: tone.ink }]}>{stationPhaseLabel(state)}</Text>
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
            Scan a label, pack in frame, then PackProof finishes the record.
          </Text>
        )}

        {state.error ? <Text style={styles.error}>{state.error.message}</Text> : null}
        {localBusy && state.phase !== "RECORDING" && state.phase !== "PROCESSING" ? (
          <Text style={[styles.hint, { color: tone.muted }]}>Working…</Text>
        ) : null}
        {state.phase === "PROCESSING" ? (
          <Text style={[styles.hint, { color: tone.muted }]}>
            Saving packing video{state.uploadPercent != null ? ` ${state.uploadPercent}%` : ""}
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
                    onPress={() => void identify("QUEUE_SELECT", item.orderLabel, item.transactionId)}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {state.phase === "FINISH_SCANNING" || state.phase === "VERIFYING_FINISH_SCAN" ? (
          <BarcodeScanView
            prompt="Scan the same shipping label to finish this pack."
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
                  message: "Camera permission is required to scan the package. The packing video is kept.",
                },
              })
            }
            onUnavailable={() =>
              dispatch({
                type: "FINISH_SCAN_FAILED",
                error: {
                  code: "SCANNER_UNAVAILABLE",
                  message: "The camera scanner is unavailable. Use Finished Packing. The packing video is kept.",
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
              label="Scan Package to Finish"
              disabled={localBusy}
              onPress={() => dispatch({ type: "FINISH_SCAN_STARTED" })}
            />
            <StationButton
              label="Finished Packing"
              disabled={localBusy}
              secondary
              onPress={() => void finishManually()}
            />
          </View>
        ) : null}

        {state.phase === "FINISH_SCANNING" || state.phase === "VERIFYING_FINISH_SCAN" ? (
          <StationButton
            label="Finished Packing"
            disabled={localBusy}
            secondary
            onPress={() => void finishManually()}
          />
        ) : null}

        {state.phase === "RECOVERY" && state.capture ? (
          <StationButton label="Retry upload" disabled={localBusy} onPress={() => void retry()} />
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
          disabled={localBusy && state.phase === "PROCESSING"}
          secondary
          onPress={() => {
            void persistFromState(stateRef.current, heldCapture);
            props.onLeave();
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

function toneForPhase(phase: StationState["phase"]): { background: string; ink: string; muted: string } {
  switch (phase) {
    case "RECORDING":
    case "FINISH_SCANNING":
    case "VERIFYING_FINISH_SCAN":
      return { background: "#10222E", ink: "#F4F6F8", muted: "#9AA8B2" };
    case "PROCESSING":
      return { background: "#142735", ink: "#F4F6F8", muted: "#9AA8B2" };
    case "PROOF_CREATED":
      return { background: "#0C2A1C", ink: "#F3FFF6", muted: "#B7E0C5" };
    case "RECOVERY":
      return { background: "#2A2414", ink: "#FFF8E8", muted: "#E0C88A" };
    default:
      return { background: "#142735", ink: "#FFFFFF", muted: "#9AA8B2" };
  }
}

function StationButton(props: {
  label: string;
  disabled: boolean;
  onPress: () => void;
  secondary?: boolean;
}) {
  return (
    <Pressable
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
    </Pressable>
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
  error: { color: "#ffd0d0", fontSize: 16 },
  block: { gap: 12 },
  fallback: { gap: 8, marginTop: 8 },
  fallbackLabel: { fontSize: 14, fontWeight: "700", letterSpacing: 0.6 },
  input: {
    borderWidth: 2,
    borderColor: "#888",
    backgroundColor: "#fff",
    color: "#111",
    padding: 16,
    fontSize: 20,
  },
  button: {
    backgroundColor: "#13A8E8",
    paddingVertical: 18,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  buttonSecondary: { backgroundColor: "transparent", borderWidth: 2, borderColor: "#FFFFFF" },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#FFFFFF", textAlign: "center", fontSize: 20, fontWeight: "800" },
  buttonSecondaryText: { color: "#FFFFFF" },
});
