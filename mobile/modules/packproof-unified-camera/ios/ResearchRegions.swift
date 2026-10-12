import Foundation

/// Bounds already transformed by the existing AVCaptureVideoDataOutput; no extra detector.
enum ResearchRegions {
  static func bounds(_ rect: CGRect, width: Int, height: Int) -> [Int]? {
    guard rect.minX.isFinite, rect.minY.isFinite, rect.maxX.isFinite, rect.maxY.isFinite,
      rect.minX >= 0, rect.minY >= 0, rect.maxX <= CGFloat(width), rect.maxY <= CGFloat(height),
      rect.width >= 4, rect.height >= 4 else { return nil }
    let value = [Int(ceil(rect.minX)), Int(ceil(rect.minY)), Int(floor(rect.maxX)), Int(floor(rect.maxY))]
    return value[2]-value[0] >= 4 && value[3]-value[1] >= 4 ? value : nil
  }
  static func quality(_ luma: Data, width: Int, height: Int, bounds: [Int]) -> [String: Double] {
    precondition(luma.count == width * height && bounds.count == 4)
    let step = max(1, min(bounds[2]-bounds[0], bounds[3]-bounds[1])/48)
    var sum = 0.0, sharp = 0.0, saturated = 0.0, count = 0.0
    luma.withUnsafeBytes { raw in
      let values = raw.bindMemory(to: UInt8.self)
      for y in stride(from: bounds[1]+step, to: bounds[3], by: step) {
        for x in stride(from: bounds[0]+step, to: bounds[2], by: step) {
          let value = Double(values[y*width+x]), previous = Double(values[y*width+x-step])
          sum += value; sharp += abs(value-previous); if value < 8 || value > 247 { saturated += 1 }; count += 1
        }
      }
    }
    precondition(count > 0)
    return ["meanLuma": sum/count, "sharpness": sharp/count, "saturationFraction": saturated/count]
  }
}
