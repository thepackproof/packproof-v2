package com.packproof.unifiedcamera

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

/** Fresh request-key attestation; it never replaces or upgrades the original session signing key. */
object ResearchKeyAttestation {
  fun request(context: Context, session: String, scope: String, challengeBase64: String, payload: String): Map<String, Any> {
    check(context.packageName == "com.packproof.mobile.research" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
    require(challengeBase64.matches(Regex("[A-Za-z0-9+/]{43}=")) && payload.toByteArray(Charsets.UTF_8).size <= 32768)
    val challenge = Base64.decode(challengeBase64, Base64.NO_WRAP)
    require(challenge.size == 32)
    // Reuse native final-file validation; the immutable original signing key is unchanged.
    ResearchProvenance.sign(context, session, scope, payload)
    val alias = "packproof.research.request-attestation.v1." + ResearchCapture.sha256("$scope|$session".toByteArray())
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    if (store.containsAlias(alias)) store.deleteEntry(alias)
    try {
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
        initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256).setUserAuthenticationRequired(false)
          .setAttestationChallenge(challenge).build())
      }.generateKeyPair()
      val certificates = store.getCertificateChain(alias) ?: error("Attestation chain unavailable")
      check(certificates.size in 2..8 && certificates.all { it.encoded.size <= 16384 })
      val signer = Signature.getInstance("SHA256withECDSA").apply {
        initSign(store.getKey(alias, null) as java.security.PrivateKey)
        update(payload.toByteArray(Charsets.UTF_8))
      }
      return mapOf("certificateChainBase64" to certificates.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) },
        "publicKeySpki" to Base64.encodeToString(certificates[0].publicKey.encoded, Base64.NO_WRAP),
        "inventorySignatureBase64" to Base64.encodeToString(signer.sign(), Base64.NO_WRAP),
        "keyRole" to "ATTESTATION_REQUEST_KEY", "verification" to "NOT_CHECKED")
    } finally {
      // The signed SDK response is persisted by the caller; ephemeral hardware keys cannot accumulate.
      if (store.containsAlias(alias)) store.deleteEntry(alias)
    }
  }
}
