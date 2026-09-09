import type { ReleaseIdentity } from "../config.js";
import { SELLER_SHIPPING_STATEMENT } from "../domain/attestation-authorization.js";

/** Public protocol information, never credentials or deployment configuration. */
export function captureCapabilities(release: ReleaseIdentity, durableReceiptsRequired = false) {
  return {
    schemaVersion: 1,
    captureEngine: {schemas:["packproof.capture/1"],coreVersions:["1.0.0"],intentTtlSeconds:600,productionQualified:false,experimentalDetectorsEnabled:false},
    capture: { protocolVersions: [1], maxBytes: 250_000_000, maxDurationSeconds: 300, maxActiveUploads: 2 },
    accountDeletion: { requestSupported: true },
    correctionPolicy: { importedFactsReadOnly: true, captureBindingLocksManualDetails: true },
    shippingReview: { requiredForObservedConflicts: true, noLabelAllowed: true },
    sellerAttestation: {
      contextBindingVersion: 1,
      challengeVersions: [1], statementVersion: 1, statement: SELLER_SHIPPING_STATEMENT,
      methods: ["ANDROID_BIOMETRIC_STRONG"], hardwareOriginVerified: false,
    },
    preservation: { receiptVersions: [1], durableReceiptsRequired },
    release: { commit: release.commit, version: release.version },
  } as const;
}
