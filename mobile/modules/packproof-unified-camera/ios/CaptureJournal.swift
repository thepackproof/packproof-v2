import CryptoKit
import Foundation
import Darwin

enum CaptureStorage {
  static let fileManager = FileManager.default

  static func directory(_ sessionID: String, proofOnly: Bool = true) throws -> URL {
    let pattern = proofOnly ? "^cap_[A-Za-z0-9_-]{1,91}$" : "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"
    guard sessionID.range(of: pattern, options: .regularExpression) != nil else {
      throw CaptureFailure.invalidSession
    }
    let documents = try fileManager.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let root = documents.appendingPathComponent(sessionID.hasPrefix("cap_") ? "packproof-captures" : "packproof-camera-spike", isDirectory: true)
    return root.appendingPathComponent(sessionID, isDirectory: true)
  }

  static func prepareDirectory(_ directory: URL) throws {
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var excluded = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }

  static func bytes(_ url: URL) -> Int64 {
    ((try? fileManager.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
  }

  static func availableBytes(_ directory: URL) -> Int64 {
    let attributes = try? fileManager.attributesOfFileSystem(forPath: directory.path)
    return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value ?? 0
  }

  static func json(_ value: Any) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
  }

  /// Both the file and its rename are synced before JS can observe a completion receipt.
  static func durableWrite(_ bytes: Data, to destination: URL) throws {
    let temporary = destination.appendingPathExtension("tmp-\(UUID().uuidString)")
    do {
      try bytes.write(to: temporary, options: .completeFileProtectionUntilFirstUserAuthentication)
      let handle = try FileHandle(forWritingTo: temporary)
      do { try handle.synchronize(); try handle.close() } catch { try? handle.close(); throw error }
      let result = temporary.withUnsafeFileSystemRepresentation { source in
        destination.withUnsafeFileSystemRepresentation { target in Darwin.rename(source!, target!) }
      }
      guard result == 0 else { throw CaptureFailure.storage }
      let descriptor = Darwin.open(destination.deletingLastPathComponent().path, O_RDONLY)
      if descriptor >= 0 { _ = Darwin.fsync(descriptor); Darwin.close(descriptor) }
    } catch {
      try? fileManager.removeItem(at: temporary)
      throw error
    }
  }

  /// AVAssetWriter requires a nonexistent output URL. Reserve a separate file with O_EXCL.
  static func reserveVideo(_ directory: URL) throws -> URL {
    try prepareDirectory(directory)
    let video = directory.appendingPathComponent("video.mp4")
    guard !fileManager.fileExists(atPath: video.path) else { throw CaptureFailure.sessionExists }
    let reservation = directory.appendingPathComponent("video.reserved")
    let descriptor = Darwin.open(reservation.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw CaptureFailure.sessionExists }
    _ = Darwin.fsync(descriptor)
    Darwin.close(descriptor)
    return video
  }
}

enum CaptureFailure: Error {
  case invalidSession, sessionExists, storage, invalidBinding, journalTooLarge, invalidVideo
}

/// The serial writer keeps disk IO and hashing off the acquisition queue.
final class CaptureJournal {
  private let writer = DispatchQueue(label: "com.packproof.camera.journal", qos: .utility)
  private let directory: URL
  private var failure: Error?
  private var sequence = 0
  private var previous: String?
  private var startedNanos = DispatchTime.now().uptimeNanoseconds

  init(directory: URL) { self.directory = directory }

  func start() {
    startedNanos = DispatchTime.now().uptimeNanoseconds
    append("CAPTURE_STARTED", mediaTimeMs: 0)
  }

  func append(_ type: String, mediaTimeMs: Int64, value: String? = nil) {
    let nanos = DispatchTime.now().uptimeNanoseconds - startedNanos
    writer.async {
      guard self.failure == nil else { return }
      do {
        let event: [String: Any] = ["sequence": self.sequence, "type": type,
          "mediaTimeMs": max(0, mediaTimeMs), "monotonicNs": nanos,
          "value": value as Any? ?? NSNull(), "previous": self.previous as Any? ?? NSNull()]
        let eventBytes = try CaptureStorage.json(event)
        let digest = SHA256.hash(data: eventBytes).map { String(format: "%02x", $0) }.joined()
        // Embed the exact hashed JSON. JSON.parse / JSON.stringify on JS must reproduce it.
        var row = Data("{\"event\":".utf8)
        row.append(eventBytes)
        row.append(Data(",\"sha256\":\"\(digest)\"}\n".utf8))
        let url = self.directory.appendingPathComponent("native-journal.jsonl")
        if !CaptureStorage.fileManager.fileExists(atPath: url.path) {
          guard CaptureStorage.fileManager.createFile(atPath: url.path, contents: nil,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw CaptureFailure.storage }
        }
        let handle = try FileHandle(forWritingTo: url)
        do {
          try handle.seekToEnd()
          try handle.write(contentsOf: row)
          try handle.synchronize()
          try handle.close()
        } catch { try? handle.close(); throw error }
        self.previous = digest
        self.sequence += 1
      } catch { self.failure = error }
    }
  }

  func finish(durationMs: Int64, completion: @escaping (Bool) -> Void) {
    append("CAPTURE_ENDED", mediaTimeMs: durationMs)
    writer.async { completion(self.failure == nil) }
  }

  static func bind(sessionID: String, proofID: String, contextJSON: String) throws {
    let bytes = Data(contextJSON.utf8)
    guard bytes.count <= 65_536,
      let supplied = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      supplied["captureId"] as? String == sessionID,
      supplied["proofId"] as? String == proofID else { throw CaptureFailure.invalidBinding }
    let directory = try CaptureStorage.directory(sessionID)
    try CaptureStorage.prepareDirectory(directory)
    let context = directory.appendingPathComponent("capture-context.json")
    if CaptureStorage.fileManager.fileExists(atPath: context.path) {
      guard try Data(contentsOf: context) == bytes else { throw CaptureFailure.invalidBinding }
      return
    }
    guard !CaptureStorage.fileManager.fileExists(atPath: directory.appendingPathComponent("video.reserved").path),
      !CaptureStorage.fileManager.fileExists(atPath: directory.appendingPathComponent("video.mp4").path) else { throw CaptureFailure.invalidBinding }
    try CaptureStorage.durableWrite(bytes, to: context)
  }

  static func read(sessionID: String) throws -> String {
    let url = try CaptureStorage.directory(sessionID).appendingPathComponent("native-journal.jsonl")
    guard CaptureStorage.bytes(url) <= 1_048_576 else { throw CaptureFailure.journalTooLarge }
    guard CaptureStorage.fileManager.fileExists(atPath: url.path) else { return "" }
    return try String(contentsOf: url, encoding: .utf8)
  }
}
