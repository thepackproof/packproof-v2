import AVFoundation
import ExpoModulesCore
import UIKit

/// One camera owner supplies the preview, the H.264 MP4 writer, and Apple's live barcode decoder.
/// All acquisition state belongs to captureQueue; only UIKit/layer work runs on the main queue.
final class UnifiedCameraView: ExpoView, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureMetadataOutputObjectsDelegate {
  let onReady = EventDispatcher()
  let onBarcodeDetected = EventDispatcher()
  let onRecordingStarted = EventDispatcher()
  let onCaptureError = EventDispatcher()

  private let captureQueue = DispatchQueue(label: "com.packproof.camera.capture", qos: .userInitiated)
  private let completionQueue = DispatchQueue(label: "com.packproof.camera.completion", qos: .utility)
  private let captureSession = AVCaptureSession()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let metadataOutput = AVCaptureMetadataOutput()
  private var previewLayer: AVCaptureVideoPreviewLayer!
  private var device: AVCaptureDevice?
  private var configured = false
  private var desiredActive = false
  private var attached = false
  private var foreground = true
  private var ready = false
  private var torchRequested = false
  private var identifiersEnabled = false
  private var current: Recording?
  private var recentCodes: [String: Double] = [:]
  private var candidateReads: [String: (time: Double, count: Int)] = [:]
  private var notificationTokens: [NSObjectProtocol] = []
  private var eventRecording: Recording? // main queue only: suppress stale React events
  // Only accessed on main. This grants time to finalize, never background camera access.
  private var backgroundTask = UIBackgroundTaskIdentifier.invalid

  private final class Recording {
    let url: URL
    let promise: Promise
    let journal: CaptureJournal?
    let maxDurationMs: Int64
    let maxBytes: Int64
    var writer: AVAssetWriter?
    var input: AVAssetWriterInput?
    var startPTS: CMTime?
    var lastPTS: CMTime?
    var lastSampleDuration = CMTime(value: 1, timescale: 30)
    var startedUnixMs: Double = 0
    var durationMs: Int64 = 0
    var frameWidth = 0
    var frameHeight = 0
    var stopping = false
    var interrupted = false
    var lastStorageCheck = 0.0
    var lastBackpressureReport: Int64 = -1_000
    var lastMetadataMs = 0.0
    var completionExpired = false // completionQueue only

    init(url: URL, promise: Promise, proofCapture: Bool) {
      self.url = url
      self.promise = promise
      maxDurationMs = proofCapture ? 300_000 : 600_000
      maxBytes = proofCapture ? 250_000_000 : 512 * 1024 * 1024
      let directory = url.deletingLastPathComponent()
      journal = CaptureStorage.fileManager.fileExists(atPath: directory.appendingPathComponent("capture-context.json").path)
        ? CaptureJournal(directory: directory) : nil
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    previewLayer = AVCaptureVideoPreviewLayer(session: captureSession)
    previewLayer.videoGravity = .resizeAspectFill
    layer.insertSublayer(previewLayer, at: 0)
    foreground = UIApplication.shared.applicationState == .active
    let center = NotificationCenter.default
    notificationTokens.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      self?.willLeaveForeground()
    })
    notificationTokens.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async { self.foreground = true; self.ensureCamera() }
    })
    notificationTokens.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: captureSession, queue: nil) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async { self.interrupt("CAMERA_INTERRUPTED"); self.releaseCamera() }
    })
    notificationTokens.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: captureSession, queue: nil) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async { self.ensureCamera() }
    })
    notificationTokens.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: captureSession, queue: nil) { [weak self] _ in
      guard let self else { return }
      self.captureQueue.async {
        self.interrupt("CAMERA_RUNTIME_ERROR")
        self.releaseCamera()
        self.reportError("CAMERA_UNAVAILABLE", "The camera stopped. Any saved recording is kept; reopen the camera to continue.")
      }
    })
  }

  deinit {
    notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
    // During finalization an asynchronous completion retains this view through its durable receipt.
    videoOutput.setSampleBufferDelegate(nil, queue: nil)
    metadataOutput.setMetadataObjectsDelegate(nil, queue: nil)
    let session = captureSession
    captureQueue.async { if session.isRunning { session.stopRunning() } }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
    if let connection = previewLayer.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    let isAttached = window != nil
    captureQueue.async {
      self.attached = isAttached
      if isAttached { self.ensureCamera() }
      else { self.interrupt("VIEW_DETACHED"); self.releaseCamera() }
    }
  }

  func setActive(_ active: Bool) {
    if !active { eventRecording = nil }
    captureQueue.async {
      self.desiredActive = active
      if active { self.ensureCamera() }
      else { self.interrupt("CAPTURE_DEACTIVATED"); self.releaseCamera() }
    }
  }

  func setTorchEnabled(_ enabled: Bool) {
    captureQueue.async { self.torchRequested = enabled; self.applyTorch() }
  }

  func setIdentifierCaptureEnabled(_ enabled: Bool) {
    captureQueue.async {
      guard self.current == nil else { return }
      self.identifiersEnabled = enabled
      if self.configured { self.configureMetadataTypes() }
    }
  }

  private var mayCapture: Bool { desiredActive && attached && foreground }

  private func ensureCamera() {
    guard mayCapture, current == nil else { return }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      reportError("CAMERA_PERMISSION_REQUIRED", "Allow camera access in Settings before recording.")
      return
    }
    do {
      if !configured {
        guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
          reportError("CAMERA_UNAVAILABLE", "A rear camera is required to record packing evidence.")
          return
        }
        let input = try AVCaptureDeviceInput(device: camera)
        captureSession.beginConfiguration()
        // Roll back all partial configuration before returning an unsupported-combination error.
        var succeeded = false
        defer {
          if !succeeded {
            captureSession.inputs.forEach(captureSession.removeInput)
            captureSession.outputs.forEach(captureSession.removeOutput)
          }
          captureSession.commitConfiguration()
        }
        captureSession.automaticallyConfiguresApplicationAudioSession = false
        if captureSession.canSetSessionPreset(.hd1920x1080) { captureSession.sessionPreset = .hd1920x1080 }
        else if captureSession.canSetSessionPreset(.hd1280x720) { captureSession.sessionPreset = .hd1280x720 }
        guard captureSession.canAddInput(input) else { throw CaptureFailure.invalidVideo }
        captureSession.addInput(input)
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
        guard captureSession.canAddOutput(videoOutput) else { throw CaptureFailure.invalidVideo }
        captureSession.addOutput(videoOutput)
        guard captureSession.canAddOutput(metadataOutput) else { throw CaptureFailure.invalidVideo }
        captureSession.addOutput(metadataOutput)
        metadataOutput.setMetadataObjectsDelegate(self, queue: captureQueue)
        configureMetadataTypes()
        guard !metadataOutput.metadataObjectTypes.isEmpty else { throw CaptureFailure.invalidVideo }
        if let connection = videoOutput.connection(with: .video), connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
          if connection.isVideoMirroringSupported { connection.isVideoMirrored = false }
        }
        device = camera
        configured = true
        succeeded = true
      }
      if !captureSession.isRunning {
        ready = false
        captureSession.startRunning()
      }
      applyTorch()
    } catch { reportError("CAMERA_COMBINATION_UNSUPPORTED", "This device could not start recording and barcode detection together.") }
  }

  private func configureMetadataTypes() {
    metadataOutput.metadataObjectTypes = metadataOutput.availableMetadataObjectTypes.filter {
      guard let format = BarcodePayloadPolicy.format($0.rawValue) else { return false }
      return BarcodePayloadPolicy.allows(format: format, identifiersEnabled: identifiersEnabled)
    }
  }

  private func applyTorch() {
    guard let device, device.hasTorch else { return }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      let mode: AVCaptureDevice.TorchMode = torchRequested && mayCapture ? .on : .off
      if device.isTorchModeSupported(mode) { device.torchMode = mode }
    } catch { reportError("TORCH_UNAVAILABLE", "The light could not be changed. Recording can continue.") }
  }

  func startRecording(sessionID: String, audioEnabled: Bool, promise: Promise) {
    captureQueue.async {
      guard self.current == nil else {
        promise.reject("RECORDING_ALREADY_ACTIVE", "A recording is already active."); return
      }
      guard self.mayCapture, self.ready, self.captureSession.isRunning else {
        promise.reject("CAMERA_NOT_READY", "Wait for the camera preview before recording."); return
      }
      guard !audioEnabled else {
        promise.reject("SILENT_CAPTURE_REQUIRED", "PackProof evidence is recorded without sound."); return
      }
      do {
        let directory = try CaptureStorage.directory(sessionID, proofOnly: false)
        try CaptureStorage.prepareDirectory(directory)
        guard CaptureStorage.availableBytes(directory) >= 64 * 1024 * 1024 else {
          promise.reject("CAPTURE_STORAGE_LOW", "Free some device storage before recording. Existing recordings are kept."); return
        }
        let url = try CaptureStorage.reserveVideo(directory)
        let recording = Recording(url: url, promise: promise, proofCapture: sessionID.hasPrefix("cap_"))
        self.current = recording
        self.recentCodes.removeAll()
        self.candidateReads.removeAll()
        self.captureQueue.asyncAfter(deadline: .now() + 15) {
          if self.current === recording && recording.startPTS == nil {
            self.interrupt("RECORDING_START_TIMEOUT")
          }
        }
      } catch CaptureFailure.sessionExists {
        promise.reject("CAPTURE_SESSION_EXISTS", "Start a new capture session to record another video.")
      } catch {
        promise.reject("RECORDING_START_FAILED", "The camera could not start saving this video.")
      }
    }
  }

  func stopRecording() {
    eventRecording = nil
    captureQueue.async { self.finishRecording() }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    guard mayCapture, CMSampleBufferDataIsReady(sampleBuffer) else { return }
    if !ready {
      ready = true
      DispatchQueue.main.async { self.onReady([:]) }
    }
    guard let recording = current, !recording.stopping,
      let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
    let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard timestamp.isValid, timestamp.isNumeric else { return }
    do {
      if recording.writer == nil {
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let writer = try AVAssetWriter(outputURL: recording.url, fileType: .mp4)
        let compression: [String: Any] = [AVVideoAverageBitRateKey: 5_000_000,
          AVVideoExpectedSourceFrameRateKey: 30, AVVideoMaxKeyFrameIntervalKey: 30,
          AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]
        let settings: [String: Any] = [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: width, AVVideoHeightKey: height,
          AVVideoCompressionPropertiesKey: compression]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { throw CaptureFailure.invalidVideo }
        writer.add(input)
        writer.shouldOptimizeForNetworkUse = true
        guard writer.startWriting() else { throw writer.error ?? CaptureFailure.invalidVideo }
        writer.startSession(atSourceTime: timestamp)
        recording.writer = writer
        recording.input = input
        recording.startPTS = timestamp
        recording.frameWidth = width
        recording.frameHeight = height
      }
      guard let start = recording.startPTS, let writer = recording.writer, let input = recording.input else { return }
      if writer.status == .failed { throw writer.error ?? CaptureFailure.invalidVideo }
      let elapsed = CMTimeGetSeconds(CMTimeSubtract(timestamp, start)) * 1000
      guard elapsed.isFinite, elapsed >= 0 else { return }
      if elapsed >= Double(recording.maxDurationMs) { interrupt("DURATION_LIMIT"); return }
      if let last = recording.lastPTS, CMTimeCompare(timestamp, last) <= 0 { return }
      guard input.isReadyForMoreMediaData else {
        if Int64(elapsed) - recording.lastBackpressureReport >= 1_000 {
          recording.interrupted = true
          recording.journal?.append("INTERRUPTION", mediaTimeMs: Int64(elapsed), value: "ENCODER_BACKPRESSURE")
          recording.lastBackpressureReport = Int64(elapsed)
        }
        return
      }
      guard input.append(sampleBuffer) else { throw writer.error ?? CaptureFailure.invalidVideo }
      if recording.lastPTS == nil {
        recording.startedUnixMs = Date().timeIntervalSince1970 * 1000
        recording.journal?.start()
        DispatchQueue.main.async {
          self.eventRecording = recording
          self.onRecordingStarted(["startedAtUnixMs": recording.startedUnixMs])
        }
      } else if let previous = recording.lastPTS, CMTimeGetSeconds(CMTimeSubtract(timestamp, previous)) > 1 {
        recording.interrupted = true
        recording.journal?.append("INTERRUPTION", mediaTimeMs: Int64(elapsed), value: "CAMERA_FRAME_GAP")
      }
      recording.lastPTS = timestamp
      let sampleDuration = CMSampleBufferGetDuration(sampleBuffer)
      if sampleDuration.isValid, sampleDuration.isNumeric,
        CMTimeCompare(sampleDuration, .zero) > 0,
        CMTimeGetSeconds(sampleDuration) <= 1 { recording.lastSampleDuration = sampleDuration }
      recording.durationMs = Int64(elapsed)
      let now = ProcessInfo.processInfo.systemUptime
      if now - recording.lastStorageCheck >= 1 {
        recording.lastStorageCheck = now
        if CaptureStorage.availableBytes(recording.url.deletingLastPathComponent()) < 16 * 1024 * 1024 { interrupt("STORAGE_PRESSURE") }
        else if CaptureStorage.bytes(recording.url) >= recording.maxBytes - 5_000_000 { interrupt("FILE_SIZE_LIMIT") }
      }
    } catch {
      recording.interrupted = true
      recording.journal?.append("INTERRUPTION", mediaTimeMs: recording.durationMs, value: "ENCODER_ERROR")
      finishRecording()
    }
  }

  func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
    guard mayCapture, let recording = current, !recording.stopping, recording.lastPTS != nil else { return }
    let now = ProcessInfo.processInfo.systemUptime * 1000
    guard now - recording.lastMetadataMs >= 150 else { return }
    recording.lastMetadataMs = now
    for object in metadataObjects {
      guard let code = object as? AVMetadataMachineReadableCodeObject, let value = code.stringValue,
        let format = BarcodePayloadPolicy.format(code.type.rawValue),
        let (raw, normalizedFormat) = BarcodePayloadPolicy.payload(value, format: format, identifiersEnabled: identifiersEnabled) else { continue }
      let identity = "\(normalizedFormat):\(raw)"
      let prior = candidateReads[identity]
      let count = prior.map { now - $0.time <= 2_000 ? $0.count + 1 : 1 } ?? 1
      candidateReads[identity] = (now, count)
      if candidateReads.count > 256 { candidateReads = candidateReads.filter { now - $0.value.time < 2_000 } }
      if candidateReads.count > 256 { candidateReads = [identity: (now, count)] }
      guard count >= 2, now - (recentCodes[identity] ?? -10_000) >= 3_000 else { continue }
      recentCodes[identity] = now
      if recentCodes.count > 128 { recentCodes = recentCodes.filter { now - $0.value < 3_000 } }
      let minimized = BarcodePayloadPolicy.identity(raw)
      if !identifiersEnabled, minimized.range(of: "^[A-Z0-9]{10,64}$", options: .regularExpression) != nil {
        recording.journal?.append("LABEL", mediaTimeMs: recording.durationMs, value: minimized)
      }
      // AVFoundation metadata is in normalized sensor coordinates; use the video connection's
      // conversion so bounds describe the portrait pixels actually delivered to our writer.
      guard let videoConnection = videoOutput.connection(with: .video) else { continue }
      let transformed = videoOutput.transformedMetadataObject(for: code, connection: videoConnection)
      let bounds = transformed?.bounds
      let event: [String: Any] = ["rawValue": raw, "format": normalizedFormat,
        "rawBytes": NSNull(), "decoderEncoding": NSNull(), "symbologyIdentifier": NSNull(),
        "detectedAtMs": Double(recording.durationMs),
        "detectedAtUnixMs": recording.startedUnixMs + Double(recording.durationMs),
        "latencyMs": 0, "timestampUncertaintyMs": NSNull(),
        "source": "LIVE_CAMERA_ANALYSIS", "coordinateSpace": "ROTATED_ANALYSIS_PIXELS",
        "decoderVersion": "apple-avfoundation-\(ProcessInfo.processInfo.operatingSystemVersionString)",
        "frameWidth": recording.frameWidth, "frameHeight": recording.frameHeight,
        "bounds": bounds.map { ["left": $0.minX, "top": $0.minY, "right": $0.maxX, "bottom": $0.maxY] } as Any? ?? NSNull()]
      DispatchQueue.main.async {
        guard self.eventRecording === recording else { return }
        self.onBarcodeDetected(event)
      }
    }
  }

  private func interrupt(_ reason: String) {
    if let recording = current, !recording.stopping {
      recording.interrupted = true
      if recording.lastPTS != nil { recording.journal?.append("INTERRUPTION", mediaTimeMs: recording.durationMs, value: reason) }
      finishRecording()
    }
  }

  private func finishRecording() {
    guard let recording = current, !recording.stopping else { return }
    recording.stopping = true
    DispatchQueue.main.async { if self.eventRecording === recording { self.eventRecording = nil } }
    guard let writer = recording.writer, recording.lastPTS != nil, writer.status == .writing else {
      // cancelWriting deletes partial output. Keep any bytes for explicit recovery instead.
      fail(recording, code: "RECORDING_FINALIZE_FAILED", message: "This recording did not produce a completed video. Any local bytes were retained.")
      return
    }
    if let start = recording.startPTS, let last = recording.lastPTS {
      let limit = CMTimeAdd(start, CMTime(value: recording.maxDurationMs, timescale: 1000))
      writer.endSession(atSourceTime: CMTimeMinimum(CMTimeAdd(last, recording.lastSampleDuration), limit))
    }
    recording.input?.markAsFinished()
    captureQueue.asyncAfter(deadline: .now() + 20) {
      guard self.current === recording else { return }
      self.completionQueue.async {
        // A finished writer can still be syncing its durable journal. That is not a writer timeout.
        guard writer.status == .writing, !recording.completionExpired else { return }
        recording.completionExpired = true
        self.fail(recording, code: "RECORDING_FINALIZE_TIMEOUT", message: "The video could not finish saving. Any local bytes were retained for recovery.")
      }
    }
    writer.finishWriting {
      self.completionQueue.async {
        guard !recording.completionExpired else { return }
        guard writer.status == .completed else {
          self.fail(recording, code: "RECORDING_FINALIZE_FAILED", message: "This recording did not finish saving. Any local bytes were retained.")
          return
        }
        let asset = AVURLAsset(url: recording.url)
        let seconds = CMTimeGetSeconds(asset.duration)
        let bytes = CaptureStorage.bytes(recording.url)
        guard seconds.isFinite, seconds > 0, bytes > 0, bytes <= recording.maxBytes else {
          self.fail(recording, code: "RECORDING_FINALIZE_FAILED", message: "The saved video could not be verified. Its original bytes are kept.")
          return
        }
        let durationMs = Int64((seconds * 1000).rounded())
        let finalize: (Bool) -> Void = { journalSaved in
          guard journalSaved else {
            self.fail(recording, code: "RECORDING_RECOVERY_FAILED", message: "The original is kept, but its capture journal could not be saved.")
            return
          }
          do {
            // Flush the finished movie before publishing its durable completion receipt.
            let handle = try FileHandle(forWritingTo: recording.url)
            do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
            let marker: [String: Any] = ["complete": true, "durationMs": durationMs, "byteSize": bytes, "interrupted": recording.interrupted]
            try CaptureStorage.durableWrite(CaptureStorage.json(marker), to: recording.url.appendingPathExtension("finalized.json"))
            self.captureQueue.async {
              guard self.current === recording else { return }
              recording.promise.resolve(["uri": recording.url.absoluteString, "contentType": "video/mp4",
                "durationMs": durationMs, "byteSize": bytes, "interrupted": recording.interrupted])
              self.clear(recording)
            }
          } catch {
            self.fail(recording, code: "RECORDING_RECOVERY_FAILED", message: "The original is kept. Free local space to preserve its recovery journal.")
          }
        }
        if let journal = recording.journal { journal.finish(durationMs: durationMs, completion: finalize) }
        else { finalize(true) }
      }
    }
  }

  private func fail(_ recording: Recording, code: String, message: String) {
    captureQueue.async {
      guard self.current === recording else { return }
      recording.promise.reject(code, message)
      self.clear(recording)
    }
  }

  private func clear(_ recording: Recording) {
    if current === recording { current = nil }
    if !mayCapture { releaseCamera() }
    else { ensureCamera() }
    DispatchQueue.main.async { self.endBackgroundTask() }
  }

  private func releaseCamera() {
    ready = false
    if let device, device.hasTorch {
      do {
        try device.lockForConfiguration()
        if device.isTorchModeSupported(.off) { device.torchMode = .off }
        device.unlockForConfiguration()
      } catch { /* Session teardown still releases camera ownership if torch control is unavailable. */ }
    }
    if captureSession.isRunning { captureSession.stopRunning() }
  }

  private func willLeaveForeground() {
    eventRecording = nil
    if backgroundTask == .invalid {
      backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish PackProof recording") { [weak self] in
        self?.endBackgroundTask()
      }
    }
    captureQueue.async {
      self.foreground = false
      self.interrupt("BACKGROUND")
      self.releaseCamera()
      if self.current == nil { DispatchQueue.main.async { self.endBackgroundTask() } }
    }
  }

  private func endBackgroundTask() {
    guard backgroundTask != .invalid else { return }
    UIApplication.shared.endBackgroundTask(backgroundTask)
    backgroundTask = .invalid
  }

  private func reportError(_ code: String, _ message: String) {
    DispatchQueue.main.async { self.onCaptureError(["code": code, "message": message]) }
  }
}
