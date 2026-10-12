package com.packproof.unifiedcamera

import android.content.Context
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import expo.modules.kotlin.Promise

/** Returns an opaque Google token. Only the backend can validate it; no local success verdict. */
class ResearchPlatformAssurance {
  private var provider: StandardIntegrityManager.StandardIntegrityTokenProvider? = null
  fun prepare(context: Context, project: String, promise: Promise) {
    if (context.packageName != "com.packproof.mobile.research") { promise.reject("RND_DISABLED", "Research app required", null); return }
    val number = project.toLongOrNull()
    if (number == null || number <= 0) { promise.reject("RND_PLATFORM_NOT_CONFIGURED", "A laboratory Google Cloud project number is required", null); return }
    IntegrityManagerFactory.createStandard(context).prepareIntegrityToken(
      StandardIntegrityManager.PrepareIntegrityTokenRequest.builder().setCloudProjectNumber(number).build())
      .addOnSuccessListener { provider = it; promise.resolve(mapOf("prepared" to true, "verification" to "NOT_CHECKED")) }
      .addOnFailureListener { provider = null; promise.reject("RND_PLATFORM_UNAVAILABLE", "Play Integrity could not prepare this research build", it) }
  }
  fun request(hash: String, promise: Promise) {
    val current = provider
    if (current == null || !hash.matches(Regex("[A-Za-z0-9_-]{43}"))) { promise.reject("RND_PLATFORM_NOT_READY", "Prepare Play Integrity and provide the SHA-256 request binding", null); return }
    current.request(StandardIntegrityManager.StandardIntegrityTokenRequest.builder().setRequestHash(hash).build())
      .addOnSuccessListener { promise.resolve(mapOf("token" to it.token(), "verification" to "NOT_CHECKED", "requestHash" to hash)) }
      .addOnFailureListener { promise.reject("RND_PLATFORM_UNAVAILABLE", "Play Integrity request unavailable; camera recording is unaffected", it) }
  }
}
