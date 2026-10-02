package com.packproof.unifiedcamera

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Session signatures are separate from biometric seller statements and platform attestation. */
object ResearchProvenance {
  private fun directory(context: Context, session: String): File {
    check(context.packageName == "com.packproof.mobile.research") { "Research app required" }
    require(session.matches(Regex("cap_[A-Za-z0-9_-]{1,91}")))
    return File(File(context.filesDir, "packproof-captures"), session)
  }
  fun bind(context: Context, session: String, proof: String, binding: String) {
    require(binding.toByteArray().size <= 65536)
    val json = JSONObject(binding)
    require(json.getString("captureSessionId") == session && json.getString("proofId") == proof)
    val directory = directory(context, session); directory.mkdirs()
    val file = File(directory, "research-context.json")
    if (file.exists()) { check(file.readText() == binding) { "Binding cannot change" }; return }
    check(!File(directory, "video.mp4").exists()) { "Binding must precede recording" }
    ResearchCapture.write(file, binding.toByteArray())
  }
  fun read(context: Context, session: String): String {
    val directory = directory(context, session)
    check(File(directory, "research-complete.json").exists()) { "Optional metadata still pending or unavailable" }
    check(File(directory, "video.mp4.finalized.json").exists()) { "Finalized original required" }
    val binding = File(directory, "research-context.json")
    val media = File(directory, "video.mp4")
    val acquisition = File(directory, "research-acquisition.json")
    val journal = File(directory, "native-journal.jsonl")
    val body = JSONObject().put("captureSessionId", session).put("binding", JSONObject(binding.readText()))
      .put("mediaSha256", digest(media)).put("mediaByteLength", media.length())
      .put("journalSha256", if (journal.exists()) digest(journal) else JSONObject.NULL)
      .put("acquisitionSha256", if (acquisition.exists()) digest(acquisition) else JSONObject.NULL)
      .put("acquisition", if (acquisition.exists()) JSONObject(acquisition.readText()) else JSONObject.NULL)
      .put("chainCoverage", "FINAL_FILE_ONLY").put("appAttestation", "NOT_CHECKED")
    return body.toString()
  }
  private fun alias(scope: String): String { require(scope.isNotEmpty() && scope.length <= 256); return "packproof.research.capture.v1." + ResearchCapture.sha256(scope.toByteArray()) }
  fun prepare(context: Context, scope: String): Map<String, String> {
    check(context.packageName == "com.packproof.mobile.research")
    val alias = alias(scope)
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (!store.containsAlias(alias)) {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false).build())
      }.generateKeyPair()
    }
    return mapOf("publicKeySpki" to Base64.encodeToString(store.getCertificate(alias).publicKey.encoded, Base64.NO_WRAP),
      "algorithm" to "ES256_DER", "keyProtection" to "ANDROID_KEYSTORE_UNVERIFIED", "appAttestation" to "NOT_CHECKED")
  }
  fun sign(context: Context, session: String, scope: String, payload: String): Map<String, String> {
    require(payload.toByteArray().size <= 131072)
    val root = directory(context, session)
    val record = JSONObject(read(context, session))
    val body = JSONObject(payload)
    // JS supplies canonical bytes, native authorizes only this immutable native original.
    require(body.getString("schemaVersion") == "packproof.native-final-file.v1" && body.getString("chainCoverage") == "FINAL_FILE_ONLY")
    require(body.getString("intentId") == record.getJSONObject("binding").getString("intentId"))
    require(body.getString("captureSessionId") == session && body.getString("proofId") == record.getJSONObject("binding").getString("proofId"))
    require(body.getString("mediaSha256").removePrefix("sha256:") == record.getString("mediaSha256"))
    require(body.getLong("mediaByteLength") == record.getLong("mediaByteLength"))
    require(body.optString("journalSha256").removePrefix("sha256:") == record.optString("journalSha256"))
    require(body.optString("acquisitionSha256").removePrefix("sha256:") == record.optString("acquisitionSha256"))
    val signatureFile = File(root, "research-signed-inventory.json")
    if (signatureFile.exists()) {
      val saved = JSONObject(signatureFile.readText()); check(saved.getString("payload") == payload) { "Sealed inventory cannot change" }
      return mapOf("signature" to saved.getString("signature"), "publicKeySpki" to saved.getString("publicKeySpki"), "algorithm" to "ES256_DER")
    }
    val public = prepare(context, scope)
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    val signer = Signature.getInstance("SHA256withECDSA").apply { initSign(store.getKey(alias(scope), null) as java.security.PrivateKey); update(payload.toByteArray(Charsets.UTF_8)) }
    val signature = Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    ResearchCapture.write(signatureFile, JSONObject().put("payload", payload).put("signature", signature).put("publicKeySpki", public.getValue("publicKeySpki")).toString().toByteArray())
    return mapOf("signature" to signature, "publicKeySpki" to public.getValue("publicKeySpki"), "algorithm" to "ES256_DER")
  }
  private fun digest(file: File): String {
    val hash = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input -> val buffer = ByteArray(262144); while (true) { val count = input.read(buffer); if (count <= 0) break; hash.update(buffer, 0, count) } }
    return hash.digest().joinToString("") { "%02x".format(it) }
  }
}
