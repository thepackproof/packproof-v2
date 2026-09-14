import ExpoModulesCore
import Foundation
import Vision
import PDFKit
import ImageIO
import UIKit

public final class PackProofOrderShareModule: Module {
  private let queue = DispatchQueue(label: "com.packproof.order-share.extract", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("PackProofOrderShare")
    AsyncFunction("listPending") { () -> [[String: Any]] in
      try OrderShareStore().pending().map {
        ["id": $0.id, "createdAt": $0.createdAt * 1000, "attachmentCount": $0.attachments.count]
      }
    }.runOnQueue(queue)

    AsyncFunction("readOrder") { (id: String) -> [String: Any] in
      let store = try OrderShareStore(); let manifest = try store.read(id)
      var parts = manifest.text.isEmpty ? [] : [manifest.text]
      var warnings: [String] = []
      if !manifest.attachments.isEmpty {
        warnings.append("Text was read on this device from shared files. Check quantities, prices, and order numbers against the original before continuing.")
      }
      for attachment in manifest.attachments {
        let url = try store.attachmentURL(attachment, id: id)
        let extracted = try autoreleasepool { try self.extract(url, pdf: attachment.contentType == "application/pdf") }
        if !extracted.isEmpty { parts.append(extracted) }
        else { warnings.append("One shared file had no readable text. Add the missing order details before continuing.") }
      }
      let combined = parts.joined(separator: "\n\n")
      if combined.utf16.count > OrderShareStore.maxTextLength {
        warnings.append("Only the first 20,000 characters are shown. Check that the order details you need are included.")
      }
      // Convert by NSString range so the JS/backend UTF-16 limit is respected, without splitting a surrogate pair.
      var text = String(combined.prefix(OrderShareStore.maxTextLength))
      while text.utf16.count > OrderShareStore.maxTextLength { text.removeLast() }
      return ["id": manifest.id, "text": text, "warnings": warnings, "attachmentCount": manifest.attachments.count]
    }.runOnQueue(queue)

    // Reading never removes a manifest or source file. JS acknowledges only after
    // the user chooses to use the preview or explicitly discards the shared order.
    AsyncFunction("acknowledge") { (id: String) in try OrderShareStore().remove(id) }.runOnQueue(queue)
  }

  private func recognize(_ image: CGImage) throws -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
  }

  private func extract(_ url: URL, pdf: Bool) throws -> String {
    if pdf {
      guard let document = CGPDFDocument(url as CFURL), !document.isEncrypted,
            document.numberOfPages > 0, document.numberOfPages <= 12 else {
        throw OrderShareError.invalid("This PDF could not be read. Share an unencrypted PDF with up to 12 pages.")
      }
      let textDocument = PDFDocument(url: url)
      var pages: [String] = []
      for index in 1...document.numberOfPages {
        let text = try autoreleasepool { () throws -> String in
          if let value = textDocument?.page(at: index - 1)?.string,
             !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return value }
          guard let page = document.page(at: index) else { return "" }
          let box = page.getBoxRect(.mediaBox)
          guard box.width.isFinite, box.height.isFinite, box.width > 0, box.height > 0 else { return "" }
          let scale = min(2, 1800 / max(box.width, box.height))
          let width = max(1, Int(box.width * scale)), height = max(1, Int(box.height * scale))
          guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return "" }
          context.setFillColor(UIColor.white.cgColor)
          let bounds = CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height))
          context.fill(bounds)
          context.concatenate(page.getDrawingTransform(.mediaBox, rect: bounds, rotate: 0, preserveAspectRatio: true))
          context.drawPDFPage(page)
          guard let image = context.makeImage() else { return "" }
          return try recognize(image)
        }
        pages.append(text)
        if pages.reduce(0, { $0 + $1.utf16.count }) > OrderShareStore.maxTextLength { break }
      }
      return pages.joined(separator: "\n\n")
    }
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2200,
            kCGImageSourceShouldCacheImmediately: true
          ] as CFDictionary) else { throw OrderShareError.invalid("This image could not be read. Try sharing a JPEG or PNG.") }
    return try recognize(thumbnail)
  }
}
