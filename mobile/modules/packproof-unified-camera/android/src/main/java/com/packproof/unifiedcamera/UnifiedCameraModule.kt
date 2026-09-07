package com.packproof.unifiedcamera

import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class UnifiedCameraModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PackProofUnifiedCamera")
    Function("newOperationNonce") { java.util.UUID.randomUUID().toString() }

    AsyncFunction("getHapticsEnabled") {
      val context = appContext.reactContext
      context != null && android.provider.Settings.System.getInt(context.contentResolver,
        android.provider.Settings.System.HAPTIC_FEEDBACK_ENABLED, 1) != 0
    }.runOnQueue(Queues.MAIN)

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
