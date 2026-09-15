import AVFoundation
import CryptoKit
import ImageIO
import UIKit
import Vision

enum BarcodePayloadPolicy {
  static func format(_ name: String) -> String? {
    let value = name.lowercased().replacingOccurrences(of: "vnbarcodesymbology", with: "")
      .replacingOccurrences(of: "-", with: "").components(separatedBy: ".").last ?? ""
    switch value {
    case "code128", "code39", "code93", "codabar", "aztec", "datamatrix", "ean8", "ean13": return value
    case "code39mod43", "code39checksum", "code39fullascii", "code39fullasciichecksum": return "code39"
    case "code93i": return "code93"
    case "qrcode", "qr": return "qr"
    case "pdf417", "micropdf417": return "pdf417"
    case "interleaved2of5", "itf14", "i2of5", "i2of5checksum": return "itf"
    case "upce": return "upc_e"
    default: return nil
    }
  }

  static func allows(format: String, identifiersEnabled: Bool) -> Bool {
    identifiersEnabled || !["ean8", "ean13", "upc_a", "upc_e"].contains(format)
  }

  static func payload(_ raw: String, format: String, identifiersEnabled: Bool) -> (String, String)? {
    guard !raw.isEmpty, raw.utf8.count <= (identifiersEnabled ? 4096 : 512),
      allows(format: format, identifiersEnabled: identifiersEnabled) else { return nil }
    if !identifiersEnabled {
      guard raw.range(of: "^(?:\\]C[01])?[\\u001d]?[A-Za-z0-9 \\t\\r\\n\\u001d-]{10,64}$", options: .regularExpression) != nil,
        raw.rangeOfCharacter(from: .decimalDigits) != nil else { return nil }
    }
    // AVFoundation represents UPC-A as EAN-13 with a leading zero.
    if format == "ean13", raw.count == 13, raw.hasPrefix("0") { return (String(raw.dropFirst()), "upc_a") }
    return (raw, format)
  }

  static func identity(_ raw: String) -> String {
    raw.replacingOccurrences(of: "[ \\t\\r\\n-]", with: "", options: .regularExpression).uppercased()
  }
}

enum EncodedBarcodeReader {
  /// Bounded, offline inspection; the original file is never edited or re-encoded.
  static func inspect(sessionID: String, offsetsMs: [Double], identifiersEnabled: Bool) throws -> [String: Any] {
    let directory = try CaptureStorage.directory(sessionID)
    let original = directory.appendingPathComponent("video.mp4")
    let bytes = CaptureStorage.bytes(original)
    guard bytes > 0, bytes <= 250_000_000,
      CaptureStorage.fileManager.fileExists(atPath: original.appendingPathExtension("finalized.json").path) else { throw CaptureFailure.invalidVideo }
    let asset = AVURLAsset(url: original, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
    let durationMs = CMTimeGetSeconds(asset.duration) * 1000
    guard asset.isPlayable, durationMs.isFinite, durationMs > 0, durationMs <= 1_800_000,
      let track = asset.tracks(withMediaType: .video).first,
      track.naturalSize.width > 0, track.naturalSize.height > 0,
      track.naturalSize.width <= 4096, track.naturalSize.height <= 4096 else { throw CaptureFailure.invalidVideo }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1920, height: 1920)
    generator.requestedTimeToleranceBefore = CMTime(value: 150, timescale: 1000)
    generator.requestedTimeToleranceAfter = CMTime(value: 150, timescale: 1000)
    defer { generator.cancelAllCGImageGeneration() }
    let request = VNDetectBarcodesRequest()
    request.symbologies = try request.supportedSymbologies().filter {
      guard let format = BarcodePayloadPolicy.format($0.rawValue) else { return false }
      return BarcodePayloadPolicy.allows(format: format, identifiersEnabled: identifiersEnabled)
    }
    var offsets: [Int64] = []
    func add(_ value: Double) {
      guard value.isFinite, value >= 0, value < durationMs else { return }
      let rounded = Int64(value)
      if !offsets.contains(rounded) { offsets.append(rounded) }
    }
    offsetsMs.prefix(8).forEach(add)
    offsetsMs.prefix(4).filter { $0.isFinite && $0 >= 0 && $0 < durationMs }.forEach {
      add(max(0, $0 - 750)); add(min(durationMs - 1, $0 + 750))
    }
    [0.1, 0.3, 0.5, 0.7, 0.9].forEach { add(durationMs * $0) }
    let began = ProcessInfo.processInfo.systemUptime
    var inspected = 0
    var seen = Set<String>()
    var observations: [[String: Any]] = []
    var frames: [[String: Any]] = []
    for offset in offsets.prefix(12) {
      if ProcessInfo.processInfo.systemUptime - began > 6 { break }
      autoreleasepool {
        do {
          var actualTime = CMTime.invalid
          let image = try generator.copyCGImage(at: CMTime(value: offset, timescale: 1000), actualTime: &actualTime)
          inspected += 1
          let started = ProcessInfo.processInfo.systemUptime
          try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
          let latencyMs = (ProcessInfo.processInfo.systemUptime - started) * 1000
          var accepted = false
          for code in request.results ?? [] {
            guard let value = code.payloadStringValue,
              let format = BarcodePayloadPolicy.format(code.symbology.rawValue),
              let (raw, normalizedFormat) = BarcodePayloadPolicy.payload(value, format: format, identifiersEnabled: identifiersEnabled) else { continue }
            accepted = true
            let identity = identifiersEnabled ? "\(normalizedFormat):\(raw)" : BarcodePayloadPolicy.identity(raw)
            guard !seen.contains(identity), observations.count < (identifiersEnabled ? 128 : 8) else { continue }
            seen.insert(identity)
            let rect = code.boundingBox
            observations.append(["rawValue": raw, "format": normalizedFormat,
              "rawBytes": NSNull(), "decoderEncoding": NSNull(), "symbologyIdentifier": NSNull(),
              "detectedAtMs": Double(offset), "detectedAtUnixMs": 0, "latencyMs": latencyMs,
              "source": "ENCODED_VIDEO_FRAME", "coordinateSpace": "DECODED_VIDEO_PIXELS",
              "decoderVersion": "apple-vision-\(ProcessInfo.processInfo.operatingSystemVersionString)",
              "timestampUncertaintyMs": NSNull(), "frameWidth": image.width, "frameHeight": image.height,
              "bounds": ["left": rect.minX * CGFloat(image.width), "top": (1 - rect.maxY) * CGFloat(image.height),
                "right": rect.maxX * CGFloat(image.width), "bottom": (1 - rect.minY) * CGFloat(image.height)]])
          }
          if frames.count < 3 && (frames.isEmpty || accepted), let png = UIImage(cgImage: image).pngData() {
            let file = directory.appendingPathComponent("review-frame-\(frames.count).png")
            try CaptureStorage.durableWrite(png, to: file)
            frames.append(["uri": file.absoluteString,
              "sha256": SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined(),
              "requestedOffsetMs": Double(offset), "timestampPrecision": "NEAR_REQUESTED_TIME",
              "transform": "Nearby original video frame; orientation applied; scaled to fit 1920 pixels; PNG; no overlays"])
          }
        } catch { /* Optional review failures never destroy or modify evidence. */ }
      }
    }
    return ["playable": inspected > 0, "inspectedFrames": inspected, "durationMs": durationMs,
      "observations": observations, "frames": frames, "timestampPrecision": "NEAR_REQUESTED_TIME"]
  }
}
