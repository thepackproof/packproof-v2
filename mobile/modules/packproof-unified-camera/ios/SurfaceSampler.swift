import AVFoundation
import CoreImage
import CryptoKit
import Foundation
import ImageIO
import Vision

/// Bounded diagnostic branch of the existing video-data output. No additional camera/output.
/// One retained pixel buffer maximum; full stream-sized JPEG originals, never upscaled/cropped.
final class SurfaceSampler {
  private let writer = DispatchQueue(label: "com.packproof.camera.surface", qos: .utility)
  private let lock = NSLock()
  private let directory: URL
  private let binding: [String: Any]
  private let expected: String
  private let imageContext = CIContext(options: [.cacheIntermediates: false])
  private var busy = false
  private var closed = false
  private var count = 0
  private var retained: [String] = []
  private var sequence = 0
  private var previous: String?
  private var lastAttempt = -2_000.0
  private var lastSaved = -2_000.0
  private var lastBounds: CGRect?
  private var stableReads = 0

  init(directory: URL) throws {
    self.directory = directory
    let data = try Data(contentsOf: directory.appendingPathComponent("surface-context.json"))
    guard let context = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CaptureFailure.invalidBinding }
    binding = context
    expected = Self.normalize(context["expectedTracking"] as? String ?? "")
    writer.async {
      try? self.append("STARTED", ["profileId": "ios-video-data-v1-unqualified", "qualified": false,
        "binding": context, "source": "AVFOUNDATION_VIDEO_DATA_OUTPUT", "closureState": "UNKNOWN"])
    }
  }

  private static func normalize(_ value: String) -> String { value.replacingOccurrences(of: "[\\s-]", with: "", options: .regularExpression).uppercased() }

  private func append(_ type: String, _ value: [String: Any]) throws {
    let event: [String: Any] = ["sequence": sequence, "previous": previous as Any? ?? NSNull(), "type": type, "value": value]
    let bytes = try CaptureStorage.json(event)
    let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    let row = try CaptureStorage.json(["eventJson": String(decoding: bytes, as: UTF8.self), "sha256": digest]) + Data("\n".utf8)
    let url = directory.appendingPathComponent("surface-journal.jsonl")
    if !CaptureStorage.fileManager.fileExists(atPath: url.path) {
      guard CaptureStorage.fileManager.createFile(atPath: url.path, contents: nil,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw CaptureFailure.storage }
    }
    let handle = try FileHandle(forWritingTo: url)
    do { try handle.seekToEnd(); try handle.write(contentsOf: row); try handle.synchronize(); try handle.close() }
    catch { try? handle.close(); throw error }
    previous = digest; sequence += 1
  }

  func unavailable(_ reason: String, timeMs: Double) {
    lock.lock(); let wasClosed = closed; closed = true; lock.unlock()
    guard !wasClosed else { return }
    writer.async { try? self.append("UNAVAILABLE", ["reason": reason, "frameTimeMs": timeMs]) }
  }

  /// Called after the same sample has been accepted by the video writer.
  func sample(_ pixelBuffer: CVPixelBuffer, timeMs: Double, sensorPTS: CMTime, device: AVCaptureDevice?) {
    lock.lock()
    if busy || closed || timeMs - lastAttempt < 250 { lock.unlock(); return }
    busy = true; lastAttempt = timeMs; lock.unlock()
    let metadata: [String: Any] = ["lens": device?.deviceType.rawValue as Any? ?? NSNull(),
      "iso": device.map { Double($0.iso) } as Any? ?? NSNull(),
      "exposureSeconds": device.map { CMTimeGetSeconds($0.exposureDuration) } as Any? ?? NSNull(),
      "zoom": device.map { Double($0.videoZoomFactor) } as Any? ?? NSNull(),
      "focusDistance": NSNull(), "viewAngle": NSNull()]
    let monotonic = DispatchTime.now().uptimeNanoseconds
    writer.async {
      defer { self.lock.lock(); self.busy = false; self.lock.unlock() }
      self.lock.lock(); let closed = self.closed; self.lock.unlock()
      guard !closed else { return }
      do {
        guard self.count < 200 else { self.unavailable("SAMPLING_BUDGET_REACHED", timeMs: timeMs); return }
        guard !self.expected.isEmpty else { self.unavailable("NO_EXPECTED_SHIPMENT_IDENTIFIER", timeMs: timeMs); return }
        guard CaptureStorage.availableBytes(self.directory) >= 192 * 1024 * 1024 else { self.unavailable("DISK_PRESSURE", timeMs: timeMs); return }
        guard ProcessInfo.processInfo.thermalState == .nominal || ProcessInfo.processInfo.thermalState == .fair else { self.unavailable("THERMAL_PRESSURE", timeMs: timeMs); return }
        let width = CVPixelBufferGetWidth(pixelBuffer), height = CVPixelBufferGetHeight(pixelBuffer)
        guard width * height <= 4_194_304, CVPixelBufferGetPlaneCount(pixelBuffer) > 0 else { self.unavailable("STREAM_UNSUPPORTED", timeMs: timeMs); return }
        // Verify parcel association on this exact sample; asynchronous metadata events cannot bind it.
        let request = VNDetectBarcodesRequest()
        try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up).perform([request])
        let observations = request.results ?? []
        let identities = Set(observations.compactMap { $0.payloadStringValue.map(Self.normalize) })
        guard identities.count == 1, identities.first == self.expected,
          let observation = observations.first(where: { Self.normalize($0.payloadStringValue ?? "") == self.expected }) else {
          if self.stableReads > 0 { try self.append("CONTINUITY", ["reason": identities.count > 1 ? "AMBIGUOUS_PARCELS" : "TRACK_LOST", "frameTimeMs": timeMs]) }
          self.stableReads = 0; self.lastBounds = nil; return
        }
        let bounds = observation.boundingBox
        let prior = self.lastBounds
        let overlap = prior?.intersection(bounds) ?? .null
        self.stableReads = !overlap.isNull && overlap.width * overlap.height >= min(bounds.width*bounds.height, (prior?.width ?? 0)*(prior?.height ?? 0))/2 ? self.stableReads + 1 : 1
        self.lastBounds = bounds
        guard self.stableReads >= 3, timeMs - self.lastSaved >= 1_500 else { return }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        guard let base = CVPixelBufferGetBaseAddressOfPlane(pixelBuffer, 0) else { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly); return }
        let stride = CVPixelBufferGetBytesPerRowOfPlane(pixelBuffer, 0)
        let pixels = base.assumingMemoryBound(to: UInt8.self)
        var sum = 0.0, sum2 = 0.0, gradient = 0.0, saturated = 0.0, n = 0.0
        for y in Swift.stride(from: 1, to: height, by: 8) { for x in Swift.stride(from: 1, to: width, by: 8) {
          let v = Double(pixels[y*stride+x]); sum += v; sum2 += v*v
          gradient += abs(v - Double(pixels[y*stride+x-1])); saturated += v >= 250 || v <= 5 ? 1 : 0; n += 1
        } }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        let variance = sum2/n - (sum/n)*(sum/n)
        guard variance >= 20, gradient/n >= 1, saturated/n <= 0.8 else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let bytes = self.imageContext.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(),
          options: [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.95]), bytes.count <= 8*1024*1024 else {
          self.unavailable("SOURCE_BUDGET_EXCEEDED", timeMs: timeMs); return
        }
        guard self.retained.reduce(Int64(0), { $0 + CaptureStorage.bytes(self.directory.appendingPathComponent($1)) }) + Int64(bytes.count) <= 8*1024*1024 else {
          self.unavailable("CAPTURE_BYTE_BUDGET_REACHED", timeMs: timeMs); return
        }
        let name = "surface-original-\(self.count).jpg"
        let file = self.directory.appendingPathComponent(name)
        guard !CaptureStorage.fileManager.fileExists(atPath: file.path) else { throw CaptureFailure.sessionExists }
        try CaptureStorage.durableWrite(bytes, to: file)
        var frame = metadata
        frame.merge(["fileName": name, "sha256": SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
          "byteSize": bytes.count, "width": width, "height": height, "rotationDegrees": 0,
          "frameTimeMs": timeMs, "timestampPrecision": "SAME_SAMPLE_VIDEO_PTS", "sensorTimestampNs": NSNull(),
          "samplePTS": ["value": String(sensorPTS.value), "timescale": sensorPTS.timescale], "monotonicNs": String(monotonic),
          "glareFraction": NSNull(), "motionBlur": NSNull(),
          "quality": ["lumaVariance": variance, "meanAbsGradient": gradient/n, "saturatedFraction": saturated/n, "calibrated": false],
          "barcodeBounds": [Double(bounds.minX)*Double(width), Double(1-bounds.maxY)*Double(height), Double(bounds.maxX)*Double(width), Double(1-bounds.minY)*Double(height)],
          "boundsSpace": "ROTATED_ANALYSIS_PIXELS", "transform": "VIDEO_PIXEL_BUFFER_TO_JPEG_QUALITY_95_NO_CROP_NO_RESIZE",
          "trackId": "expected-barcode-overlap", "association": "SAME_FRAME_EXPECTED_BARCODE_ONLY"]) { _, new in new }
        try self.append("SOURCE", frame)
        self.retained.append(name)
        if self.retained.count > 6 {
          let discarded = self.retained.removeFirst()
          try self.append("SUPERSEDED", ["fileName": discarded, "reason": "PREFER_LATER_PACKAGE_SEGMENT"])
          try CaptureStorage.fileManager.removeItem(at: self.directory.appendingPathComponent(discarded))
        }
        self.lock.lock(); self.count += 1; self.lock.unlock(); self.lastSaved = timeMs
      } catch { self.unavailable("SIDECAR_WRITE_OR_ANALYSIS_FAILED", timeMs: timeMs) }
    }
  }

  func finish(timeMs: Double, interrupted: Bool) {
    lock.lock(); closed = true; lock.unlock()
    writer.async { try? self.append("FINISHED", ["frameTimeMs": timeMs, "interrupted": interrupted, "selectedCount": self.retained.count, "qualified": false]) }
  }

  static func bind(sessionID: String, contextJSON: String) throws {
    let bytes = Data(contextJSON.utf8)
    guard bytes.count <= 16_384, let context = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      context["captureSessionId"] as? String == sessionID, context["experimental"] as? Bool == true else { throw CaptureFailure.invalidBinding }
    let directory = try CaptureStorage.directory(sessionID)
    try CaptureStorage.prepareDirectory(directory)
    guard !CaptureStorage.fileManager.fileExists(atPath: directory.appendingPathComponent("video.mp4").path) else { throw CaptureFailure.sessionExists }
    let file = directory.appendingPathComponent("surface-context.json")
    if CaptureStorage.fileManager.fileExists(atPath: file.path) { guard try Data(contentsOf: file) == bytes else { throw CaptureFailure.invalidBinding }; return }
    try CaptureStorage.durableWrite(bytes, to: file)
  }

  static func inspectSource(sessionID: String, fileName: String) throws -> [String: Any] {
    guard fileName == "video.mp4" || fileName.range(of: "^surface-original-[0-9]{1,3}\\.jpg$", options: .regularExpression) != nil else { throw CaptureFailure.invalidBinding }
    let file = try CaptureStorage.directory(sessionID).appendingPathComponent(fileName)
    guard CaptureStorage.fileManager.fileExists(atPath: file.path), CaptureStorage.bytes(file) <= 250_000_000,
      let stream = InputStream(url: file) else { throw CaptureFailure.invalidVideo }
    stream.open(); defer { stream.close() }
    var digest = SHA256(), buffer = [UInt8](repeating: 0, count: 65_536)
    while true {
      let read = stream.read(&buffer, maxLength: buffer.count)
      if read == 0 { break }
      guard read > 0 else { throw CaptureFailure.storage }
      digest.update(data: Data(buffer.prefix(read)))
    }
    return ["sha256": digest.finalize().map { String(format: "%02x", $0) }.joined(), "byteSize": CaptureStorage.bytes(file)]
  }

  static func read(sessionID: String) throws -> String {
    let file = try CaptureStorage.directory(sessionID).appendingPathComponent("surface-journal.jsonl")
    guard CaptureStorage.bytes(file) <= 512*1024 else { throw CaptureFailure.journalTooLarge }
    guard CaptureStorage.fileManager.fileExists(atPath: file.path) else { return "" }
    return try String(contentsOf: file, encoding: .utf8)
  }
}
