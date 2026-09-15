import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private enum Phase { case loading, ready, saving, saved, failed, closed }
  private var phase = Phase.loading
  private let status = UILabel()
  private let account = UILabel()
  private let summary = UILabel()
  private let addButton = UIButton(type: .system)
  private let cancelButton = UIButton(type: .system)
  private let worker = DispatchQueue(label: "com.packproof.order-share.save", qos: .userInitiated)
  private var timeout: DispatchWorkItem?
  private var transport: ShareIntakeTransport?
  private var accountId: String?
  private var textParts: [String] = []
  private var webURLs: [String] = []
  private var payloadText = ""
  private var payloadKind = "TEXT"

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Add to PackProof"; title.font = .preferredFont(forTextStyle: .title2)
    for label in [title, account, summary, status] {
      label.numberOfLines = 0; label.adjustsFontForContentSizeCategory = true
      if label !== title { label.font = .preferredFont(forTextStyle: .body) }
    }
    summary.textColor = .secondaryLabel; summary.lineBreakMode = .byTruncatingTail; summary.numberOfLines = 5
    account.text = "Checking destination account…"; status.text = "Loading shared details…"
    addButton.setTitle("Add to PackProof", for: .normal); addButton.isEnabled = false
    addButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    addButton.titleLabel?.adjustsFontForContentSizeCategory = true
    addButton.addTarget(self, action: #selector(save), for: .touchUpInside)
    cancelButton.setTitle("Cancel", for: .normal)
    cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .body)
    cancelButton.titleLabel?.adjustsFontForContentSizeCategory = true
    cancelButton.addTarget(self, action: #selector(closeShare), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [title, account, summary, status, addButton, cancelButton])
    stack.axis = .vertical; stack.spacing = 18; stack.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll); scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
      addButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
      cancelButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
    ])
    loadInput()
  }

  private func loadInput() {
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    let providers = items.flatMap { $0.attachments ?? [] }
    guard providers.count <= 4, items.count <= 4 else {
      fail("Share one order link or a small selection of plain text."); return
    }
    // Some hosts place the order number in attributedContentText alongside a URL provider.
    textParts = items.compactMap { $0.attributedContentText?.string }
    let loadingTimeout = DispatchWorkItem { [weak self] in
      guard let self, self.phase == .loading else { return }
      self.fail("The source app did not finish sharing. Cancel and try sharing its text or link again.")
    }
    timeout = loadingTimeout; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: loadingTimeout)
    worker.async { [weak self] in
      do {
        let store = try OrderShareStore(); let destination = try store.activeAccount()
        let credential = try? OrderShareSessionStore().read()
        DispatchQueue.main.async {
          guard let self, self.phase == .loading else { return }
          self.accountId = destination
          if destination == nil { self.account.text = "No account selected. Open PackProof later to choose where to add this." }
          else if let credential, credential.accountId == destination { self.account.text = "Destination: \(credential.accountLabel)" }
          else { self.account.text = "Destination: your signed-in PackProof account" }
          self.load(providers, at: 0)
        }
      } catch { DispatchQueue.main.async { self?.fail(error.localizedDescription) } }
    }
  }

  private func load(_ providers: [NSItemProvider], at index: Int) {
    guard phase == .loading else { return }
    guard index < providers.count else { prepare(); return }
    let provider = providers[index]
    let isURL = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
    let type = isURL ? UTType.url : UTType.plainText
    guard provider.hasItemConformingToTypeIdentifier(type.identifier) else {
      fail("This share contains an unsupported file. Share the order's text or web link."); return
    }
    // A URL representation takes priority over a second text representation of
    // the same provider. No attachment copying or webpage fetch occurs here.
    provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { [weak self] value, error in
      DispatchQueue.main.async {
        guard let self, self.phase == .loading else { return }
        var text: String?
        if let url = value as? URL { text = url.absoluteString }
        else if let string = value as? String { text = string }
        else if let string = value as? NSAttributedString { text = string.string }
        else if let data = value as? Data, data.count <= OrderShareStore.maxRequestBytes { text = String(data: data, encoding: .utf8) }
        guard error == nil, let text, text.utf16.count <= OrderShareStore.maxTextLength else {
          self.fail("The shared details could not be read. Share plain text or a link up to 20,000 characters."); return
        }
        if isURL {
          do { try OrderShareStore.validateWebURL(text) } catch { self.fail(error.localizedDescription); return }
          if !self.webURLs.contains(text) { self.webURLs.append(text) }
        } else if !self.textParts.contains(text) { self.textParts.append(text) }
        self.load(providers, at: index + 1)
      }
    }
  }

  private func prepare() {
    timeout?.cancel(); timeout = nil
    guard webURLs.count <= 1 else { fail("Share one order link at a time."); return }
    let usefulText = textParts.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty && !webURLs.contains($0) }
    payloadText = (webURLs + usefulText).joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !payloadText.isEmpty, payloadText.utf16.count <= OrderShareStore.maxTextLength else {
      fail("Share plain order text or a web link up to 20,000 characters."); return
    }
    if (try? OrderShareStore.validateWebURL(payloadText)) != nil { payloadKind = "URL" }
    else { payloadKind = "TEXT" }
    // Never display query values or URL fragments in the extension preview.
    if payloadKind == "URL", let url = URL(string: payloadText) { summary.text = "Order link from \(url.host ?? "shared website")" }
    else { summary.text = String(payloadText.prefix(320)) }
    status.text = "Save these details to prepare an order for packing."
    phase = .ready; addButton.isEnabled = true
  }

  @objc private func save() {
    guard phase == .ready else { return }
    phase = .saving; addButton.isEnabled = false; cancelButton.isEnabled = false; status.text = "Saving…"
    let text = payloadText, kind = payloadKind, destination = accountId
    worker.async { [weak self] in
      do {
        let store = try OrderShareStore()
        let saved = try store.save(text: text, kind: kind, surface: "IOS_SHARE", accountId: destination)
        let credential = try? OrderShareSessionStore().read()
        DispatchQueue.main.async {
          guard let self, self.phase == .saving else { return }
          if let credential, credential.isValid, credential.accountId == saved.accountId {
            let transport = ShareIntakeTransport(); self.transport = transport
            transport.submit(saved, credential: credential) { [weak self] receipt in self?.finish(saved, receipt: receipt) }
          } else { self.finish(saved, receipt: nil) }
        }
      } catch { DispatchQueue.main.async { self?.fail(error.localizedDescription) } }
    }
  }

  private func finish(_ manifest: OrderShareManifest, receipt: ShareIntakeTransport.Receipt?) {
    guard phase == .saving else { return }
    transport = nil
    guard let receipt else {
      showSaved("Saved on this iPhone. Open PackProof within 7 days to finish adding it."); return
    }
    worker.async { [weak self] in
      do {
        try OrderShareStore().acknowledge(manifest.id, serverSubmissionId: receipt.submissionId)
        DispatchQueue.main.async {
          self?.showSaved(receipt.state == "READY" ? "Added to your packing queue."
            : "Added to PackProof. Open PackProof to finish preparing this order.")
        }
      } catch {
        // Server accepted, but retain the local record if receipt persistence
        // failed. Replaying its stable client ID reconciles the same submission.
        DispatchQueue.main.async { self?.showSaved("Added to PackProof. Open PackProof to confirm its status.") }
      }
    }
  }

  private func showSaved(_ message: String) {
    guard phase == .saving else { return }
    phase = .saved; payloadText = ""; textParts = []; webURLs = []; summary.text = nil
    status.text = message; addButton.isHidden = true
    cancelButton.setTitle("Done", for: .normal); cancelButton.isEnabled = true
    UIAccessibility.post(notification: .announcement, argument: message)
  }

  private func fail(_ message: String) {
    guard phase != .closed else { return }
    timeout?.cancel(); timeout = nil; phase = .failed
    status.text = message; addButton.isHidden = true; cancelButton.isEnabled = true
  }

  @objc private func closeShare() {
    guard phase != .saving, phase != .closed else { return }
    let saved = phase == .saved
    phase = .closed; timeout?.cancel(); timeout = nil; transport?.cancel(); transport = nil
    if saved { extensionContext?.completeRequest(returningItems: nil, completionHandler: nil) }
    else { extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)) }
  }
}
