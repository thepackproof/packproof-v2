import { DomainError } from "./errors.js";

export class IntegrationError extends DomainError {
  readonly retryable: boolean;

  constructor(code: string, message: string, httpStatus: number, retryable: boolean) {
    super(code, message, httpStatus);
    this.name = "IntegrationError";
    this.retryable = retryable;
  }
}

export function integrationNotFound(): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_NOT_FOUND",
    "No trusted shipment integration is associated with this transaction",
    404,
    false,
  );
}

export function integrationDisabled(): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_DISABLED",
    "The trusted shipment integration is disabled",
    409,
    false,
  );
}

export function integrationNeedsReauth(): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_NEEDS_REAUTH",
    "The trusted shipment integration needs to be reauthorized",
    409,
    false,
  );
}

export function integrationCredentialsUnavailable(): IntegrationError {
  return new IntegrationError(
    "INTEGRATION_CREDENTIALS_UNAVAILABLE",
    "Trusted integration credentials are unavailable",
    503,
    true,
  );
}

export function providerAuthFailed(): IntegrationError {
  return new IntegrationError(
    "PROVIDER_AUTH_FAILED",
    "The shipping provider rejected the integration credentials",
    502,
    false,
  );
}

export function providerRateLimited(): IntegrationError {
  return new IntegrationError(
    "PROVIDER_RATE_LIMITED",
    "The shipping provider rate-limited the request",
    429,
    true,
  );
}

export function providerTemporarilyUnavailable(): IntegrationError {
  return new IntegrationError(
    "PROVIDER_TEMPORARILY_UNAVAILABLE",
    "The shipping provider is temporarily unavailable",
    503,
    true,
  );
}

export function trackingNotFound(): IntegrationError {
  return new IntegrationError(
    "TRACKING_NOT_FOUND",
    "No tracking information is available for this shipment",
    404,
    false,
  );
}

export function providerResponseInvalid(): IntegrationError {
  return new IntegrationError(
    "PROVIDER_RESPONSE_INVALID",
    "The shipping provider returned an invalid response",
    502,
    false,
  );
}

export function webhookSignatureInvalid(): IntegrationError {
  return new IntegrationError(
    "WEBHOOK_SIGNATURE_INVALID",
    "Webhook signature verification failed",
    401,
    false,
  );
}

export function webhookReplayRejected(): IntegrationError {
  return new IntegrationError(
    "WEBHOOK_REPLAY_REJECTED",
    "Webhook request was rejected as a replay",
    409,
    false,
  );
}

export function integrationTrustBoundary(
  message = "Trusted shipment provenance cannot be assigned from this path",
): IntegrationError {
  return new IntegrationError("INTEGRATION_TRUST_BOUNDARY", message, 403, false);
}
