package com.packproof.unifiedcamera

/** Production admits explicit final-file receipts only; image collection stays laboratory-only. */
internal object ResearchCapturePolicy {
  const val PRODUCTION_PACKAGE = "com.packproof.mobile"
  const val LAB_PACKAGE = "com.packproof.mobile.research"
  const val FINAL_FILE_RECEIPT = "FINAL_FILE_RECEIPT"
  const val PASSIVE_LAB = "PASSIVE_LAB"

  fun acceptsPackage(packageName: String) = packageName == PRODUCTION_PACKAGE || packageName == LAB_PACKAGE

  fun mode(packageName: String, schema: String, requestedMode: String, samplingEnabled: Boolean?, hasChallenge: Boolean): String {
    require(acceptsPackage(packageName)) { "Unsupported capture application" }
    require(schema == "packproof.native-session.v1") { "Unsupported native binding" }
    if (packageName == PRODUCTION_PACKAGE || requestedMode == FINAL_FILE_RECEIPT) {
      require(requestedMode == FINAL_FILE_RECEIPT && samplingEnabled == false && !hasChallenge) {
        "Production permits explicit final-file receipts without image sampling or camera controls"
      }
      return FINAL_FILE_RECEIPT
    }
    require(requestedMode.isEmpty() || requestedMode == PASSIVE_LAB) { "Unsupported laboratory mode" }
    return PASSIVE_LAB
  }

  fun requireBoundScope(packageName: String, userId: String, boundScope: String, suppliedScope: String = boundScope) {
    // Existing laboratory bindings predate the explicit field. New bindings always include it.
    if (packageName == LAB_PACKAGE && boundScope.isEmpty()) return
    require(userId.isNotEmpty() && boundScope.length <= 256 && boundScope.endsWith("|$userId") && boundScope.length > userId.length + 1) {
      "Account-scoped signing identity required"
    }
    require(boundScope == suppliedScope) { "Capture signer cannot change accounts" }
  }
}
