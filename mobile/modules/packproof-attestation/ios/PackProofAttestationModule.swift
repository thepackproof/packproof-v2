import CryptoKit
import ExpoModulesCore
import LocalAuthentication
import Security
import UIKit

/// Only public keys and signatures cross this bridge. Apple owns biometric
/// enrollment, matching, and UI; PackProof never reads biometric samples or IDs.
public final class PackProofAttestationModule: Module {
  private let keyQueue = DispatchQueue(label: "com.packproof.attestation.keys", qos: .userInitiated)
  // Operation state is main-queue confined. Cancellation retains the lock until
  // the worker finishes, preventing an old worker from racing key preparation.
  private var active: Operation?
  private var destroyed = false
  private var backgroundObserver: NSObjectProtocol?

  private struct Failure: Error {
    let code: String
    let message: String
  }

  private final class Operation {
    let promise: Promise
    let context: LAContext
    var cancelled = false
    var timeout: DispatchWorkItem?
    init(promise: Promise, context: LAContext) {
      self.promise = promise
      self.context = context
    }
  }

  public func definition() -> ModuleDefinition {
    Name("PackProofAttestation")

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.cancelActive() }
    }

    AsyncFunction("getAvailability") { (promise: Promise) in
      if let failure = self.availabilityFailure() {
        promise.resolve(["available": false, "code": failure.code, "message": failure.message] as [String: Any])
      } else {
        promise.resolve(["available": true])
      }
    }.runOnQueue(.main)

    AsyncFunction("prepareKey") { (userId: String, promise: Promise) in
      self.start(promise: promise, signing: false) { context in
        let tag = try self.keyTag(userId)
        // privateKeyUsage protects the signing operation, not reading its public
        // key. Preparation never invokes an authentication prompt.
        context.interactionNotAllowed = true
        let key: SecKey
        do {
          key = try self.existingKey(tag: tag, context: context) ?? self.generateKey(tag: tag)
        } catch {
          // Only a definite invalidation can retire a stored key. Transient
          // lockout, denial, cancellation, and unavailable UI never rotate it.
          guard self.failure(error).code == "ATTESTATION_KEY_INVALIDATED" else { throw error }
          try self.removeInvalidatedKey(tag: tag)
          key = try self.generateKey(tag: tag)
        }
        return ["publicKey": try self.publicKeyDER(key).base64EncodedString()]
      }
    }.runOnQueue(.main)

    AsyncFunction("sign") { (userId: String, payload: String, promise: Promise) in
      self.start(promise: promise, signing: true) { context in
        let tag = try self.keyTag(userId)
        let data = Data(payload.utf8)
        guard !data.isEmpty, data.count <= 32_768 else {
          throw Failure(code: "ATTESTATION_INVALID_PAYLOAD", message: "The attestation request is invalid. Try again.")
        }
        // A challenge for an invalidated key must fail. Only prepareKey may
        // create its replacement, before requesting a new server challenge.
        guard let key = try self.existingKey(tag: tag, context: context) else {
          throw Failure(code: "ATTESTATION_KEY_INVALIDATED", message: "Your biometric settings changed. Confirm the recording again to prepare a new attestation.")
        }
        let publicKeyHash = SHA256.hash(data: try self.publicKeyDER(key)).map { String(format: "%02x", $0) }.joined()
        guard let challenge = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          challenge["method"] as? String == "IOS_BIOMETRIC",
          challenge["actorUserId"] as? String == userId,
          challenge["publicKeySha256"] as? String == publicKeyHash else {
          throw Failure(code: "ATTESTATION_KEY_INVALIDATED", message: "Prepare a new attestation request for this account and try again.")
        }
        guard SecKeyIsAlgorithmSupported(key, .sign, .ecdsaSignatureMessageX962SHA256) else {
          throw Failure(code: "ATTESTATION_KEY_UNAVAILABLE", message: "This device cannot sign the attestation. Your recording is saved.")
        }
        var error: Unmanaged<CFError>?
        // Security evaluates biometryCurrentSet for this exact key operation.
        // No evaluatePolicy success boolean is used as signing authorization.
        guard let signature = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) else {
          let failure = self.failure(error?.takeRetainedValue())
          if failure.code == "ATTESTATION_KEY_INVALIDATED" { try? self.removeInvalidatedKey(tag: tag) }
          throw failure
        }
        return ["signature": (signature as Data).base64EncodedString()]
      }
    }.runOnQueue(.main)

    AsyncFunction("cancel") {
      self.cancelActive()
    }.runOnQueue(.main)

    OnDestroy {
      if let observer = self.backgroundObserver {
        NotificationCenter.default.removeObserver(observer)
        self.backgroundObserver = nil
      }
      DispatchQueue.main.async {
        self.destroyed = true
        self.cancelActive()
      }
    }
  }

  private func start(promise: Promise, signing: Bool, work: @escaping (LAContext) throws -> [String: String]) {
    guard !destroyed, UIApplication.shared.applicationState == .active else {
      promise.reject("ATTESTATION_ACTIVITY_UNAVAILABLE", "Keep PackProof open to attest and submit.")
      return
    }
    guard active == nil else {
      promise.reject("BIOMETRIC_BUSY", "An attestation is already in progress.")
      return
    }
    if let failure = availabilityFailure() {
      promise.reject(failure.code, failure.message)
      return
    }
    // A new, never-preauthenticated context for every request. Device unlock
    // authentication is never reused, and no passcode fallback is offered.
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.localizedFallbackTitle = ""
    context.localizedCancelTitle = "Cancel"
    context.localizedReason = "Confirm that the item shown in this Proof is the item you are shipping."
    let operation = Operation(promise: promise, context: context)
    active = operation
    let timeout = DispatchWorkItem { [weak self, weak operation] in
      guard let self, let operation, self.active === operation else { return }
      self.cancelActive(code: "BIOMETRIC_TIMEOUT", message: "Confirmation timed out. Your recording is saved; try again.")
    }
    operation.timeout = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + (signing ? 90 : 30), execute: timeout)
    keyQueue.async {
      let result: Result<[String: String], Error>
      do { result = .success(try work(context)) }
      catch { result = .failure(error) }
      DispatchQueue.main.async { self.finish(operation, result: result) }
    }
  }

  private func finish(_ operation: Operation, result: Result<[String: String], Error>) {
    guard active === operation else { return }
    operation.timeout?.cancel()
    operation.context.invalidate()
    active = nil
    guard !operation.cancelled, !destroyed else { return }
    switch result {
    case .success(let value): operation.promise.resolve(value)
    case .failure(let error):
      let safe = failure(error)
      operation.promise.reject(safe.code, safe.message)
    }
  }

  private func cancelActive(code: String = "BIOMETRIC_CANCELLED", message: String = "Attestation cancelled. Your recording has not been submitted.") {
    guard let operation = active, !operation.cancelled else { return }
    operation.cancelled = true
    operation.timeout?.cancel()
    operation.context.invalidate()
    operation.promise.reject(code, message)
  }

  private func availabilityFailure() -> Failure? {
    guard SecureEnclave.isAvailable else {
      return Failure(code: "BIOMETRIC_UNSUPPORTED", message: "Use an iPhone or iPad with Face ID or Touch ID to confirm this recording.")
    }
    let context = LAContext()
    defer { context.invalidate() }
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
      return failure(error)
    }
    return nil
  }

  private func keyTag(_ userId: String) throws -> Data {
    guard !userId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, userId.count <= 256 else {
      throw Failure(code: "ATTESTATION_INVALID_ACCOUNT", message: "Sign in again before attesting to this Proof.")
    }
    let digest = SHA256.hash(data: Data(userId.utf8)).map { String(format: "%02x", $0) }.joined()
    return Data("com.packproof.attestation.v1.\(digest)".utf8)
  }

  private func existingKey(tag: Data, context: LAContext) throws -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrApplicationTag as String: tag,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecReturnRef as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecUseAuthenticationContext as String: context,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let result else {
      throw failure(NSError(domain: NSOSStatusErrorDomain, code: Int(status)))
    }
    // The query requests a key reference of a known type from Security.
    return (result as! SecKey)
  }

  private func generateKey(tag: Data) throws -> SecKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      kCFAllocatorDefault, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
      [.privateKeyUsage, .biometryCurrentSet], &error
    ) else { throw failure(error?.takeRetainedValue()) }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ],
    ]
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw failure(error?.takeRetainedValue())
    }
    return key
  }

  private func removeInvalidatedKey(tag: Data) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
      kSecAttrApplicationTag as String: tag,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
    ]
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw failure(NSError(domain: NSOSStatusErrorDomain, code: Int(status)))
    }
  }

  private func publicKeyDER(_ privateKey: SecKey) throws -> Data {
    var error: Unmanaged<CFError>?
    guard let publicKey = SecKeyCopyPublicKey(privateKey),
      let external = SecKeyCopyExternalRepresentation(publicKey, &error) else {
      throw failure(error?.takeRetainedValue())
    }
    let point = external as Data
    guard point.count == 65, point.first == 0x04 else {
      throw Failure(code: "ATTESTATION_KEY_UNAVAILABLE", message: "The attestation key is unavailable. Try again.")
    }
    // Security exports the ANSI X9.63 uncompressed P-256 point. The API uses
    // canonical SubjectPublicKeyInfo DER (id-ecPublicKey + prime256v1).
    let header: [UInt8] = [0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00]
    return Data(header) + point
  }

  private func failure(_ error: Error?) -> Failure {
    if let failure = error as? Failure { return failure }
    let error = error as NSError?
    if error?.domain == LAError.errorDomain, let raw = error?.code, let code = LAError.Code(rawValue: raw) {
      switch code {
      case .userCancel, .appCancel, .systemCancel, .userFallback:
        return Failure(code: "BIOMETRIC_CANCELLED", message: "Attestation cancelled. Your recording has not been submitted.")
      case .biometryNotEnrolled:
        return Failure(code: "BIOMETRIC_NOT_ENROLLED", message: "Set up Face ID or Touch ID in Settings, then return to PackProof.")
      case .biometryLockout:
        return Failure(code: "BIOMETRIC_LOCKED_OUT", message: "Unlock your device to re-enable Face ID or Touch ID, then try again.")
      case .biometryNotAvailable, .passcodeNotSet:
        return Failure(code: "BIOMETRIC_UNAVAILABLE", message: "Enable Face ID or Touch ID for PackProof in Settings, then try again.")
      case .authenticationFailed:
        return Failure(code: "BIOMETRIC_NOT_RECOGNIZED", message: "Face ID or Touch ID did not confirm the attestation. Your recording is saved.")
      default: break
      }
    }
    if error?.domain == NSOSStatusErrorDomain {
      switch OSStatus(error?.code ?? 0) {
      case errSecUserCanceled:
        return Failure(code: "BIOMETRIC_CANCELLED", message: "Attestation cancelled. Your recording has not been submitted.")
      case errSecItemNotFound, errSecDecode:
        return Failure(code: "ATTESTATION_KEY_INVALIDATED", message: "Your attestation key is no longer available. Confirm the recording again to prepare a new request.")
      case errSecAuthFailed:
        return Failure(code: "BIOMETRIC_NOT_RECOGNIZED", message: "Face ID or Touch ID could not confirm this attestation. Your recording is saved; try again.")
      case errSecInteractionNotAllowed:
        return Failure(code: "BIOMETRIC_UNAVAILABLE", message: "Unlock your device and keep PackProof open, then try again.")
      default: break
      }
    }
    // System/vendor strings may contain unrelated details; do not send or log them.
    return Failure(code: "ATTESTATION_FAILED", message: "The attestation could not be completed. Your recording is saved; try again.")
  }
}
