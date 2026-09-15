import ExpoModulesCore
import Foundation

public final class PackProofOrderShareModule: Module {
  private let queue = DispatchQueue(label: "com.packproof.order-share.host", qos: .userInitiated)

  private func summary(_ value: OrderShareManifest) -> [String: Any] {
    ["id": value.id, "clientSubmissionId": value.clientSubmissionId, "createdAt": value.createdAt * 1000,
     "accountId": value.accountId as Any? ?? NSNull(), "deliveryState": value.deliveryState,
     "serverSubmissionId": value.serverSubmissionId as Any? ?? NSNull(), "attachmentCount": 0,
     "surface": value.surface, "errorCode": value.errorCode as Any? ?? NSNull()]
  }

  public func definition() -> ModuleDefinition {
    Name("PackProofOrderShare")
    AsyncFunction("listPending") { () -> [[String: Any]] in
      try OrderShareStore().pending().map { self.summary($0) }
    }.runOnQueue(queue)

    AsyncFunction("readOrder") { (id: String) -> [String: Any] in
      let value = try OrderShareStore().read(id)
      var result = self.summary(value)
      result["text"] = value.text; result["payloadKind"] = value.payloadKind; result["payloadHash"] = value.payloadHash
      result["warnings"] = value.errorCode == "UNSUPPORTED_LEGACY_ATTACHMENT"
        ? ["This earlier share includes files. Share its order text or link again, then discard this saved item."] : []
      return result
    }.runOnQueue(queue)

    AsyncFunction("enqueue") { (text: String, payloadKind: String, surface: String) -> [String: Any] in
      let store = try OrderShareStore()
      let saved = try store.save(text: text, kind: payloadKind, surface: surface, accountId: store.activeAccount())
      var result = self.summary(saved)
      result["text"] = saved.text; result["payloadKind"] = saved.payloadKind
      result["payloadHash"] = saved.payloadHash; result["warnings"] = [String]()
      return result
    }.runOnQueue(queue)

    AsyncFunction("setActiveAccount") { (accountId: String?) in
      try OrderShareStore().setActiveAccount(accountId)
    }.runOnQueue(queue)

    AsyncFunction("assignAccount") { (id: String, accountId: String) in
      try OrderShareStore().assignAccount(id, accountId: accountId)
    }.runOnQueue(queue)

    // Server acceptance is distinct from explicit discard. Reading, previewing,
    // queuing, or scheduling never removes a pending input.
    AsyncFunction("acknowledge") { (id: String, serverSubmissionId: String) in
      try OrderShareStore().acknowledge(id, serverSubmissionId: serverSubmissionId)
    }.runOnQueue(queue)
    AsyncFunction("discard") { (id: String) in try OrderShareStore().remove(id) }.runOnQueue(queue)

    AsyncFunction("setIntakeSession") { (input: [String: String]) in
      guard let token = input["token"], let sessionId = input["sessionId"], let accountId = input["accountId"],
            let accountLabel = input["accountLabel"], let expiresAt = input["expiresAt"], let apiBaseURL = input["apiBaseURL"] else {
        throw OrderShareError.invalid("The secure order-sharing session is incomplete.")
      }
      try OrderShareStore().setIntakeSession(OrderShareIntakeSession(token: token, sessionId: sessionId,
        accountId: accountId, accountLabel: accountLabel, expiresAt: expiresAt, apiBaseURL: apiBaseURL))
    }.runOnQueue(queue)
    AsyncFunction("clearIntakeSession") { () in try OrderShareStore().clearIntakeSession() }.runOnQueue(queue)
  }
}
