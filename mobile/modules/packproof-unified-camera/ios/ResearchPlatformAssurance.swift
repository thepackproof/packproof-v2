import DeviceCheck
import ExpoModulesCore
import Foundation

/// App Attest key IDs and assertions remain distinct from arbitrary media signing keys.
enum ResearchPlatformAssurance {
  static func availability() -> [String: Any] {
    ["supported": DCAppAttestService.shared.isSupported && Bundle.main.bundleIdentifier == "com.packproof.mobile.research",
     "verification": "NOT_CHECKED", "environment": "development"]
  }
  static func generate(_ promise: Promise) {
    guard DCAppAttestService.shared.isSupported, Bundle.main.bundleIdentifier == "com.packproof.mobile.research" else {
      promise.reject("RND_PLATFORM_UNSUPPORTED", "App Attest is unavailable on this research device"); return
    }
    DCAppAttestService.shared.generateKey { key, error in
      guard error == nil, let key else { promise.reject("RND_PLATFORM_UNAVAILABLE", "App Attest key could not be generated"); return }
      promise.resolve(["keyId": key, "verification": "NOT_CHECKED"])
    }
  }
  static func request(key: String, hashBase64: String, assertion: Bool, promise: Promise) {
    guard DCAppAttestService.shared.isSupported, Bundle.main.bundleIdentifier == "com.packproof.mobile.research",
      let hash = Data(base64Encoded: hashBase64), hash.count == 32, !key.isEmpty, key.count <= 256 else {
      promise.reject("RND_PLATFORM_UNSUPPORTED", "App Attest requires a supported device and SHA-256 server request binding"); return
    }
    let completion: (Data?, Error?) -> Void = { data, error in
      guard error == nil, let data else { promise.reject("RND_PLATFORM_UNAVAILABLE", "App Attest request unavailable; camera recording is unaffected"); return }
      promise.resolve(["keyId": key, "assertion": assertion, "objectBase64": data.base64EncodedString(), "verification": "NOT_CHECKED"])
    }
    if assertion { DCAppAttestService.shared.generateAssertion(key, clientDataHash: hash, completionHandler: completion) }
    else { DCAppAttestService.shared.attestKey(key, clientDataHash: hash, completionHandler: completion) }
  }
}
