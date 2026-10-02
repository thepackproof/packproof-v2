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

    AsyncFunction("bindResearchCapture") { (session: String, proof: String, binding: String, promise: Promise) in
      self.inspectionQueue.async {
        do { try ResearchProvenance.bind(session: session, proof: proof, binding: binding); promise.resolve(nil) }
        catch { promise.reject("RND_BINDING_FAILED", "Optional research binding unavailable; original capture remains available.") }
      }
    }
    AsyncFunction("readResearchCapture") { (session: String, promise: Promise) in
      self.inspectionQueue.async {
        do { let result = try ResearchProvenance.read(session); promise.resolve(String(data: try CaptureStorage.json(result), encoding: .utf8)) }
        catch { promise.reject("RND_CAPTURE_UNAVAILABLE", "Research metadata is pending or unavailable; original is kept.") }
      }
    }
    AsyncFunction("prepareResearchKey") { (scope: String, promise: Promise) in
      self.inspectionQueue.async {
        do { promise.resolve(try ResearchProvenance.prepare(scope)) }
        catch { promise.reject("RND_KEY_UNAVAILABLE", "Research signing key unavailable.") }
      }
    }
    AsyncFunction("signResearchCapture") { (session: String, scope: String, payload: String, promise: Promise) in
      self.inspectionQueue.async {
        do { promise.resolve(try ResearchProvenance.sign(session: session, scope: scope, payload: payload)) }
        catch { promise.reject("RND_SIGNING_FAILED", "Research signature unavailable; original is kept.") }
      }
    }

    Function("appAttestAvailability") { ResearchPlatformAssurance.availability() }
    AsyncFunction("generateAppAttestKey") { (promise: Promise) in ResearchPlatformAssurance.generate(promise) }
    AsyncFunction("requestAppAttest") { (key: String, hash: String, assertion: Bool, promise: Promise) in
      ResearchPlatformAssurance.request(key: key, hashBase64: hash, assertion: assertion, promise: promise)
    }
    View(UnifiedCameraView.self) {
      Events("onReady", "onBarcodeDetected", "onRecordingStarted", "onCaptureError")
      Prop("active") { (view: UnifiedCameraView, active: Bool) in view.setActive(active) }
      Prop("torchEnabled") { (view: UnifiedCameraView, enabled: Bool) in view.setTorchEnabled(enabled) }
      Prop("identifierCaptureEnabled") { (view: UnifiedCameraView, enabled: Bool) in view.setIdentifierCaptureEnabled(enabled) }
      AsyncFunction("startRecording") { (view: UnifiedCameraView, sessionID: String, audioEnabled: Bool, promise: Promise) in
        view.startRecording(sessionID: sessionID, audioEnabled: audioEnabled, promise: promise)
      }
      AsyncFunction("disableResearchSampling") { (view: UnifiedCameraView, reason: String) in view.disableResearchSampling(reason) }
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
