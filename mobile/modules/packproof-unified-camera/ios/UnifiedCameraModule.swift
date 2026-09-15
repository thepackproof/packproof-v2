import ExpoModulesCore
import Foundation

public final class UnifiedCameraModule: Module {
  private let inspectionQueue = DispatchQueue(label: "com.packproof.camera.inspection", qos: .utility)

  public func definition() -> ModuleDefinition {
    Name("PackProofUnifiedCamera")

    Function("newOperationNonce") { UUID().uuidString }
    Function("identifierScannerVersion") { 1 }
    // iOS provides no public switch for reading the global system haptics preference;
    // system haptics APIs apply the user's settings when the caller requests feedback.
    AsyncFunction("getHapticsEnabled") { true }

    AsyncFunction("bindCaptureContext") { (sessionID: String, proofID: String, contextJSON: String, promise: Promise) in
      self.inspectionQueue.async {
        do {
          try CaptureJournal.bind(sessionID: sessionID, proofID: proofID, contextJSON: contextJSON)
          promise.resolve(nil)
        } catch { promise.reject("CAPTURE_BINDING_FAILED", "The recording could not be bound safely. Open its original order.") }
      }
    }

    AsyncFunction("readCaptureJournal") { (sessionID: String, promise: Promise) in
      self.inspectionQueue.async {
        do { promise.resolve(try CaptureJournal.read(sessionID: sessionID)) }
        catch { promise.reject("CAPTURE_JOURNAL_UNAVAILABLE", "The recording journal is unavailable. Keep the original.") }
      }
    }

    AsyncFunction("inspectRecordedVideo") { (sessionID: String, offsetsMs: [Double], promise: Promise) in
      self.inspect(sessionID: sessionID, offsetsMs: offsetsMs, identifiersEnabled: false, promise: promise)
    }
    AsyncFunction("inspectIdentifierVideo") { (sessionID: String, offsetsMs: [Double], promise: Promise) in
      self.inspect(sessionID: sessionID, offsetsMs: offsetsMs, identifiersEnabled: true, promise: promise)
    }

    View(UnifiedCameraView.self) {
      Events("onReady", "onBarcodeDetected", "onRecordingStarted", "onCaptureError")
      Prop("active") { (view: UnifiedCameraView, active: Bool) in view.setActive(active) }
      Prop("torchEnabled") { (view: UnifiedCameraView, enabled: Bool) in view.setTorchEnabled(enabled) }
      Prop("identifierCaptureEnabled") { (view: UnifiedCameraView, enabled: Bool) in view.setIdentifierCaptureEnabled(enabled) }
      AsyncFunction("startRecording") { (view: UnifiedCameraView, sessionID: String, audioEnabled: Bool, promise: Promise) in
        view.startRecording(sessionID: sessionID, audioEnabled: audioEnabled, promise: promise)
      }
      AsyncFunction("stopRecording") { (view: UnifiedCameraView) in view.stopRecording() }
    }
  }

  private func inspect(sessionID: String, offsetsMs: [Double], identifiersEnabled: Bool, promise: Promise) {
    inspectionQueue.async {
      do { promise.resolve(try EncodedBarcodeReader.inspect(sessionID: sessionID, offsetsMs: Array(offsetsMs.prefix(8)), identifiersEnabled: identifiersEnabled)) }
      catch { promise.reject("CAPTURE_REVIEW_UNAVAILABLE", "The recording is kept. Automatic code review could not finish.") }
    }
  }
}
