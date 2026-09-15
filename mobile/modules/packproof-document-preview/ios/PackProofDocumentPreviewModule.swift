import ExpoModulesCore
import Foundation
import PDFKit
import QuickLook
import UIKit

public final class PackProofDocumentPreviewModule: Module {
  private var activePreview: DocumentPreviewSession?
  private var backgroundObserver: NSObjectProtocol?
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("PackProofDocumentPreview")

    OnCreate {
      self.backgroundObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.activePreview?.cancel(code: "DOCUMENT_PREVIEW_INTERRUPTED", message: "The document review was interrupted. Open it again before approving.")
      }
    }

    AsyncFunction("previewDocument") { (uri: String, title: String?, promise: Promise) in
      guard !self.destroyed, UIApplication.shared.applicationState == .active else {
        promise.reject("DOCUMENT_PREVIEW_INACTIVE", "Open PackProof before reviewing this document.")
        return
      }
      guard self.activePreview == nil else {
        promise.reject("DOCUMENT_PREVIEW_BUSY", "Close the open document before reviewing another.")
        return
      }
      do {
        let item = try LocalPDFPreviewItem(uri: uri, title: title)
        guard QLPreviewController.canPreview(item), let presenter = self.activePresenter(),
              presenter.viewIfLoaded?.window != nil, !presenter.isBeingDismissed,
              !presenter.isBeingPresented else {
          promise.reject("DOCUMENT_PREVIEW_UNAVAILABLE", "The document preview cannot open right now. Try again.")
          return
        }
        let session = DocumentPreviewSession(item: item, promise: promise) { [weak self] in
          self?.activePreview = nil
        }
        self.activePreview = session
        session.present(from: presenter)
      } catch {
        promise.reject("DOCUMENT_PREVIEW_INVALID_FILE", "The verified PDF is unavailable or unreadable. Download it again before approving.")
      }
    }.runOnQueue(.main)

    AsyncFunction("cancelPreview") { (uri: String) -> Bool in
      // A departing screen must never dismiss a replacement screen's preview.
      guard let url = LocalPDFPreviewItem.normalizedOwnedURL(uri: uri),
            let session = self.activePreview, session.hasDocument(at: url) else { return false }
      return session.cancel(code: "DOCUMENT_PREVIEW_CANCELLED", message: "This document review is no longer active. Open it again before approving.")
    }.runOnQueue(.main)

    OnDestroy {
      if let observer = self.backgroundObserver {
        NotificationCenter.default.removeObserver(observer)
        self.backgroundObserver = nil
      }
      DispatchQueue.main.async {
        self.destroyed = true
        self.activePreview?.cancel(code: "DOCUMENT_PREVIEW_DESTROYED", message: "The document review closed. Open it again before approving.")
      }
    }
  }

  private func activePresenter() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive && $0.windows.contains(where: { $0.isKeyWindow }) }
    guard let root = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
    return topController(root)
  }

  private func topController(_ controller: UIViewController) -> UIViewController {
    if let presented = controller.presentedViewController { return topController(presented) }
    if let navigation = controller as? UINavigationController, let visible = navigation.visibleViewController {
      return topController(visible)
    }
    if let tabs = controller as? UITabBarController, let selected = tabs.selectedViewController {
      return topController(selected)
    }
    return controller
  }
}

private enum LocalPDFError: Error { case invalidFile }

private final class LocalPDFPreviewItem: NSObject, QLPreviewItem {
  let previewItemURL: URL?
  let previewItemTitle: String?
  // Keep PDFKit's validated document alive for the complete native review.
  private let document: PDFDocument

  static func normalizedOwnedURL(uri: String) -> URL? {
    guard let original = URL(string: uri), original.isFileURL,
          original.host == nil || original.host == "" || original.host == "localhost",
          original.user == nil, original.password == nil, original.port == nil,
          original.query == nil, original.fragment == nil else { return nil }
    let url = original.standardizedFileURL.resolvingSymlinksInPath()
    let manager = FileManager.default
    let roots = [
      manager.urls(for: .cachesDirectory, in: .userDomainMask).first,
      manager.urls(for: .documentDirectory, in: .userDomainMask).first,
      manager.temporaryDirectory,
    ].compactMap { $0?.standardizedFileURL.resolvingSymlinksInPath() }
    guard roots.contains(where: { url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/") }),
          url.pathExtension.lowercased() == "pdf" else { return nil }
    // Canonical local URLs ignore equivalent file://localhost spelling.
    return URL(fileURLWithPath: url.path)
  }

  init(uri: String, title: String?) throws {
    let manager = FileManager.default
    guard let url = Self.normalizedOwnedURL(uri: uri), manager.isReadableFile(atPath: url.path),
          let attributes = try? manager.attributesOfItem(atPath: url.path),
          attributes[.type] as? FileAttributeType == .typeRegular else { throw LocalPDFError.invalidFile }
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    guard try file.read(upToCount: 5) == Data("%PDF-".utf8),
          let parsed = PDFDocument(url: url), !parsed.isLocked,
          parsed.pageCount > 0, parsed.page(at: 0) != nil else { throw LocalPDFError.invalidFile }
    self.document = parsed
    self.previewItemURL = url
    let readableTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines)
    self.previewItemTitle = readableTitle?.isEmpty == false ? String(readableTitle!.prefix(200)) : "Document to review"
    super.init()
  }
}

private final class DocumentPreviewController: QLPreviewController {
  var didAppear: (() -> Void)?

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    didAppear?()
  }
}

private final class DocumentPreviewSession: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private let item: LocalPDFPreviewItem
  private let promise: Promise
  private let completion: () -> Void
  private let controller = DocumentPreviewController()
  private var appeared = false
  private var settled = false
  private var cancellation: (code: String, message: String)?

  init(item: LocalPDFPreviewItem, promise: Promise, completion: @escaping () -> Void) {
    self.item = item
    self.promise = promise
    self.completion = completion
    super.init()
    controller.dataSource = self
    controller.delegate = self
    controller.modalPresentationStyle = .fullScreen
    controller.didAppear = { [weak self] in self?.appeared = true }
  }

  func present(from presenter: UIViewController) {
    presenter.present(controller, animated: true) { [weak self] in
      guard let self = self, !self.settled else { return }
      self.controller.presentationController?.delegate = self
      if self.cancellation != nil {
        self.dismissForCancellation()
        return
      }
      if UIApplication.shared.applicationState != .active || self.controller.viewIfLoaded?.window == nil {
        self.cancel(code: "DOCUMENT_PREVIEW_UNAVAILABLE", message: "The document preview did not open. Try again before approving.")
      }
    }
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { item }

  func previewControllerDidDismiss(_ controller: QLPreviewController) { finishDismissal() }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finishDismissal() }

  // Approval concerns the existing bytes. QuickLook must not offer edited copies.
  func previewController(_ controller: QLPreviewController, editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode { .disabled }

  private func finishDismissal() {
    guard !settled else { return }
    settled = true
    controller.dataSource = nil
    controller.delegate = nil
    controller.didAppear = nil
    completion()
    if let cancellation = cancellation {
      promise.reject(cancellation.code, cancellation.message)
    } else if appeared && UIApplication.shared.applicationState == .active {
      promise.resolve(true)
    } else {
      promise.reject("DOCUMENT_PREVIEW_INTERRUPTED", "Review the document again before approving.")
    }
  }

  func hasDocument(at url: URL) -> Bool { item.previewItemURL == url }

  @discardableResult
  func cancel(code: String, message: String) -> Bool {
    guard !settled, cancellation == nil else { return false }
    cancellation = (code, message)
    // Wait for an in-flight presentation to complete before asking UIKit to
    // dismiss it. Its completion calls dismissForCancellation below.
    if !controller.isBeingPresented { dismissForCancellation() }
    return true
  }

  private func dismissForCancellation() {
    guard !settled else { return }
    // The caller may delete its cache file as soon as this promise settles.
    // Dismiss first so QuickLook no longer uses that file on cancellation.
    if controller.presentingViewController != nil {
      if !controller.isBeingDismissed {
        controller.dismiss(animated: false) { [self] in finishDismissal() }
      }
    } else {
      finishDismissal()
    }
  }
}
