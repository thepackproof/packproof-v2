import type { ReleaseIdentity } from "../config.js";
import { NATIVE_ATTESTATION_METHODS, SELLER_SHIPPING_STATEMENT } from "../domain/attestation-authorization.js";

/** Public protocol information, never credentials or deployment configuration. */
export function captureCapabilities(release: ReleaseIdentity, durableReceiptsRequired = false) {
  return {
    schemaVersion: 1,
    identifiers: {schemaVersions:[1],policyVersion:1,productionQualified:false,limits:{maxPayloadBytes:4096,maxEventsPerBatch:50,maxBatchBytes:131072,maxSessionObservations:512,reservedShippingObservations:16},source:'AUTHORIZED_ORDER_INDEX',paidLookupCalls:0},
    captureEngine: {schemas:["packproof.capture/1"],coreVersions:["1.0.0"],intentTtlSeconds:600,productionQualified:false,experimentalDetectorsEnabled:false},
    capture: { protocolVersions: [1], maxBytes: 250_000_000, maxDurationSeconds: 300, maxActiveUploads: 2 },
    accountDeletion: { requestSupported: true },
    correctionPolicy: { importedFactsReadOnly: true, captureBindingLocksManualDetails: true },
    shippingReview: { requiredForObservedConflicts: true, noLabelAllowed: true },
    sellerAttestation: {
      contextBindingVersion: 1,
      challengeVersions: [1], statementVersion: 1, statement: SELLER_SHIPPING_STATEMENT,
      methods: NATIVE_ATTESTATION_METHODS, hardwareOriginVerified: false,
    },
    preservation: { receiptVersions: [1], durableReceiptsRequired },
    release: { commit: release.commit, version: release.version },
  } as const;
}
