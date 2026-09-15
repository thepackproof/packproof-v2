import Foundation
import Security

struct OrderShareIntakeSession: Codable {
  let token: String
  let sessionId: String
  let accountId: String
  let accountLabel: String
  let expiresAt: String
  let apiBaseURL: String

  var expiry: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
  }
  var isValid: Bool { guard let expiry else { return false }; return expiry > Date() }

  func validate() throws {
    guard token.hasPrefix("pp_intake_"), token.utf8.count <= 8192, !sessionId.isEmpty, sessionId.count <= 200,
          !accountId.isEmpty, accountId.count <= 512, !accountLabel.isEmpty, accountLabel.utf16.count <= 200,
          let expiry, expiry > Date(), expiry.timeIntervalSinceNow <= 12 * 60 * 60 + 60,
          let allowed = Bundle.main.object(forInfoDictionaryKey: "PackProofOrderShareAPIBaseURL") as? String,
          !allowed.isEmpty, apiBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == allowed.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
          let url = URL(string: apiBaseURL), url.scheme == "https", url.host != nil,
          url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
      throw OrderShareError.invalid("Open PackProof to refresh secure order sharing.")
    }
  }
}

/// Only the intake-restricted server token is shared. Never marketplace tokens,
/// Cognito refresh tokens, preferences, or synchronizable/iCloud Keychain items.
final class OrderShareSessionStore {
  private let group: String
  init() throws {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "PackProofOrderShareKeychainGroup") as? String,
          !value.isEmpty, !value.contains("$(") else {
      throw OrderShareError.invalid("Secure order sharing is unavailable in this build.")
    }
    group = value
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.packproof.order-share.intake-session",
     kSecAttrAccount as String: "current", kSecAttrAccessGroup as String: group,
     kSecAttrSynchronizable as String: false]
  }

  func read() throws -> OrderShareIntakeSession? {
    var lookup = query
    lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let result = SecItemCopyMatching(lookup as CFDictionary, &item)
    if result == errSecItemNotFound { return nil }
    guard result == errSecSuccess, let data = item as? Data, data.count <= 16_384 else {
      throw OrderShareError.invalid("Unlock your iPhone and open PackProof to restore secure order sharing.")
    }
    return try JSONDecoder().decode(OrderShareIntakeSession.self, from: data)
  }

  func save(_ session: OrderShareIntakeSession) throws {
    try session.validate()
    let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(session),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    var result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    if result == errSecItemNotFound {
      result = SecItemAdd(query.merging(attributes) { _, value in value } as CFDictionary, nil)
    }
    guard result == errSecSuccess else { throw OrderShareError.invalid("Could not enable secure order sharing. Try opening PackProof again.") }
  }

  func clear() throws {
    let result = SecItemDelete(query as CFDictionary)
    guard result == errSecSuccess || result == errSecItemNotFound else {
      throw OrderShareError.invalid("Could not clear secure order sharing. Unlock your iPhone and try again.")
    }
  }
}
