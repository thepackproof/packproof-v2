package com.packproof.attestation

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.Executors

/**
 * Receives only Android authentication outcomes. Biometrics never enter this module.
 * The non-exportable key authorizes one signature per successful strong biometric prompt.
 * The caller sends the resulting public key and signature to the attestation verifier.
 */
class AttestationModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val keyExecutor = Executors.newSingleThreadExecutor()
  // Operation state is confined to the main queue. The worker only returns its
  // result through mainHandler, so preparation and signing cannot overlap.
  private var active: SigningRequest? = null
  private var preparing: KeyPreparation? = null
  private var destroyed = false

  private class KeyPreparation(val promise: Promise) {
    var cancelled = false
  }

  private class AttestationFailure(val code: String, override val message: String) : Exception(message)

  private class SigningRequest(
    val promise: Promise,
    val activity: FragmentActivity,
    val payload: ByteArray,
  ) {
    var prompt: BiometricPrompt? = null
    var observer: LifecycleEventObserver? = null
    var timeout: Runnable? = null
    var failures = 0
  }

  override fun definition() = ModuleDefinition {
    Name("PackProofAttestation")

    AsyncFunction("getAvailability") { promise: Promise ->
      val failure = availabilityFailure()
      promise.resolve(if (failure == null) mapOf("available" to true) else mapOf(
        "available" to false, "code" to failure.code, "message" to failure.message,
      ))
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("prepareKey") { userId: String, promise: Promise ->
      try {
        ensureIdle()
        availabilityFailure()?.let { throw it }
        val request = KeyPreparation(promise)
        preparing = request
        keyExecutor.execute {
          try {
            val publicKey = preparePublicKey(userId)
            mainHandler.post { completePreparation(request, publicKey, null) }
          } catch (error: Exception) {
            val failure = safeFailure(error)
            mainHandler.post { completePreparation(request, null, failure) }
          }
        }
      } catch (error: Exception) {
        if (preparing?.promise === promise) preparing = null
        reject(promise, error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("sign") { userId: String, payload: String, promise: Promise ->
      try {
        ensureIdle()
        availabilityFailure()?.let { throw it }
        val activity = appContext.currentActivity as? FragmentActivity
          ?: throw AttestationFailure("ATTESTATION_ACTIVITY_UNAVAILABLE", "Reopen PackProof to attest and submit.")
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) || activity.supportFragmentManager.isStateSaved) {
          throw AttestationFailure("ATTESTATION_ACTIVITY_UNAVAILABLE", "Keep PackProof open to attest and submit.")
        }
        val bytes = payload.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty() || bytes.size > 32_768) {
          throw AttestationFailure("ATTESTATION_INVALID_PAYLOAD", "The attestation request is invalid. Try again.")
        }
        val signature = signingOperation(keyStore(), keyAlias(userId))
        val request = SigningRequest(promise, activity, bytes)
        active = request
        presentPrompt(request, signature)
      } catch (error: Exception) {
        val request = active
        if (request?.promise === promise) {
          val failure = safeFailure(error)
          fail(request, failure.code, failure.message, cancelPrompt = true)
        } else {
          reject(promise, error)
        }
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("cancel") {
      cancelPreparation()
      cancelActive()
    }.runOnQueue(Queues.MAIN)

    // A biometric dialog may pause the Activity, so only cancel key preparation
    // here. The signing prompt continues to use its ON_STOP lifecycle observer.
    OnActivityEntersBackground { mainHandler.post { cancelPreparation() } }
    OnActivityDestroys { mainHandler.post { cancelPreparation(); cancelActive() } }
    OnDestroy {
      mainHandler.post {
        destroyed = true
        cancelPreparation()
        cancelActive()
        // Keystore generation may not be interruptible. Let its worker finish;
        // its cancelled result is discarded without resolving the promise twice.
        keyExecutor.shutdown()
      }
    }
  }

  private fun ensureIdle() {
    if (destroyed) {
      throw AttestationFailure("ATTESTATION_ACTIVITY_UNAVAILABLE", "Reopen PackProof to attest and submit.")
    }
    if (active != null || preparing != null) {
      throw AttestationFailure("BIOMETRIC_BUSY", "An attestation is already in progress.")
    }
  }

  /** Runs only on keyExecutor, including enrollment checks and key generation. */
  private fun preparePublicKey(userId: String): String {
    val alias = keyAlias(userId)
    val store = keyStore()
    if (store.containsAlias(alias)) {
      try {
        // This initialization checks enrollment invalidation without authenticating.
        signingOperation(store, alias)
      } catch (_: KeyPermanentlyInvalidatedException) {
        store.deleteEntry(alias)
      }
    }
    if (!store.containsAlias(alias)) generateKey(alias)
    val publicKey = store.getCertificate(alias)?.publicKey
      ?: throw AttestationFailure("ATTESTATION_KEY_UNAVAILABLE", "The attestation key could not be prepared. Try again.")
    return Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP)
  }

  /** Called only on the main queue, after the worker has stopped using the key. */
  private fun completePreparation(request: KeyPreparation, publicKey: String?, failure: AttestationFailure?) {
    if (preparing !== request) return
    preparing = null
    if (request.cancelled || destroyed) return
    if (failure != null) request.promise.reject(failure.code, failure.message, null)
    else request.promise.resolve(mapOf("publicKey" to publicKey))
  }

  private fun cancelPreparation() {
    val request = preparing ?: return
    if (request.cancelled) return
    request.cancelled = true
    // Retain the operation lock until the worker actually returns. Clearing it
    // here could let sign use a key while generation or replacement is ongoing.
    request.promise.reject("BIOMETRIC_CANCELLED", "Attestation cancelled. Your recording has not been submitted.", null)
  }

  private fun availabilityFailure(): AttestationFailure? {
    val context = appContext.reactContext
      ?: return AttestationFailure("ATTESTATION_ACTIVITY_UNAVAILABLE", "Reopen PackProof to attest and submit.")
    return when (BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> null
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> AttestationFailure(
        "BIOMETRIC_NOT_ENROLLED", "Set up fingerprint or another strong biometric in Android Settings, then try again.",
      )
      BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> AttestationFailure(
        "BIOMETRIC_UNSUPPORTED", "This device does not support the strong biometric authentication needed to submit.",
      )
      BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> AttestationFailure(
        "BIOMETRIC_SECURITY_UPDATE_REQUIRED", "Install your device's security update before using biometric attestation.",
      )
      else -> AttestationFailure("BIOMETRIC_UNAVAILABLE", "Biometric authentication is unavailable. Try again when your device is ready.")
    }
  }

  private fun keyAlias(userId: String): String {
    if (userId.isBlank() || userId.length > 256) {
      throw AttestationFailure("ATTESTATION_INVALID_ACCOUNT", "Sign in again before attesting to this Proof.")
    }
    val digest = MessageDigest.getInstance("SHA-256").digest(userId.toByteArray(Charsets.UTF_8))
    return "packproof.attestation.v1." + digest.joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  private fun generateKey(alias: String) {
    val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      builder.setInvalidatedByBiometricEnrollment(true)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      // Zero means every cryptographic operation requires fresh strong biometric auth.
      builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      builder.setUserAuthenticationValidityDurationSeconds(-1)
    }
    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
      initialize(builder.build())
      generateKeyPair()
    }
  }

  private fun signingOperation(store: KeyStore, alias: String): Signature {
    val privateKey = store.getKey(alias, null) as? PrivateKey
      ?: throw AttestationFailure("ATTESTATION_KEY_UNAVAILABLE", "Prepare a new attestation request and try again.")
    return Signature.getInstance("SHA256withECDSA").apply { initSign(privateKey) }
  }

  private fun presentPrompt(request: SigningRequest, signature: Signature) {
    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        if (active !== request) return
        try {
          if (result.authenticationType != BiometricPrompt.AUTHENTICATION_RESULT_TYPE_BIOMETRIC) {
            throw AttestationFailure("BIOMETRIC_REQUIRED", "Strong biometric authentication is required to attest.")
          }
          val authorized = result.cryptoObject?.signature
            ?: throw AttestationFailure("BIOMETRIC_REQUIRED", "The attestation was not authorized. Try again.")
          authorized.update(request.payload)
          val signed = Base64.encodeToString(authorized.sign(), Base64.NO_WRAP)
          finish(request)
          request.prompt = null
          request.promise.resolve(mapOf("signature" to signed))
        } catch (error: Exception) {
          val failure = safeFailure(error)
          fail(request, failure.code, failure.message)
        }
      }

      override fun onAuthenticationFailed() {
        if (active !== request) return
        request.failures += 1
        if (request.failures >= 5) {
          fail(request, "BIOMETRIC_NOT_RECOGNIZED", "Biometric authentication was not recognized. Try again.", cancelPrompt = true)
        }
      }

      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        // Do not log or forward vendor text, which is unnecessary for attestation.
        val failure = when (errorCode) {
          BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON, BiometricPrompt.ERROR_CANCELED ->
            AttestationFailure("BIOMETRIC_CANCELLED", "Attestation cancelled. Your recording has not been submitted.")
          BiometricPrompt.ERROR_LOCKOUT ->
            AttestationFailure("BIOMETRIC_LOCKED_OUT", "Biometric authentication is temporarily locked. Wait and try again.")
          BiometricPrompt.ERROR_LOCKOUT_PERMANENT ->
            AttestationFailure("BIOMETRIC_LOCKED_OUT", "Unlock your device to re-enable biometrics, then return to PackProof and try again.")
          BiometricPrompt.ERROR_NO_BIOMETRICS ->
            AttestationFailure("BIOMETRIC_NOT_ENROLLED", "Set up fingerprint or another strong biometric in Android Settings, then try again.")
          BiometricPrompt.ERROR_TIMEOUT ->
            AttestationFailure("BIOMETRIC_TIMEOUT", "Biometric authentication timed out. Try again.")
          BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED ->
            AttestationFailure("BIOMETRIC_SECURITY_UPDATE_REQUIRED", "Install your device's security update before using biometric attestation.")
          else -> AttestationFailure("BIOMETRIC_UNAVAILABLE", "Biometric authentication could not finish. Try again.")
        }
        fail(request, failure.code, failure.message)
      }
    }
    request.prompt = BiometricPrompt(request.activity, ContextCompat.getMainExecutor(request.activity), callback)
    request.observer = LifecycleEventObserver { _, event ->
      // A system biometric dialog may pause an Activity. Cancel only when it stops,
      // so normal prompt display does not cancel itself on affected Android devices.
      if (event == Lifecycle.Event.ON_STOP || event == Lifecycle.Event.ON_DESTROY) {
        fail(request, "BIOMETRIC_CANCELLED", "Attestation cancelled. Return to PackProof to try again.", cancelPrompt = true)
      }
    }.also { request.activity.lifecycle.addObserver(it) }
    request.timeout = Runnable {
      fail(request, "BIOMETRIC_TIMEOUT", "Biometric authentication timed out. Try again.", cancelPrompt = true)
    }.also { mainHandler.postDelayed(it, 90_000L) }

    val promptInfo = BiometricPrompt.PromptInfo.Builder()
      .setTitle("Confirm and submit")
      .setDescription("The item shown and attached in this Proof is the item I am shipping")
      .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
      .setConfirmationRequired(true)
      .setNegativeButtonText("Cancel")
      .build()
    request.prompt?.authenticate(promptInfo, BiometricPrompt.CryptoObject(signature))
  }

  private fun finish(request: SigningRequest): Boolean {
    if (active !== request) return false
    active = null
    request.timeout?.let { mainHandler.removeCallbacks(it) }
    request.observer?.let { request.activity.lifecycle.removeObserver(it) }
    request.timeout = null
    request.observer = null
    request.payload.fill(0)
    return true
  }

  private fun fail(request: SigningRequest, code: String, message: String, cancelPrompt: Boolean = false) {
    if (!finish(request)) return
    try {
      if (cancelPrompt) request.prompt?.cancelAuthentication()
    } catch (_: Exception) {
      // Some vendor prompts can disappear concurrently with Activity destruction.
      // The request is already terminal; always settle the JavaScript promise.
    } finally {
      request.prompt = null
      request.promise.reject(code, message, null)
    }
  }

  private fun cancelActive() {
    active?.let { fail(it, "BIOMETRIC_CANCELLED", "Attestation cancelled. Your recording has not been submitted.", cancelPrompt = true) }
  }

  private fun safeFailure(error: Exception): AttestationFailure = when (error) {
    is AttestationFailure -> error
    is KeyPermanentlyInvalidatedException -> AttestationFailure(
      "ATTESTATION_KEY_INVALIDATED", "Your device's biometric settings changed. Start a new attestation request and try again.",
    )
    else -> AttestationFailure("ATTESTATION_SIGNING_FAILED", "Your device could not sign this attestation. Try again.")
  }

  private fun reject(promise: Promise, error: Exception) {
    val failure = safeFailure(error)
    // Deliberately exclude causes and native exception messages from the JS bridge.
    promise.reject(failure.code, failure.message, null)
  }
}
