export interface UserFacingError {
  title: string;
  message: string;
  action: "none" | "open_existing" | "retry" | "signin" | "manual" | "import";
  technical: string;
  code: string;
}

const CODE_MESSAGES: Record<string, { title: string; message: string; action?: UserFacingError["action"] }> = {
  DUPLICATE_PROOF_EXTERNAL_TRANSACTION_BINDING: {
    title: "A PackProof already exists for this order.",
    message: "Open the existing record instead of creating another.",
    action: "open_existing",
  },
  EXTERNAL_REFERENCE_CONFLICT: {
    title: "A PackProof already exists for this order.",
    message: "This order is already linked to a PackProof.",
    action: "open_existing",
  },
  TRANSACTION_REFERENCE_CONFLICT: {
    title: "A PackProof already exists for this order.",
    message: "This order reference is already in use.",
    action: "open_existing",
  },
  INTEGRATION_IDENTITY_CONFLICT: {
    title: "This purchase is already linked.",
    message: "That marketplace order is already associated with another PackProof account.",
  },
  PROOF_ALREADY_FINALIZED: {
    title: "This PackProof is already sealed.",
    message: "Committed evidence and finalized details can no longer be changed.",
  },
  PROOF_NOT_READY_FOR_FINALIZATION: {
    title: "This PackProof isn’t ready to finalize yet.",
    message: "Finish the required evidence and participants first.",
  },
  FULFILLMENT_CAPTURE_REQUIRED: {
    title: "Packing evidence is still required.",
    message: "Record the item being packed and sealed before finalizing.",
  },
  EVIDENCE_ALREADY_COMMITTED: {
    title: "Evidence is already secured.",
    message: "This PackProof already has committed packing evidence.",
  },
  INVALID_EVIDENCE_TYPE: {
    title: "That evidence type isn’t supported.",
    message: "Record packing evidence using the camera in PackProof.",
  },
  PARTICIPANT_NOT_AUTHORIZED: {
    title: "You don’t have access to this PackProof.",
    message: "Ask a participant to invite you if you should be on this record.",
  },
  INVITATION_EXPIRED: {
    title: "This invitation has expired.",
    message: "Ask the seller to send a new invitation.",
  },
  CANNOT_INVITE_SELF: {
    title: "You can’t invite yourself.",
    message: "Search for another PackProof username.",
  },
  ALREADY_PARTICIPANT: {
    title: "They’re already on this PackProof.",
    message: "No additional invitation is needed.",
  },
  INVALID_SEARCH: {
    title: "Enter a name or username to search.",
    message: "Use at least two characters.",
  },
  INVALID_PROOF_TRANSITION: {
    title: "That step isn’t available yet.",
    message: "Refresh this PackProof and continue from the next required action.",
  },
  STATION_REFERENCE_NOT_FOUND: {
    title: "We couldn’t find a matching order.",
    message: "Try another scan, import a purchase, or enter the details manually.",
    action: "manual",
  },
  STATION_REFERENCE_AMBIGUOUS: {
    title: "More than one order matched.",
    message: "Confirm the correct order, or enter a more specific reference.",
  },
  STATION_REFERENCE_INVALID: {
    title: "That reference isn’t usable.",
    message: "Scan the shipping label or order barcode, or enter the reference manually.",
  },
  UNAUTHENTICATED: {
    title: "Sign in again.",
    message: "Your session expired. Any recording on this device is still saved.",
    action: "signin",
  },
  UPLOAD_FAILED: {
    title: "We couldn’t secure this evidence yet.",
    message: "Your recording is still safely stored on this device.",
    action: "retry",
  },
  NETWORK: {
    title: "You’re offline.",
    message: "Your recording is safely stored on this device. PackProof will continue when you’re connected.",
    action: "retry",
  },
  PROOF_NOT_FOUND: {
    title: "This PackProof could not be found.",
    message: "It may have been removed or you may not have access.",
  },
  TRANSACTION_NOT_FOUND: {
    title: "That order could not be found.",
    message: "Check the reference, import the purchase, or enter the details manually.",
    action: "manual",
  },
  EBAY_INTEGRATION_DISABLED: {
    title: "eBay isn’t enabled yet.",
    message: "This PackProof environment has not turned on eBay connections.",
  },
  MARKETPLACE_ALREADY_CONNECTED: {
    title: "That eBay account is already connected.",
    message: "Sign in to the PackProof account that already connected this eBay user, or disconnect it there first.",
  },
  OAUTH_STATE_INVALID: {
    title: "The eBay sign-in expired.",
    message: "Start Connect eBay again from PackProof.",
  },
  OAUTH_STATE_EXPIRED: {
    title: "The eBay sign-in expired.",
    message: "Start Connect eBay again from PackProof.",
  },
  OAUTH_STATE_REUSED: {
    title: "The eBay sign-in expired.",
    message: "Start Connect eBay again from PackProof.",
  },
  EBAY_OAUTH_FAILED: {
    title: "We couldn’t connect eBay.",
    message: "Try Connect eBay again. PackProof did not save credentials from this attempt.",
  },
  INTEGRATION_NEEDS_REAUTH: {
    title: "Reconnect this account.",
    message: "The saved authorization is no longer valid.",
  },
  INTEGRATION_NOT_FOUND: {
    title: "No connected account was found.",
    message: "Connect eBay from Account → Stores, then import a sale.",
  },
  PROVIDER_AUTH_FAILED: {
    title: "The connected service rejected the saved credentials.",
    message: "Reconnect the account from Connected Stores.",
  },
};

export function isInternalErrorText(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("exception") ||
    normalized.includes("stack trace") ||
    normalized.includes("postgres") ||
    normalized.includes("sqlite") ||
    normalized.includes("cognito") ||
    normalized.includes("amazonaws") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("internal server") ||
    normalized.includes("sqlstate") ||
    normalized.includes("at object.") ||
    /\bsql\b/.test(normalized)
  );
}

export function isAuthenticationFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error && (error.status === 401 || error.status === 403)) {
    return true;
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return (
      error.code === "UNAUTHENTICATED" ||
      error.code === "NotAuthorizedException" ||
      error.code === "UserNotFoundException" ||
      error.code === "PasswordResetRequiredException"
    );
  }
  return false;
}

export function isNetworkFailure(error: unknown): boolean {
  if (!error) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("network request failed") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("network error") ||
    normalized.includes("internet") ||
    normalized.includes("offline")
  );
}

export function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "UNKNOWN";
}

export function toUserFacingError(error: unknown): UserFacingError {
  if (isNetworkFailure(error)) {
    return {
      title: "You’re offline.",
      message: "PackProof will refresh when your connection returns. Recordings on this device are kept.",
      action: "retry",
      technical: error instanceof Error ? error.message : String(error),
      code: "NETWORK",
    };
  }
  const code = errorCode(error);
  const mapped = CODE_MESSAGES[code];
  const technical =
    error && typeof error === "object" && "code" in error && "message" in error
      ? `${String((error as { code: string }).code)}: ${String((error as { message: string }).message)}`
      : error instanceof Error
        ? error.message
        : String(error);
  const fallbackMessage =
    error && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message
      : technical;
  if (mapped) {
    return {
      title: mapped.title,
      message: mapped.message,
      action: mapped.action ?? "none",
      technical,
      code,
    };
  }
  const safeMessage = isInternalErrorText(fallbackMessage)
    ? "Try again. If this continues, use Account for support details."
    : fallbackMessage;
  if (code !== "UNKNOWN" && code !== "HTTP_ERROR") {
    return {
      title: "Something went wrong.",
      message: safeMessage,
      action: "none",
      technical,
      code,
    };
  }
  return {
    title: "Something went wrong.",
    message: safeMessage,
    action: "none",
    technical,
    code,
  };
}

export function formatUserFacingError(error: unknown): string {
  const mapped = toUserFacingError(error);
  return mapped.message ? `${mapped.title} ${mapped.message}`.trim() : mapped.title;
}

export const OFFLINE_CAPTURE_MESSAGE =
  "Your recording is safely stored on this device. PackProof will upload it when your connection returns.";

export const MARKETPLACE_DISCLOSURE =
  "PackProof records information supplied by the marketplace. This information has not been independently verified by PackProof.";

export const CARRIER_DISCLOSURE =
  "Carrier observations are appended to the Proof record. They do not alter the finalized evidence manifest.";

export const FINALIZE_DISCLOSURE =
  "Finalizing seals the current Proof record. Committed evidence and finalized transaction details can no longer be changed.";

export const SOURCE_DISCLOSURE =
  "Source labels describe where information came from. They are not evidence levels.";
