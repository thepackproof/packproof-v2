import Foundation
import CryptoKit
import Darwin

struct OrderShareManifest: Codable {
  let version: Int
  let id: String
  let clientSubmissionId: String
  let createdAt: Double
  var accountId: String?
  let surface: String
  let payloadKind: String
  var text: String
  let payloadHash: String
  var deliveryState: String
  var serverSubmissionId: String?
  var errorCode: String?
}

enum OrderShareError: LocalizedError {
  case invalid(String)
  var errorDescription: String? { switch self { case .invalid(let message): return message } }
}

/// The existing cross-process flock store is used by both executables. Every
/// mutation and read holds the same lock; .atomic publishes complete versions.
/// Seven-day raw-content expiry leaves an explicit, discardable tombstone.
/// Unacknowledged submission identities are never silently deleted.
final class OrderShareStore {
  static let maxTextLength = 20_000
  static let maxRequestBytes = 64 * 1024
  static let maxPending = 50
  static let rawLifetime: Double = 7 * 24 * 60 * 60
  private let root: URL
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

  private func withLock<T>(_ body: () throws -> T) throws -> T {
    let lockURL = root.appendingPathComponent(".lock")
    let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
    guard descriptor >= 0 else { throw OrderShareError.invalid("Could not open the shared order inbox.") }
    defer { close(descriptor) }
    guard flock(descriptor, LOCK_EX) == 0 else { throw OrderShareError.invalid("Could not lock the shared order inbox.") }
    defer { flock(descriptor, LOCK_UN) }
    try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: lockURL.path)
    return try body()
  }

  private func directory(_ id: String) throws -> URL {
    guard let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id else {
      throw OrderShareError.invalid("This shared order is invalid.")
    }
    let folder = root.appendingPathComponent(id, isDirectory: true)
    if manager.fileExists(atPath: folder.path) {
      let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true else {
        throw OrderShareError.invalid("This shared order cannot be read.")
      }
    }
    return folder
  }

  private func readLocked(_ id: String) throws -> OrderShareManifest {
    let file = try directory(id).appendingPathComponent("manifest.json")
    let values = try file.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? Int.max) <= 200_000 else {
      throw OrderShareError.invalid("This shared order cannot be read.")
    }
    let bytes = try Data(contentsOf: file)
    if let manifest = try? JSONDecoder().decode(OrderShareManifest.self, from: bytes), manifest.version == 2 {
      guard manifest.id == id, manifest.clientSubmissionId == id, manifest.text.utf16.count <= Self.maxTextLength,
            ["TEXT", "URL"].contains(manifest.payloadKind),
            ["LOCAL_PENDING", "SERVER_ACCEPTED"].contains(manifest.deliveryState),
            ["ANDROID_SHARE", "IOS_SHARE", "EXPLICIT_PASTE"].contains(manifest.surface) else {
        throw OrderShareError.invalid("This shared order exceeds the supported limits.")
      }
      if manifest.deliveryState == "SERVER_ACCEPTED" {
        guard let receipt = manifest.serverSubmissionId, !receipt.isEmpty, receipt.count <= 200, manifest.text.isEmpty else {
          throw OrderShareError.invalid("This saved order receipt could not be read.")
        }
      }
      if manifest.deliveryState == "LOCAL_PENDING", manifest.errorCode == nil {
        guard Self.hash(manifest.text) == manifest.payloadHash else {
          throw OrderShareError.invalid("This saved order could not be verified. Share it again or discard it.")
        }
      }
      return try applyRawRetentionLocked(manifest)
    }
    // Keep previously saved text and file imports available for explicit review/
    // discard. No old unassigned record is silently attributed to the next login.
    guard let legacy = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          legacy["version"] as? Int == 1, legacy["id"] as? String == id,
          let text = legacy["text"] as? String, text.utf16.count <= Self.maxTextLength,
          let createdAt = legacy["createdAt"] as? Double else {
      throw OrderShareError.invalid("This shared order cannot be read.")
    }
    let hasFiles = !(legacy["attachments"] as? [[String: Any]] ?? []).isEmpty
    let manifest = OrderShareManifest(version: 2, id: id, clientSubmissionId: id, createdAt: createdAt,
      accountId: nil, surface: "IOS_SHARE", payloadKind: "TEXT", text: text, payloadHash: Self.hash(text),
      deliveryState: "LOCAL_PENDING", serverSubmissionId: nil, errorCode: hasFiles ? "UNSUPPORTED_LEGACY_ATTACHMENT" : nil)
    try writeLocked(manifest)
    return try applyRawRetentionLocked(manifest)
  }

  private func applyRawRetentionLocked(_ manifest: OrderShareManifest) throws -> OrderShareManifest {
    guard manifest.deliveryState == "LOCAL_PENDING", manifest.errorCode != "INPUT_EXPIRED",
          Date().timeIntervalSince1970 - manifest.createdAt >= Self.rawLifetime else { return manifest }
    var expired = manifest
    expired.text = ""; expired.errorCode = "INPUT_EXPIRED"
    // Keep the stable transport identity, account binding and digest; explain
    // expiry in the host UI. This affects shared input, never packing evidence.
    try writeLocked(expired)
    let folder = try directory(expired.id)
    for url in try manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
      where url.lastPathComponent != "manifest.json" { try? manager.removeItem(at: url) }
    return expired
  }

  private func writeLocked(_ manifest: OrderShareManifest) throws {
    try JSONEncoder().encode(manifest).write(to: directory(manifest.id).appendingPathComponent("manifest.json"),
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func hash(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func envelope(_ manifest: OrderShareManifest) throws -> Data {
    let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1,
      "clientSubmissionId": manifest.clientSubmissionId, "surface": manifest.surface, "requestedAction": "QUEUE",
      "payload": ["kind": manifest.payloadKind, "text": manifest.text]], options: [.sortedKeys])
    guard data.count <= maxRequestBytes else {
      throw OrderShareError.invalid("This shared order is too large. Share a shorter link or fewer details.")
    }
    return data
  }

  func save(text: String, kind: String, surface: String, accountId: String?) throws -> OrderShareManifest {
    try withLock {
      let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, trimmed.utf16.count <= Self.maxTextLength,
            ["TEXT", "URL"].contains(kind), ["IOS_SHARE", "EXPLICIT_PASTE"].contains(surface) else {
        throw OrderShareError.invalid("Share plain text or one web link, up to 20,000 characters.")
      }
      if kind == "URL" { try Self.validateWebURL(trimmed) }
      let folders = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        .filter { UUID(uuidString: $0.lastPathComponent) != nil }
      let count = folders.reduce(0) { count, folder in
        let manifestURL = folder.appendingPathComponent("manifest.json")
        guard manager.fileExists(atPath: manifestURL.path) else { return count }
        // Unreadable records still count toward storage capacity, never delete them.
        return count + ((try? readLocked(folder.lastPathComponent).deliveryState) == "SERVER_ACCEPTED" ? 0 : 1)
      }
      guard count < Self.maxPending else {
        throw OrderShareError.invalid("Your saved order inbox is full. Open PackProof to finish adding or discard earlier orders.")
      }
      let id = UUID().uuidString.lowercased()
      let manifest = OrderShareManifest(version: 2, id: id, clientSubmissionId: id, createdAt: Date().timeIntervalSince1970,
        accountId: accountId, surface: surface, payloadKind: kind, text: trimmed, payloadHash: Self.hash(trimmed),
        deliveryState: "LOCAL_PENDING", serverSubmissionId: nil, errorCode: nil)
      _ = try Self.envelope(manifest)
      let folder = try directory(id)
      try manager.createDirectory(at: folder, withIntermediateDirectories: false,
        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
      do { try writeLocked(manifest) } catch { try? manager.removeItem(at: folder); throw error }
      return manifest
    }
  }

  static func validateWebURL(_ text: String) throws {
    guard text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
          let url = URL(string: text), let scheme = url.scheme?.lowercased(),
          ["http", "https"].contains(scheme), let host = url.host, !host.isEmpty,
          url.user == nil, url.password == nil else {
      throw OrderShareError.invalid("Share a web link beginning with https:// or plain order text.")
    }
  }

  func pending() throws -> [OrderShareManifest] {
    try withLock {
      try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
        .filter { UUID(uuidString: $0.lastPathComponent) != nil && manager.fileExists(atPath: $0.appendingPathComponent("manifest.json").path) }
        .map { folder in
          do { return try readLocked(folder.lastPathComponent) }
          catch {
            // One corrupt record must not block every other durable submission.
            // Expose only a discardable locator; never guess its account or text.
            let id = folder.lastPathComponent
            return OrderShareManifest(version: 2, id: id, clientSubmissionId: id, createdAt: 0,
              accountId: nil, surface: "IOS_SHARE", payloadKind: "TEXT", text: "", payloadHash: "",
              deliveryState: "LOCAL_PENDING", serverSubmissionId: nil, errorCode: "LOCAL_RECORD_UNREADABLE")
          }
        }.sorted { $0.createdAt < $1.createdAt }
    }
  }

  func read(_ id: String) throws -> OrderShareManifest { try withLock { try readLocked(id) } }

  func assignAccount(_ id: String, accountId: String) throws {
    try withLock {
      guard !accountId.isEmpty, accountId == (try activeAccountLocked()) else {
        throw OrderShareError.invalid("Sign in to the account that will receive this order first.")
      }
      var manifest = try readLocked(id)
      guard manifest.accountId == nil || manifest.accountId == accountId else {
        throw OrderShareError.invalid("This order belongs to a different PackProof account.")
      }
      manifest.accountId = accountId
      try writeLocked(manifest)
    }
  }

  func acknowledge(_ id: String, serverSubmissionId: String) throws {
    try withLock {
      guard !serverSubmissionId.isEmpty, serverSubmissionId.count <= 200 else {
        throw OrderShareError.invalid("The server did not confirm this order. It remains saved on this iPhone.")
      }
      var manifest = try readLocked(id)
      if let existing = manifest.serverSubmissionId, existing != serverSubmissionId {
        throw OrderShareError.invalid("The saved order receipt does not match. Open PackProof to retry.")
      }
      manifest.serverSubmissionId = serverSubmissionId; manifest.deliveryState = "SERVER_ACCEPTED"
      manifest.text = ""; manifest.errorCode = nil
      // Receipt and removal of raw text are one atomic replacement. The original
      // submission ID survives a crash before or after server acknowledgement.
      try writeLocked(manifest)
      let folder = try directory(id)
      for url in try manager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        where url.lastPathComponent != "manifest.json" { try? manager.removeItem(at: url) }
    }
  }

  func remove(_ id: String) throws {
    try withLock {
      let folder = try directory(id)
      if manager.fileExists(atPath: folder.path) { try manager.removeItem(at: folder) }
    }
  }

  private func activeAccountLocked() throws -> String? {
    let url = root.appendingPathComponent("active-account.json")
    guard manager.fileExists(atPath: url.path) else { return nil }
    let data = try Data(contentsOf: url)
    guard data.count <= 4096 else { throw OrderShareError.invalid("Open PackProof to restore order sharing.") }
    return (try JSONSerialization.jsonObject(with: data) as? [String: String])?["accountId"]
  }

  func activeAccount() throws -> String? { try withLock { try activeAccountLocked() } }

  func setIntakeSession(_ session: OrderShareIntakeSession) throws {
    try withLock {
      guard session.accountId == (try activeAccountLocked()) else {
        throw OrderShareError.invalid("Sign in to the destination account before enabling order sharing.")
      }
      try OrderShareSessionStore().save(session)
    }
  }

  func clearIntakeSession() throws { try withLock { try OrderShareSessionStore().clear() } }

  func setActiveAccount(_ accountId: String?) throws {
    try withLock {
      let previous = try activeAccountLocked()
      if previous != accountId || accountId == nil { try OrderShareSessionStore().clear() }
      let url = root.appendingPathComponent("active-account.json")
      if let accountId, !accountId.isEmpty, accountId.utf8.count <= 512 {
        let data = try JSONSerialization.data(withJSONObject: ["accountId": accountId])
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } else if manager.fileExists(atPath: url.path) { try manager.removeItem(at: url) }
    }
  }
}
