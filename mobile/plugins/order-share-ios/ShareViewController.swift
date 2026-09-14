import UIKit
import UniformTypeIdentifiers
import ImageIO
import PDFKit

final class ShareViewController: UIViewController {
  private let status = UILabel()
  private let saveButton = UIButton(type: .system)
  private let cancellationLock = NSLock()
  private var progressValue: Progress?
  private var progress: Progress? {
    get { cancellationLock.lock(); defer { cancellationLock.unlock() }; return progressValue }
    set {
      cancellationLock.lock()
      progressValue = newValue
      let shouldCancel = cancellationValue
      cancellationLock.unlock()
      // The provider may return its Progress after the user already cancelled.
      if shouldCancel { newValue?.cancel() }
    }
  }
  private var cancellationValue = false
  private var cancelled: Bool {
    get { cancellationLock.lock(); defer { cancellationLock.unlock() }; return cancellationValue }
    set { cancellationLock.lock(); cancellationValue = newValue; cancellationLock.unlock() }
  }
  private var started = false
  private var inbox: OrderShareStore?
  private var shareID: String?
  private var directory: URL?
  private var textParts: [String] = []
  private var files: [OrderShareAttachment] = []
  private let worker = DispatchQueue(label: "com.packproof.order-share.import")

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Save to PackProof"; title.font = .preferredFont(forTextStyle: .title2)
    title.adjustsFontForContentSizeCategory = true
    status.text = "Save an order confirmation, receipt, or shipping link. Open PackProof afterward to review the details. Shared orders expire after 7 days."
    status.font = .preferredFont(forTextStyle: .body); status.numberOfLines = 0
    status.adjustsFontForContentSizeCategory = true
    saveButton.setTitle("Save order", for: .normal)
    saveButton.addTarget(self, action: #selector(save), for: .touchUpInside)
    let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal)
    cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
    let stack = UIStackView(arrangedSubviews: [title, status, saveButton, cancel])
    stack.axis = .vertical; stack.spacing = 20; stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
      stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      stack.bottomAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24)
    ])
  }

  @objc private func save() {
    guard !started else { return }
    started = true; saveButton.isEnabled = false; status.text = "Saving order…"
    let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
    let providers = items.flatMap { $0.attachments ?? [] }
    // Text-only hosts may use attributedContentText rather than a provider.
    if providers.isEmpty { textParts = items.compactMap { $0.attributedContentText?.string } }
    guard providers.count <= OrderShareStore.maxAttachments else {
      fail(OrderShareError.invalid("Share up to 4 items at a time, with a total size of 20 MB or less.")); return
    }
    worker.async { [self] in
      do {
        let store = try OrderShareStore(); let reservation = try store.reserve()
        inbox = store; shareID = reservation.0; directory = reservation.1
        load(providers, index: 0)
      } catch { fail(error) }
    }
  }

  private func load(_ providers: [NSItemProvider], index: Int) {
    guard !cancelled else { cleanup(); return }
    guard index < providers.count else { publish(); return }
    let provider = providers[index]
    // Prefer a concrete file to public.url, because file providers also advertise URLs.
    let supported: [(UTType, String, String)] = [(.pdf, "pdf", "application/pdf"), (.jpeg, "jpg", "image/jpeg"),
      (.png, "png", "image/png"), (.heic, "heic", "image/heic"), (.webP, "webp", "image/webp")]
    if let match = supported.first(where: { provider.hasItemConformingToTypeIdentifier($0.0.identifier) }) {
      progress = provider.loadFileRepresentation(forTypeIdentifier: match.0.identifier) { [self] url, error in
        // The provider's temporary file is valid only inside this callback. Copy now.
        guard !cancelled else { cleanup(); return }
        do {
          guard let url else { throw error ?? OrderShareError.invalid("The shared file could not be opened.") }
          let copied = try copyFile(url, ext: match.1, contentType: match.2)
          worker.async { [self] in
            guard !cancelled else { cleanup(); return }
            files.append(copied); load(providers, index: index + 1)
          }
        } catch { fail(error) }
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { [self] value, error in
        worker.async { [self] in
          guard !cancelled else { cleanup(); return }
          guard let url = value as? URL, let scheme = url.scheme?.lowercased(),
                ["https", "http"].contains(scheme), url.host != nil, url.user == nil, url.password == nil else {
            fail(error ?? OrderShareError.invalid("Share a public web link, order text, image, or PDF.")); return
          }
          textParts.append(url.absoluteString); load(providers, index: index + 1)
        }
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { [self] value, error in
        worker.async { [self] in
          guard !cancelled else { cleanup(); return }
          guard let text = value as? String, text.utf16.count <= OrderShareStore.maxTextLength else {
            fail(error ?? OrderShareError.invalid("Shared text must be 20,000 characters or fewer.")); return
          }
          textParts.append(text); load(providers, index: index + 1)
        }
      }
    } else { fail(OrderShareError.invalid("This file type is not supported. Share a JPEG, PNG, HEIC, WebP, PDF, link, or plain text.")) }
  }

  private func copyFile(_ source: URL, ext: String, contentType: String) throws -> OrderShareAttachment {
    guard source.isFileURL, let folder = directory else { throw OrderShareError.invalid("The shared file could not be opened.") }
    let scoped = source.startAccessingSecurityScopedResource()
    defer { if scoped { source.stopAccessingSecurityScopedResource() } }
    let values = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
    let size = values.fileSize ?? 0
    guard values.isRegularFile == true, values.isSymbolicLink != true, size > 0, size <= OrderShareStore.maxFileBytes,
          files.reduce(0, { $0 + $1.byteSize }) + size <= OrderShareStore.maxTotalBytes else {
      throw OrderShareError.invalid("Each file must be 10 MB or less, with a total size of 20 MB or less.")
    }
    let name = "\(UUID().uuidString.lowercased()).\(ext)"
    let destination = folder.appendingPathComponent(name)
    // Bounded streaming avoids loading provider bytes into the extension's small memory budget.
    guard let input = InputStream(url: source), let output = OutputStream(url: destination, append: false) else {
      throw OrderShareError.invalid("The shared file could not be copied.")
    }
    input.open(); output.open()
    defer { input.close(); output.close() }
    var buffer = [UInt8](repeating: 0, count: 64 * 1024); var written = 0
    while true {
      guard !cancelled else { throw OrderShareError.invalid("Sharing cancelled.") }
      let count = input.read(&buffer, maxLength: buffer.count)
      guard count >= 0 else { throw input.streamError ?? OrderShareError.invalid("Could not read the shared file.") }
      if count == 0 { break }
      written += count
      guard written <= size else { throw OrderShareError.invalid("The shared file changed while it was being copied.") }
      var offset = 0
      while offset < count {
        let amount = buffer.withUnsafeBufferPointer { output.write($0.baseAddress! + offset, maxLength: count - offset) }
        guard amount > 0 else { throw output.streamError ?? OrderShareError.invalid("Could not save the shared file.") }
        offset += amount
      }
    }
    guard written == size else { throw OrderShareError.invalid("The shared file was incomplete. Try sharing it again.") }
    // Finish the destination stream before a decoder or manifest reader opens it.
    input.close(); output.close()
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
    // Inspect actual bytes; the incoming filename/MIME declaration is not sufficient.
    if contentType == "application/pdf" {
      guard let pdf = CGPDFDocument(destination as CFURL), !pdf.isEncrypted,
            pdf.numberOfPages > 0, pdf.numberOfPages <= 12 else {
        throw OrderShareError.invalid("Share an unencrypted PDF containing 1–12 pages.")
      }
    } else {
      guard let image = CGImageSourceCreateWithURL(destination as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
            CGImageSourceGetCount(image) > 0,
            let properties = CGImageSourceCopyPropertiesAtIndex(image, 0, nil) as? [CFString: Any],
            let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
            let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
            width.doubleValue > 0, height.doubleValue > 0, width.doubleValue * height.doubleValue <= 50_000_000 else {
        throw OrderShareError.invalid("Share a supported image with a resolution of 50 megapixels or less.")
      }
    }
    return OrderShareAttachment(filename: name, contentType: contentType, byteSize: written)
  }

  private func publish() {
    guard !cancelled, let inbox, let shareID else { cleanup(); return }
    do {
      let text = textParts.joined(separator: "\n\n").trimmingCharacters(in: .whitespacesAndNewlines)
      try inbox.publish(OrderShareManifest(version: 1, id: shareID, createdAt: Date().timeIntervalSince1970,
                                           text: text, attachments: files))
      DispatchQueue.main.async { [self] in
        guard !cancelled else { cleanup(); return }
        status.text = "Saved. Open PackProof to review this order."
        // iOS Share Extensions cannot use UIApplication.shared to force-open the app.
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
      }
    } catch { fail(error) }
  }

  private func cleanup() { if let shareID { try? inbox?.remove(shareID) } }

  private func fail(_ error: Error) {
    worker.async { [self] in cleanup() }
    DispatchQueue.main.async { [self] in
      guard !cancelled else { return }
      status.text = error.localizedDescription
      // An import can be retried by sharing again; partially loaded providers aren't reused.
      saveButton.isHidden = true
    }
  }

  @objc private func cancelShare() {
    cancelled = true; progress?.cancel()
    worker.async { [self] in cleanup() }
    extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }
}
