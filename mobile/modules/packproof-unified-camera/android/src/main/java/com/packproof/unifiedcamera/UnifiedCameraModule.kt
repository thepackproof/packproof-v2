package com.packproof.unifiedcamera

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class UnifiedCameraModule : Module() {
  private val inspectionExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
  override fun definition() = ModuleDefinition {
    Name("PackProofUnifiedCamera")
    Function("newOperationNonce") { java.util.UUID.randomUUID().toString() }

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
    OnDestroy { inspectionExecutor.shutdown() }

    View(UnifiedCameraView::class) {
      Events("onReady", "onBarcodeDetected", "onRecordingStarted", "onCaptureError")

      Prop("active") { view: UnifiedCameraView, active: Boolean ->
        view.setCaptureActive(active)
      }
      Prop("torchEnabled") { view: UnifiedCameraView, enabled: Boolean ->
        view.setTorchEnabled(enabled)
      }
      OnViewDidUpdateProps { view: UnifiedCameraView -> view.ensureCamera() }

      AsyncFunction("startRecording") { view: UnifiedCameraView, sessionId: String, audioEnabled: Boolean, promise: Promise ->
        view.startRecording(sessionId, audioEnabled, promise)
      }.runOnQueue(Queues.MAIN)

      AsyncFunction("stopRecording") { view: UnifiedCameraView ->
        view.stopRecording()
      }.runOnQueue(Queues.MAIN)

      OnViewDestroys { view: UnifiedCameraView -> view.destroy() }
    }
  }
}
