package com.packproof.unifiedcamera

import org.junit.Assert.*
import org.junit.Test

class ResearchCapturePolicyTest {
  private val schema = "packproof.native-session.v1"
  private fun denied(action: () -> Unit) {
    try { action(); fail("Expected native policy rejection") } catch (_: IllegalArgumentException) {}
  }

  @Test fun productionRequiresExplicitReceiptOnlyBinding() {
    assertEquals("FINAL_FILE_RECEIPT", ResearchCapturePolicy.mode("com.packproof.mobile", schema, "FINAL_FILE_RECEIPT", false, false))
    for (mode in listOf("", "PASSIVE_LAB", "ACTIVE", "FINAL_FILE_RECEIPT")) {
      denied { ResearchCapturePolicy.mode("com.packproof.mobile", schema, mode, true, false) }
      denied { ResearchCapturePolicy.mode("com.packproof.mobile", schema, mode, null, false) }
      denied { ResearchCapturePolicy.mode("com.packproof.mobile", schema, mode, false, true) }
    }
    denied { ResearchCapturePolicy.mode("com.packproof.mobile", schema, "", false, false) }
    denied { ResearchCapturePolicy.mode("com.packproof.mobile", "wrong-schema", "FINAL_FILE_RECEIPT", false, false) }
    denied { ResearchCapturePolicy.mode("com.packproof.mobile.cameraspike", schema, "FINAL_FILE_RECEIPT", false, false) }
  }

  @Test fun laboratorySamplingDoesNotGrantProductionSampling() {
    assertEquals("PASSIVE_LAB", ResearchCapturePolicy.mode("com.packproof.mobile.research", schema, "", true, true))
    assertEquals("PASSIVE_LAB", ResearchCapturePolicy.mode("com.packproof.mobile.research", schema, "PASSIVE_LAB", false, false))
    denied { ResearchCapturePolicy.mode("com.packproof.mobile.research", schema, "ACTIVE", true, true) }
    denied { ResearchCapturePolicy.mode("com.packproof.mobile.research", schema, "FINAL_FILE_RECEIPT", true, false) }
  }

  @Test fun productionSignerMustMatchImmutableAccountScope() {
    val scope = "https://api.example.test|actor-a"
    ResearchCapturePolicy.requireBoundScope("com.packproof.mobile", "actor-a", scope, scope)
    denied { ResearchCapturePolicy.requireBoundScope("com.packproof.mobile", "actor-a", "", scope) }
    denied { ResearchCapturePolicy.requireBoundScope("com.packproof.mobile", "actor-b", scope, scope) }
    denied { ResearchCapturePolicy.requireBoundScope("com.packproof.mobile", "actor-a", scope, "https://api.example.test|actor-b") }
    denied { ResearchCapturePolicy.requireBoundScope("com.packproof.mobile", "actor-a", scope, "https://other.example.test|actor-a") }
    ResearchCapturePolicy.requireBoundScope("com.packproof.mobile.research", "legacy-actor", "", scope)
  }
}
