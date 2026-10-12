import CryptoKit
import Foundation
import Security

/// Dedicated Keychain software key. Does not claim Secure Enclave or App Attest assurance.
enum ResearchProvenance {
  static func directory(_ session: String) throws -> URL {
    guard Bundle.main.bundleIdentifier == "com.packproof.mobile.research" else { throw CaptureFailure.invalidBinding }
    return try CaptureStorage.directory(session)
  }
  static func bind(session: String, proof: String, binding: String) throws {
    let bytes = Data(binding.utf8)
    guard bytes.count <= 65536, let json = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
      json["captureSessionId"] as? String == session, json["proofId"] as? String == proof else { throw CaptureFailure.invalidBinding }
    let root = try directory(session); try CaptureStorage.prepareDirectory(root)
    let file = root.appendingPathComponent("research-context.json")
    if FileManager.default.fileExists(atPath: file.path) { guard try Data(contentsOf: file) == bytes else { throw CaptureFailure.invalidBinding }; return }
    guard !FileManager.default.fileExists(atPath: root.appendingPathComponent("video.reserved").path),
      !FileManager.default.fileExists(atPath: root.appendingPathComponent("video.mp4").path) else { throw CaptureFailure.invalidBinding }
    try CaptureStorage.durableWrite(bytes, to: file)
  }
  static func read(_ session: String) throws -> [String: Any] {
    let root = try directory(session)
    guard FileManager.default.fileExists(atPath: root.appendingPathComponent("research-complete.json").path),
      FileManager.default.fileExists(atPath: root.appendingPathComponent("video.mp4.finalized.json").path) else { throw CaptureFailure.invalidVideo }
    let media = root.appendingPathComponent("video.mp4"), journal = root.appendingPathComponent("native-journal.jsonl"), acquisition = root.appendingPathComponent("research-acquisition.json")
    let hasJournal = FileManager.default.fileExists(atPath: journal.path), hasAcquisition = FileManager.default.fileExists(atPath: acquisition.path)
    return ["captureSessionId": session, "binding": try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("research-context.json"))),
      "mediaSha256": try digest(media), "mediaByteLength": CaptureStorage.bytes(media),
      "journalSha256": hasJournal ? try digest(journal) : NSNull(), "acquisitionSha256": hasAcquisition ? try digest(acquisition) : NSNull(),
      "acquisition": hasAcquisition ? try JSONSerialization.jsonObject(with: Data(contentsOf: acquisition)) : NSNull(),
      "chainCoverage": "FINAL_FILE_ONLY", "appAttestation": "NOT_CHECKED"]
  }
  private static func key(_ scope: String) throws -> P256.Signing.PrivateKey {
    guard Bundle.main.bundleIdentifier == "com.packproof.mobile.research", !scope.isEmpty, scope.count <= 256 else { throw CaptureFailure.invalidBinding }
    let identity = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.packproof.research.capture.v1", kSecAttrAccount as String: identity]
    var lookup = query; lookup[kSecReturnData as String] = true
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess, let bytes = result as? Data { return try P256.Signing.PrivateKey(rawRepresentation: bytes) }
    guard status == errSecItemNotFound else { throw CaptureFailure.invalidBinding }
    let key = P256.Signing.PrivateKey()
    var insert = query; insert[kSecValueData as String] = key.rawRepresentation
    insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw CaptureFailure.storage }
    return key
  }
  static func prepare(_ scope: String) throws -> [String: String] {
    let signer = try key(scope)
    return ["publicKeySpki": signer.publicKey.derRepresentation.base64EncodedString(), "algorithm": "ES256_DER",
      "keyProtection": "IOS_KEYCHAIN_SOFTWARE", "appAttestation": "NOT_CHECKED"]
  }
  static func sign(session: String, scope: String, payload: String) throws -> [String: String] {
    let bytes = Data(payload.utf8)
    guard bytes.count <= 131072, let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw CaptureFailure.invalidBinding }
    let record = try read(session), root = try directory(session)
    guard body["schemaVersion"] as? String == "packproof.native-final-file.v1", body["chainCoverage"] as? String == "FINAL_FILE_ONLY",
      body["intentId"] as? String == (record["binding"] as? [String: Any])?["intentId"] as? String,
      body["captureSessionId"] as? String == session,
      body["proofId"] as? String == (record["binding"] as? [String: Any])?["proofId"] as? String,
      body["mediaByteLength"] as? Int64 == record["mediaByteLength"] as? Int64 else { throw CaptureFailure.invalidBinding }
    for field in ["mediaSha256", "journalSha256", "acquisitionSha256"] {
      let expected = record[field] as? String, supplied = (body[field] as? String)?.replacingOccurrences(of: "sha256:", with: "")
      guard expected == supplied else { throw CaptureFailure.invalidBinding }
    }
    let file = root.appendingPathComponent("research-signed-inventory.json")
    if FileManager.default.fileExists(atPath: file.path) {
      guard let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: String], saved["payload"] == payload else { throw CaptureFailure.invalidBinding }
      return ["signature": saved["signature"]!, "publicKeySpki": saved["publicKeySpki"]!, "algorithm": "ES256_DER"]
    }
    let signer = try key(scope)
    let signature = try signer.signature(for: bytes).derRepresentation.base64EncodedString()
    let publicKey = signer.publicKey.derRepresentation.base64EncodedString()
    try CaptureStorage.durableWrite(CaptureStorage.json(["payload": payload, "signature": signature, "publicKeySpki": publicKey]), to: file)
    return ["signature": signature, "publicKeySpki": publicKey, "algorithm": "ES256_DER"]
  }
  static func digest(_ file: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
    var hash = SHA256()
    while let bytes = try handle.read(upToCount: 262144), !bytes.isEmpty { hash.update(data: bytes) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
