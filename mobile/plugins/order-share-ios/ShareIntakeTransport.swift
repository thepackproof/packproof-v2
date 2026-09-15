import Foundation

/// Three-second foreground-only attempt. No cookies, cache, redirects, full-auth
/// tokens, or background-execution promise; the local outbox is the recovery path.
// URLSessionDelegate is Sendable in newer SDKs. The delegate queue and all
// explicit entry points are confined to main; no mutable state crosses queues.
final class ShareIntakeTransport: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  struct Receipt { let submissionId: String; let state: String }
  private var session: URLSession?
  private var response: HTTPURLResponse?
  private var bytes = Data()
  private var completion: ((Receipt?) -> Void)?
  private var deadline: DispatchWorkItem?
  private var clientSubmissionId = ""

  func submit(_ manifest: OrderShareManifest, credential: OrderShareIntakeSession, completion: @escaping (Receipt?) -> Void) {
    precondition(Thread.isMainThread)
    self.completion = completion; clientSubmissionId = manifest.clientSubmissionId
    do {
      try credential.validate()
      guard credential.accountId == manifest.accountId,
            credential.accountId == (try OrderShareStore().activeAccount()),
            let url = URL(string: credential.apiBaseURL.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/me/intake/submissions") else {
        finish(nil); return
      }
      var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
      request.httpMethod = "POST"; request.httpBody = try OrderShareStore.envelope(manifest)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue("Bearer " + credential.token, forHTTPHeaderField: "Authorization")
      let configuration = URLSessionConfiguration.ephemeral
      configuration.timeoutIntervalForRequest = 3; configuration.timeoutIntervalForResource = 3
      configuration.waitsForConnectivity = false; configuration.httpCookieStorage = nil
      configuration.urlCache = nil; configuration.urlCredentialStorage = nil
      let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
      self.session = session
      let timeout = DispatchWorkItem { [weak self] in self?.finish(nil) }
      deadline = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: timeout)
      session.dataTask(with: request).resume()
    } catch { finish(nil) }
  }

  func cancel() { finish(nil) }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                  newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                  completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    guard let response = response as? HTTPURLResponse, [200, 201, 202].contains(response.statusCode),
          response.expectedContentLength <= Int64(OrderShareStore.maxRequestBytes) else {
      completionHandler(.cancel); finish(nil); return
    }
    self.response = response; completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard bytes.count + data.count <= OrderShareStore.maxRequestBytes else { finish(nil); return }
    bytes.append(data)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard completion != nil else { return }
    guard error == nil, response != nil,
          let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
          let id = json["submissionId"] as? String,
          id.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil,
          json["clientSubmissionId"] as? String == clientSubmissionId,
          let state = json["state"] as? String,
          ["RECEIVED", "RESOLVING", "READY", "NEEDS_CONNECTION", "NEEDS_SELECTION", "INVALID", "RETRYABLE_FAILED", "DISMISSED"].contains(state)
          else { finish(nil); return }
    finish(Receipt(submissionId: id, state: state))
  }

  private func finish(_ receipt: Receipt?) {
    precondition(Thread.isMainThread)
    guard let done = completion else { return }
    completion = nil; deadline?.cancel(); deadline = nil
    session?.invalidateAndCancel(); session = nil; bytes = Data()
    done(receipt)
  }
}
