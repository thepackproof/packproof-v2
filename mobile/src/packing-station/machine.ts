import { errorForBlockReason } from "./display";
import type {
  IdentifyMethod,
  StationError,
  StationEvent,
  StationOrderContext,
  StationState,
} from "./types";

export function initialStationState(): StationState {
  return {
    phase: "READY",
    identifyMethod: null,
    startTrigger: null,
    stopTrigger: null,
    referenceInput: "",
    order: null,
    capture: null,
    evidenceIdempotencyKey: null,
    submitStep: null,
    uploadPercent: null,
    completion: null,
    error: null,
    canRetry: false,
  };
}

export function restoreStationState(partial: Partial<StationState> | null | undefined): StationState {
  const next: StationState = {
    ...initialStationState(),
    ...(partial ?? {}),
  };
  if (next.capture && next.phase !== "PROOF_CREATED") {
    return {
      ...next,
      phase: "RECOVERY",
      canRetry: true,
      error:
        next.error ??
        ({
          code: "UPLOAD_FAILED",
          message: "Packing video is still on this device. Retry upload without recording again.",
        } satisfies StationError),
    };
  }
  if (next.phase === "IDENTIFYING" || next.phase === "RECORDING" || next.phase === "PROCESSING") {
    return {
      ...next,
      phase: next.order?.captureReady ? "READY_TO_RECORD" : next.order ? "RECOVERY" : "READY",
    };
  }
  return next;
}

export function reduceStation(state: StationState, event: StationEvent): StationState {
  switch (event.type) {
    case "SET_REFERENCE":
      return { ...state, referenceInput: event.reference };

    case "IDENTIFY_STARTED":
      if (state.capture) {
        return {
          ...state,
          error: {
            code: "UNKNOWN",
            message: "Finish or keep the recorded video for this order before identifying another.",
          },
          phase: "RECOVERY",
          canRetry: true,
        };
      }
      if (
        state.phase !== "READY" &&
        state.phase !== "RECOVERY" &&
        state.phase !== "READY_TO_RECORD" &&
        state.phase !== "IDENTIFYING"
      ) {
        return state;
      }
      return {
        ...state,
        phase: "IDENTIFYING",
        identifyMethod: event.method,
        referenceInput:
          event.reference !== undefined ? event.reference : state.referenceInput,
        order: null,
        completion: null,
        error: null,
        canRetry: false,
        startTrigger: null,
        stopTrigger: null,
        submitStep: null,
        uploadPercent: null,
      };

    case "IDENTIFY_RESOLVED":
      if (state.phase !== "IDENTIFYING") {
        return state;
      }
      return applyResolvedOrder(state, event.context, event.method);

    case "IDENTIFY_FAILED":
      if (state.phase !== "IDENTIFYING") {
        return state;
      }
      return {
        ...state,
        phase: "RECOVERY",
        order: null,
        error: event.error,
        canRetry: false,
      };

    case "START_RECORDING":
      if (state.phase !== "READY_TO_RECORD" || !state.order?.captureReady) {
        return state;
      }
      return {
        ...state,
        phase: "RECORDING",
        startTrigger: event.trigger ?? "MANUAL",
        error: null,
      };

    case "RECORDING_STARTED":
      if (state.phase !== "RECORDING" && state.phase !== "READY_TO_RECORD") {
        return state;
      }
      return {
        ...state,
        phase: "RECORDING",
        startTrigger: state.startTrigger ?? "MANUAL",
        error: null,
      };

    case "FINISH_RECORDING":
      if (state.phase !== "RECORDING") {
        return state;
      }
      return {
        ...state,
        stopTrigger: event.trigger ?? "MANUAL",
      };

    case "CAPTURE_READY":
      if (state.phase !== "RECORDING" && state.phase !== "READY_TO_RECORD") {
        return state;
      }
      return {
        ...state,
        phase: "PROCESSING",
        capture: event.capture,
        stopTrigger: event.trigger ?? state.stopTrigger ?? "MANUAL",
        submitStep: null,
        uploadPercent: 0,
        error: null,
        canRetry: false,
      };

    case "CAPTURE_CANCELLED":
      if (state.phase !== "RECORDING") {
        return state;
      }
      return {
        ...state,
        phase: "READY_TO_RECORD",
        startTrigger: null,
        stopTrigger: null,
        error: null,
      };

    case "PROCESSING_STARTED":
      if (state.phase !== "PROCESSING" && state.phase !== "RECOVERY") {
        return state;
      }
      return {
        ...state,
        phase: "PROCESSING",
        evidenceIdempotencyKey: event.idempotencyKey ?? state.evidenceIdempotencyKey,
        submitStep: event.submitStep ?? state.submitStep ?? "upload",
        error: null,
        canRetry: false,
      };

    case "PROCESSING_PROGRESS":
      if (state.phase !== "PROCESSING") {
        return state;
      }
      return {
        ...state,
        uploadPercent: event.uploadPercent ?? state.uploadPercent,
        submitStep: event.submitStep ?? state.submitStep,
      };

    case "COMPLETED":
      if (state.phase !== "PROCESSING") {
        return state;
      }
      return {
        ...state,
        phase: "PROOF_CREATED",
        capture: null,
        evidenceIdempotencyKey: null,
        submitStep: null,
        uploadPercent: null,
        completion: event.completion,
        error: null,
        canRetry: false,
      };

    case "PROCESSING_FAILED":
      if (state.phase !== "PROCESSING") {
        return state;
      }
      return {
        ...state,
        phase: "RECOVERY",
        error: event.error,
        canRetry: event.canRetry,
      };

    case "RETRY":
      if (state.phase !== "RECOVERY" || !state.capture || !state.order) {
        return state;
      }
      return {
        ...state,
        phase: "PROCESSING",
        submitStep: state.submitStep ?? "upload",
        error: null,
        canRetry: false,
      };

    case "RESET":
      if (state.capture && state.phase !== "PROOF_CREATED") {
        return state;
      }
      return {
        ...initialStationState(),
        referenceInput: "",
      };

    case "AUTH_FAILED":
      return {
        ...state,
        phase: "RECOVERY",
        error:
          event.error ??
          ({
            code: "UNAUTHENTICATED",
            message: "Session expired. Sign in again, then retry. Recorded video is kept.",
          } satisfies StationError),
        canRetry: Boolean(state.capture),
      };

    case "DISCARD_CAPTURE":
      return {
        ...state,
        capture: null,
        evidenceIdempotencyKey: null,
        submitStep: null,
        uploadPercent: null,
        phase: state.order?.captureReady ? "READY_TO_RECORD" : state.order ? "RECOVERY" : "READY",
        error: state.order?.blockReason ? errorForBlockReason(state.order.blockReason) : null,
        canRetry: false,
      };

    default:
      return state;
  }
}

function applyResolvedOrder(
  state: StationState,
  context: StationOrderContext,
  method: IdentifyMethod,
): StationState {
  if (context.captureReady) {
    return {
      ...state,
      phase: "READY_TO_RECORD",
      identifyMethod: method,
      order: context,
      error: null,
      canRetry: false,
    };
  }
  return {
    ...state,
    phase: "RECOVERY",
    identifyMethod: method,
    order: context,
    error: context.blockReason
      ? errorForBlockReason(context.blockReason)
      : {
          code: "PROOF_NOT_READY",
          message: "This PackProof is not ready to pack.",
        },
    canRetry: false,
  };
}

export function stationHasPreservedCapture(state: StationState): boolean {
  return state.capture != null;
}

export function stationCanIdentify(state: StationState): boolean {
  return !state.capture && (state.phase === "READY" || state.phase === "RECOVERY" || state.phase === "READY_TO_RECORD");
}

export function stationPhaseLabel(state: StationState): string {
  switch (state.phase) {
    case "READY":
      return "READY";
    case "IDENTIFYING":
      return "IDENTIFYING";
    case "READY_TO_RECORD":
      return "READY TO PACK";
    case "RECORDING":
      return "RECORDING";
    case "PROCESSING":
      return "PROCESSING";
    case "PROOF_CREATED":
      return "PROOF CREATED";
    case "RECOVERY":
      return state.order?.alreadyFinalized ? "ALREADY COMPLETE" : "NEEDS ATTENTION";
    default:
      return "READY";
  }
}
