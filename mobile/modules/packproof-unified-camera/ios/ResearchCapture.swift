import AVFoundation
import CryptoKit
import Foundation

/// Shares AVFoundation's sample callback after encoder append. No second capture output or JS pixels.
final class ResearchCapture {
  private let queue = DispatchQueue(label: "com.packproof.camera.research", qos: .utility)
  private let lock = NSLock()
  private let directory: URL
  private let started = DispatchTime.now().uptimeNanoseconds
  private var busy = false
  private var ended = false
  private var disabled: String?
  private var lastSample: UInt64 = 0
  private var drops = 0
  private var count = 0
  private var lastTelemetry: Int64 = -1000
  private var frames: [[String: Any]?] = Array(repeating: nil, count: 6)
  private struct RegionFrame { let pts: CMTime; let luma: Data; let metadata: [String: Any]; let width: Int; let height: Int }
  private var regionFrame: RegionFrame?
  private var regionUnavailableReason = "NO_EXACT_BARCODE_FRAME"
  private var lastRegionMs: Int64 = -1000
  private var telemetry: [[String: Any]] = []
  private var controlEvents: [[String: Any]] = []
  private var challenge: [String: Any]? {
    guard let bytes = try? Data(contentsOf: directory.appendingPathComponent("research-context.json")),
      let binding = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
    return binding["passiveChallenge"] as? [String: Any]
  }
  func passiveLeaseDurationMs() -> Double {
    guard let challenge, challenge["mode"] as? String == "PASSIVE_LAB",
      challenge["activeIlluminationEnabled"] as? Bool == false, (challenge["commands"] as? [Any])?.isEmpty == true else { return 0 }
    return max(0, min(5000, (challenge["expiresAtMs"] as? Double ?? 0) - Date().timeIntervalSince1970 * 1000))
  }
  func controlEvent(_ type: String, reason: String) {
    let at = String(DispatchTime.now().uptimeNanoseconds-started)
    queue.async { if self.controlEvents.count < 8 { self.controlEvents.append(["type": type, "reason": reason, "monotonicNs": at, "restoration": "ORDINARY_CONTROLS_UNCHANGED"]) } }
  }

  init(directory: URL) {
    self.directory = directory
    let binding = (try? Data(contentsOf: directory.appendingPathComponent("research-context.json"))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    if binding?["samplingEnabled"] as? Bool != true { disabled = "COLLECTION_DISABLED" }
  }
  static func create(directory: URL) -> ResearchCapture? {
    guard Bundle.main.bundleIdentifier == "com.packproof.mobile.research",
      FileManager.default.fileExists(atPath: directory.appendingPathComponent("research-context.json").path) else { return nil }
    return ResearchCapture(directory: directory)
  }
  func sample(_ pixels: CVPixelBuffer, pts: CMTime, mediaMs: Int64, device: AVCaptureDevice?) {
    let now = DispatchTime.now().uptimeNanoseconds
    lock.lock()
    if ended || disabled != nil || now - lastSample < 250_000_000 { lock.unlock(); return }
    lastSample = now
    if ProcessInfo.processInfo.thermalState == .serious || ProcessInfo.processInfo.thermalState == .critical { disabled = "THERMAL_PRESSURE"; lock.unlock(); return }
    if busy { drops += 1; lock.unlock(); return }
    busy = true
    lock.unlock()
    let width = CVPixelBufferGetWidthOfPlane(pixels, 0), height = CVPixelBufferGetHeightOfPlane(pixels, 0)
    guard width > 1, height > 1, width * height <= 2_097_152,
      CaptureStorage.availableBytes(directory) >= 64 * 1024 * 1024 else { disable("FRAME_BUFFER_OR_DISK_PRESSURE"); return }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    guard let pointer = CVPixelBufferGetBaseAddressOfPlane(pixels, 0) else {
      CVPixelBufferUnlockBaseAddress(pixels, .readOnly); disable("LUMA_UNAVAILABLE"); return
    }
    let stride = CVPixelBufferGetBytesPerRowOfPlane(pixels, 0)
    var luma = Data(count: width * height)
    luma.withUnsafeMutableBytes { target in
      for y in 0..<height { memcpy(target.baseAddress!.advanced(by: y * width), pointer.advanced(by: y * stride), width) }
    }
    CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
    let exposure = device.map { CMTimeGetSeconds($0.exposureDuration) }
    let focus = device.map { Double($0.lensPosition) }
    let cameraId = device?.uniqueID
    queue.async {
      defer { self.lock.lock(); self.busy = false; self.lock.unlock() }
      do { try self.process(luma, width: width, height: height, pts: pts, now: now, mediaMs: mediaMs, exposure: exposure, focus: focus, cameraId: cameraId) }
      catch { self.lock.lock(); self.disabled = "OPTIONAL_STORAGE_OR_PROCESSING_FAILURE"; self.lock.unlock() }
    }
  }
  private func process(_ luma: Data, width: Int, height: Int, pts: CMTime, now: UInt64, mediaMs: Int64, exposure: Double?, focus: Double?, cameraId: String?) throws {
    let quality = ResearchQuality.measure(luma, width: width, height: height)
    var frame: [String: Any] = ["sampleId": count, "mediaTimeMs": mediaMs,
      "presentationTimestamp": ["value": String(pts.value), "timescale": pts.timescale], "presentationClockDomain": "AVFOUNDATION_SAMPLE_PTS",
      "monotonicNs": String(now - started), "clockDomain": "IOS_DISPATCH_UPTIME",
      "timestampRelationship": "CONCURRENT_WITH_ENCODED_SAMPLE", "timestampUncertaintyMs": NSNull(),
      "width": width, "height": height, "rotationDegrees": 0, "cameraId": cameraId as Any? ?? NSNull(),
      "exposureSeconds": exposure as Any? ?? NSNull(), "focusLensPosition": focus as Any? ?? NSNull(),
      "metadataLimitation": "Device state sampled at callback; not per-sensor exposure attestation",
      "streamProfile": "existing-preview-video-analysis", "quality": quality]
    count += 1
    if mediaMs - lastTelemetry >= 1000 && telemetry.count < 301 { telemetry.append(frame); lastTelemetry = mediaMs }
    lock.lock(); regionFrame = RegionFrame(pts: pts, luma: luma, metadata: frame, width: width, height: height); lock.unlock()
    var slot = -1
    if frames[0] == nil { slot = 0 }
    else if frames[1] == nil || quality["sharpness"]! < ((frames[1]!["quality"] as? [String: Double])?["sharpness"] ?? 0) { slot = 1 }
    else if !(3...5).contains(where: { index in frames[index].map { abs(mediaMs - ($0["mediaTimeMs"] as? Int64 ?? 0)) < 1000 } ?? false }) {
      slot = (3...5).min { ((frames[$0]?["quality"] as? [String: Double])?["sharpness"] ?? -1) < ((frames[$1]?["quality"] as? [String: Double])?["sharpness"] ?? -1) } ?? -1
    }
    if slot >= 0 && (slot < 2 || frames[slot] == nil || quality["sharpness"]! > ((frames[slot]!["quality"] as? [String: Double])?["sharpness"] ?? 0) * 1.1) {
      var bytes = Data("P5\n\(width) \(height)\n255\n".utf8); bytes.append(luma)
      let name = "research-frame-\(slot).pgm"
      try CaptureStorage.durableWrite(bytes, to: directory.appendingPathComponent(name))
      frame["fileName"] = name; frame["sha256"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
      frame["byteLength"] = bytes.count; frame["relationship"] = "CONCURRENT_CAPTURED_SIDECAR"
      frame["transform"] = "NATIVE_LUMA_PLANE_PGM_NO_RESIZE"
      frame["colorLimitation"] = "Luma plane only; not RGB or pixel-identical decoded video"
      frames[slot] = frame
      try persist()
    }
  }
  func observeBarcodeRegions(_ regions: [(CMTime, CGRect?)], width: Int, height: Int) {
    lock.lock()
    guard !ended, disabled == nil else { lock.unlock(); return }
    guard regions.count == 1 else { regionUnavailableReason = regions.isEmpty ? "NO_BARCODE_REGION" : "AMBIGUOUS_MULTIPLE_BARCODES"; lock.unlock(); return }
    guard let candidate = regionFrame, CMTimeCompare(candidate.pts, regions[0].0) == 0,
      candidate.width == width, candidate.height == height else { regionUnavailableReason = "DECODER_FRAME_NOT_IN_BOUNDED_CACHE"; lock.unlock(); return }
    guard let rect = regions[0].1, let bounds = ResearchRegions.bounds(rect, width: width, height: height) else { regionUnavailableReason = "UNMAPPABLE_OR_CLIPPED_REGION"; lock.unlock(); return }
    guard !busy else { regionUnavailableReason = "OPTIONAL_WORK_BACKPRESSURE"; lock.unlock(); return }
    busy = true; lock.unlock()
    queue.async {
      defer { self.lock.lock(); self.busy = false; self.lock.unlock() }
      do {
        var frame = candidate.metadata
        let mediaMs = frame["mediaTimeMs"] as? Int64 ?? 0
        let quality = ResearchRegions.quality(candidate.luma, width: width, height: height, bounds: bounds)
        guard quality["meanLuma"]! >= 12, quality["meanLuma"]! <= 243, quality["saturationFraction"]! <= 0.6 else { self.setRegionReason("REGION_EXPOSURE_UNUSABLE"); return }
        let previous = (self.frames[2]?["regionQuality"] as? [String: Double])?["sharpness"] ?? -1
        if self.frames[2] != nil && (mediaMs-self.lastRegionMs < 750 || quality["sharpness"]! <= previous*1.1) { return }
        frame["regionCandidates"] = [["target": "BARCODE_REGION", "coordinateSpace": "stored-native-luma-pixels", "polygon": [[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]]], "association": "EXACT_ANALYSIS_TIMESTAMP", "identityInterpretation": "UNASSIGNED"]]
        frame["regionQuality"] = quality; frame["selectionTask"] = "BARCODE_REGION"
        var bytes = Data("P5\n\(width) \(height)\n255\n".utf8); bytes.append(candidate.luma)
        let name = "research-frame-2.pgm"
        try CaptureStorage.durableWrite(bytes, to: self.directory.appendingPathComponent(name))
        frame["fileName"] = name; frame["sha256"] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(); frame["byteLength"] = bytes.count
        frame["relationship"] = "CONCURRENT_CAPTURED_SIDECAR"; frame["transform"] = "NATIVE_LUMA_PLANE_PGM_NO_RESIZE"; frame["colorLimitation"] = "Luma only; not RGB or pixel-identical decoded video"
        self.frames[2] = frame; self.lastRegionMs = mediaMs; self.setRegionReason("NONE"); try self.persist()
      } catch { self.setRegionReason("OPTIONAL_REGION_FAILURE") }
    }
  }
  private func setRegionReason(_ reason: String) { lock.lock(); regionUnavailableReason = reason; lock.unlock() }
  func disable(_ reason: String) { lock.lock(); disabled = reason; busy = false; lock.unlock() }
  func finish(_ completion: @escaping () -> Void) {
    lock.lock(); ended = true; regionFrame = nil; lock.unlock()
    queue.async { do { try self.persist(); try CaptureStorage.durableWrite(Data("{}".utf8), to: self.directory.appendingPathComponent("research-complete.json")) } catch { /* Optional data remains unavailable. */ }; completion() }
  }
  private func persist() throws {
    lock.lock(); let reason = disabled; let dropped = drops; let regionReason = regionUnavailableReason; lock.unlock()
    let result: [String: Any] = ["schemaVersion": "packproof.native-acquisition.v1", "mode": "PASSIVE", "qualification": "UNQUALIFIED",
      "findingState": "NOT_CHECKED", "chainCoverage": "FINAL_FILE_ONLY", "samplesObserved": count, "optionalBackpressureDrops": dropped,
      "disabledReason": reason as Any? ?? NSNull(),
      "selectionPolicy": "context-ambiguous-barcode-region-three-general-v1",
      "taskCoverage": ["context": frames[0] != nil ? "RECORDED" : "UNMET", "barcodeRegion": frames[2] != nil ? "RECORDED_UNQUALIFIED" : "UNMET", "barcodeRegionReason": regionReason,
        "labelOCR": "UNMET_NO_NATIVE_OCR_PROFILE", "serialOCR": "UNMET_NO_NATIVE_OCR_PROFILE", "cartonTexture": "UNMET_NO_QUALIFIED_REGION_ASSOCIATION", "itemSurface": "UNMET_NO_QUALIFIED_REGION_ASSOCIATION", "condition": "UNMET_NO_QUALIFIED_REGION_ASSOCIATION"],
      "frames": frames.compactMap { $0 }, "telemetry": telemetry, "controlEvents": controlEvents,
      "controls": ["illumination": "NOT_REQUESTED", "focus": "PASSIVE_ONLY", "lease": controlEvents.isEmpty ? "NONE" : "SEE_OWNER_EVENTS"]]
    try CaptureStorage.durableWrite(CaptureStorage.json(result), to: directory.appendingPathComponent("research-acquisition.json"))
  }
}

enum ResearchQuality {
  static func measure(_ luma: Data, width: Int, height: Int) -> [String: Double] {
    precondition(width > 1 && height > 1 && luma.count == width * height)
    let step = max(1, min(width, height) / 48)
    var sum = 0.0, edge = 0.0, count = 0.0, saturated = 0.0
    for y in stride(from: step, to: height, by: step) { for x in stride(from: step, to: width, by: step) {
      let v = Double(luma[y * width + x]); sum += v
      edge += abs(v - Double(luma[y * width + x - step]))
      if v <= 5 || v >= 250 { saturated += 1 }
      count += 1
    } }
    return ["meanLuma": sum / count, "sharpness": edge / count, "saturationFraction": saturated / count]
  }
}
