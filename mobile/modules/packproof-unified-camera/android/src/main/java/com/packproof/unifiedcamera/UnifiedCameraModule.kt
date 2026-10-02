package com.packproof.unifiedcamera

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class UnifiedCameraModule : Module() {
  private val researchAssurance = ResearchPlatformAssurance()
  private val inspectionExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
  override fun definition() = ModuleDefinition {
    Name("PackProofUnifiedCamera")
    Function("newOperationNonce") { java.util.UUID.randomUUID().toString() }
    Function("identifierScannerVersion") { 1 }
    AsyncFunction("beginUploadService") { operationId: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("App unavailable")
      UploadNotificationService.begin(context, operationId)
      true
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("endUploadService") { operationId: String ->
      UploadNotificationService.finish(operationId)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("notifyUploadComplete") { operationId: String, proofId: String ->
      val context = appContext.reactContext ?: throw IllegalStateException("App unavailable")
      UploadNotificationService.complete(context, operationId, proofId)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("setNotificationOptions") { enabled: Boolean, uploads: Boolean, muted: List<String> ->
      appContext.reactContext?.getSharedPreferences("packproof_notification_options", android.content.Context.MODE_PRIVATE)?.edit()
        ?.putBoolean("enabled", enabled)?.putBoolean("uploads", uploads)?.putStringSet("muted", muted.toSet())?.commit()
      true
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getHapticsEnabled") {
      val context = appContext.reactContext
      context != null && android.provider.Settings.System.getInt(context.contentResolver,
        android.provider.Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("inspectRecordedVideo") { sessionId: String, offsetsMs: List<Double>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.reject("CAPTURE_REVIEW_UNAVAILABLE", "Reopen the recording to check its label.", null)
      else inspectionExecutor.execute {
        try { promise.resolve(EncodedBarcodeReader.inspect(context, sessionId, offsetsMs)) }
        catch (_: Exception) { promise.reject("CAPTURE_REVIEW_UNAVAILABLE", "The recording is kept. Automatic label review could not finish.", null) }
      }
    }
    AsyncFunction("inspectIdentifierVideo") { sessionId: String, offsetsMs: List<Double>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.reject("CAPTURE_REVIEW_UNAVAILABLE", "Reopen the saved recording.", null)
      else inspectionExecutor.execute {
        try { promise.resolve(EncodedBarcodeReader.inspect(context, sessionId, offsetsMs, true)) }
        catch (_: Exception) { promise.reject("CAPTURE_REVIEW_UNAVAILABLE", "The recording is kept. Automatic code review could not finish.", null) }
      }
    }
    AsyncFunction("bindCaptureContext") { sessionId: String, proofId: String, contextJson: String, promise: Promise ->
      val context=appContext.reactContext
      if(context==null) promise.reject("CAPTURE_UNAVAILABLE","Open the camera again.",null)
      else inspectionExecutor.execute { try { CaptureJournal.bind(context,sessionId,proofId,contextJson);promise.resolve(null) }
        catch(_:Exception) { promise.reject("CAPTURE_BINDING_FAILED","The recording could not be bound safely. Open its original order.",null) } }
    }
    AsyncFunction("readCaptureJournal") { sessionId: String, promise: Promise ->
      val context=appContext.reactContext
      if(context==null) promise.reject("CAPTURE_UNAVAILABLE","Open the recording again.",null)
      else inspectionExecutor.execute { try { promise.resolve(CaptureJournal.read(context,sessionId)) }
        catch(_:Exception) { promise.reject("CAPTURE_JOURNAL_UNAVAILABLE","The recording journal is unavailable. Keep the original.",null) } }
    }
    AsyncFunction("bindResearchCapture") { session: String, proof: String, binding: String, promise: Promise ->
      inspectionExecutor.execute { try { ResearchProvenance.bind(appContext.reactContext!!, session, proof, binding); promise.resolve(null) }
        catch (_: Exception) { promise.reject("RND_BINDING_FAILED", "Optional research binding unavailable; original capture remains available.", null) } }
    }
    AsyncFunction("readResearchCapture") { session: String, promise: Promise ->
      inspectionExecutor.execute { try { promise.resolve(ResearchProvenance.read(appContext.reactContext!!, session)) }
        catch (_: Exception) { promise.reject("RND_CAPTURE_UNAVAILABLE", "Research metadata is pending or unavailable; original is kept.", null) } }
    }
    AsyncFunction("prepareResearchKey") { scope: String, promise: Promise ->
      inspectionExecutor.execute { try { promise.resolve(ResearchProvenance.prepare(appContext.reactContext!!, scope)) }
        catch (_: Exception) { promise.reject("RND_KEY_UNAVAILABLE", "Research signing key unavailable.", null) } }
    }
    AsyncFunction("signResearchCapture") { session: String, scope: String, payload: String, promise: Promise ->
      inspectionExecutor.execute { try { promise.resolve(ResearchProvenance.sign(appContext.reactContext!!, session, scope, payload)) }
        catch (_: Exception) { promise.reject("RND_SIGNING_FAILED", "Research signature unavailable; original is kept.", null) } }
    }
    AsyncFunction("requestAndroidKeyAttestation") { session: String, scope: String, challenge: String, payload: String, promise: Promise ->
      inspectionExecutor.execute { try { promise.resolve(ResearchKeyAttestation.request(appContext.reactContext!!, session, scope, challenge, payload)) }
        catch (_: Exception) { promise.reject("RND_KEY_ATTESTATION_UNAVAILABLE", "Optional fresh request-key attestation unavailable; original signer and capture are unchanged.", null) } }
    }
    AsyncFunction("preparePlayIntegrity") { project: String, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) promise.reject("RND_PLATFORM_UNAVAILABLE", "App unavailable", null) else researchAssurance.prepare(context, project, promise)
    }
    AsyncFunction("requestPlayIntegrity") { hash: String, promise: Promise -> researchAssurance.request(hash, promise) }
    OnDestroy { inspectionExecutor.shutdown() }

    View(UnifiedCameraView::class) {
      Events("onReady", "onBarcodeDetected", "onRecordingStarted", "onCaptureError")

      Prop("active") { view: UnifiedCameraView, active: Boolean ->
        view.setCaptureActive(active)
      }
      Prop("torchEnabled") { view: UnifiedCameraView, enabled: Boolean ->
        view.setTorchEnabled(enabled)
      }
      Prop("identifierCaptureEnabled") { view: UnifiedCameraView, enabled: Boolean ->
        view.setIdentifierCaptureEnabled(enabled)
      }
      OnViewDidUpdateProps { view: UnifiedCameraView -> view.ensureCamera() }

      AsyncFunction("startRecording") { view: UnifiedCameraView, sessionId: String, audioEnabled: Boolean, promise: Promise ->
        view.startRecording(sessionId, audioEnabled, promise)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("stopRecording") { view: UnifiedCameraView ->
        view.stopRecording()
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("disableResearchSampling") { view: UnifiedCameraView, reason: String -> view.disableResearchSampling(reason) }.runOnQueue(Queues.MAIN)
      OnViewDestroys { view: UnifiedCameraView -> view.destroy() }
    }
  }
}
