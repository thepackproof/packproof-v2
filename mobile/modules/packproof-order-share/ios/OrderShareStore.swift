import Foundation
import Darwin

struct OrderShareAttachment: Codable {
  let filename: String
  let contentType: String
  let byteSize: Int
}

struct OrderShareManifest: Codable {
  let version: Int
  let id: String
  let createdAt: Double
  let text: String
  let attachments: [OrderShareAttachment]
}

enum OrderShareError: LocalizedError {
  case invalid(String)
  var errorDescription: String? {
    switch self { case .invalid(let message): return message }
  }
}

/// Shared by the extension and app. A POSIX lock coordinates processes; manifests
/// become visible only after every attachment has been copied into our container.
final class OrderShareStore {
  static let maxTextLength = 20_000
  static let maxFileBytes = 10 * 1024 * 1024
  static let maxTotalBytes = 20 * 1024 * 1024
  static let maxAttachments = 4
  static let maxPending = 10
  static let lifetime: Double = 7 * 24 * 60 * 60
  let root: URL
  private let manager = FileManager.default

  init() throws {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "PackProofOrderShareAppGroup") as? String,
          let container = manager.containerURL(forSecurityApplicationGroupIdentifier: group) else {
      throw OrderShareError.invalid("Order sharing is unavailable. Reinstall the latest PackProof build.")
    }
    root = container.appendingPathComponent("OrderShareInbox", isDirectory: true)
    try manager.createDirectory(at: root, withIntermediateDirectories: true,
                                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
    var excluded = root
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try excluded.setResourceValues(values)
  }

  func withLock<T>(_ body: () throws -> T) throws -> T {
    let descriptor = open(root.appendingPathComponent(".lock").path, O_CREAT | O_RDWR, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw OrderShareError.invalid("Could not open the shared order inbox.") }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else { throw OrderShareError.invalid("Could not lock the shared order inbox.") }
    defer { flock(descriptor, LOCK_UN) }
    return try body()
  }

  func directory(_ id: String) throws -> URL {
    guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id.lowercased() else {
      throw OrderShareError.invalid("This shared order is invalid.")
    }
    return root.appendingPathComponent(uuid.uuidString.lowercased(), isDirectory: true)
  }

  func pending() throws -> [OrderShareManifest] {
    try withLock {
      try cleanupLocked()
      return try manifestsLocked().sorted { $0.createdAt < $1.createdAt }
    }
  }

  private func manifestsLocked() throws -> [OrderShareManifest] {
    try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).compactMap { folder in
      guard UUID(uuidString: folder.lastPathComponent) != nil,
            let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")),
            data.count <= 200_000,
            let manifest = try? JSONDecoder().decode(OrderShareManifest.self, from: data),
            manifest.version == 1, manifest.id == folder.lastPathComponent else { return nil }
      return manifest
    }
  }

  func reserve() throws -> (String, URL) {
    try withLock {
      try cleanupLocked()
      // Count in-progress folders too so concurrent extensions cannot overfill the inbox.
      let count = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        .filter { UUID(uuidString: $0.lastPathComponent) != nil }.count
      guard count < Self.maxPending else {
        throw OrderShareError.invalid("Your shared order inbox is full. Open PackProof to review or discard earlier orders.")
      }
      let id = UUID().uuidString.lowercased()
      let folder = try directory(id)
      try manager.createDirectory(at: folder, withIntermediateDirectories: false,
                                  attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      return (id, folder)
    }
  }

  func publish(_ manifest: OrderShareManifest) throws {
    try withLock {
      guard !manifest.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !manifest.attachments.isEmpty,
            manifest.text.utf16.count <= Self.maxTextLength,
            manifest.attachments.count <= Self.maxAttachments else {
        throw OrderShareError.invalid("Share an order as text, a web link, an image, or a PDF.")
      }
      try JSONEncoder().encode(manifest).write(to: directory(manifest.id).appendingPathComponent("manifest.json"),
                                               options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  func read(_ id: String) throws -> OrderShareManifest {
    try withLock {
      let file = try directory(id).appendingPathComponent("manifest.json")
      let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
      guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 200_000 else {
        throw OrderShareError.invalid("This shared order cannot be read.")
      }
      let manifest = try JSONDecoder().decode(OrderShareManifest.self, from: Data(contentsOf: file))
      guard manifest.id == id, manifest.version == 1, manifest.text.utf16.count <= Self.maxTextLength,
            manifest.attachments.count <= Self.maxAttachments,
            manifest.attachments.allSatisfy({ $0.byteSize > 0 && $0.byteSize <= Self.maxFileBytes }),
            manifest.attachments.reduce(0, { $0 + $1.byteSize }) <= Self.maxTotalBytes else {
        throw OrderShareError.invalid("This shared order exceeds the supported limits.")
      }
      return manifest
    }
  }

  func attachmentURL(_ attachment: OrderShareAttachment, id: String) throws -> URL {
    guard attachment.filename.range(of: "^[A-Za-z0-9-]+\\.(jpg|png|heic|webp|pdf)$", options: .regularExpression) != nil,
          attachment.byteSize > 0, attachment.byteSize <= Self.maxFileBytes else {
      throw OrderShareError.invalid("This shared file is invalid.")
    }
    let url = try directory(id).appendingPathComponent(attachment.filename)
    let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true, values.fileSize == attachment.byteSize else {
      throw OrderShareError.invalid("This shared file is no longer available. Share it again from the original app.")
    }
    return url
  }

  func remove(_ id: String) throws {
    try withLock {
      let folder = try directory(id)
      if manager.fileExists(atPath: folder.path) { try manager.removeItem(at: folder) }
    }
  }

  private func cleanupLocked() throws {
    let now = Date().timeIntervalSince1970
    for folder in try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) {
      guard UUID(uuidString: folder.lastPathComponent) != nil else { continue }
      let created = try folder.resourceValues(forKeys: [.creationDateKey]).creationDate?.timeIntervalSince1970 ?? now
      let published = manager.fileExists(atPath: folder.appendingPathComponent("manifest.json").path)
      // An abandoned/cancelled copy has no manifest and is never exposed to JS.
      if now - created > (published ? Self.lifetime : 3600) { try manager.removeItem(at: folder) }
    }
  }
}
