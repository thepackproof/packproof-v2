import XCTest
import CryptoKit
@testable import PackProofUnifiedCamera

final class ResearchCaptureTests: XCTestCase {
  func testQualityUsesCapturedLuma() {
    XCTAssertEqual(ResearchQuality.measure(Data(repeating: 127, count: 64), width: 8, height: 8)["sharpness"], 0)
    let stripes = Data((0..<64).map { UInt8($0 % 2 == 1 ? 255 : 0) })
    XCTAssertEqual(ResearchQuality.measure(stripes, width: 8, height: 8)["sharpness"], 255)
    XCTAssertEqual(ResearchQuality.measure(stripes, width: 8, height: 8)["saturationFraction"], 1)
  }
  func testCanonicalBytesAndNativeSignature() throws {
    let bytes = Data("[333333333.3333333,1e+30,4.5,0.002,1e-27,0,0.000001,1e-7,100000000000000000000,1e+21]".utf8)
    XCTAssertEqual(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), "17f4bfd1cfb41572dc8d58ae5418f6089b08ecc3f64047010c7c1df6e76316db")
    let key = P256.Signing.PrivateKey(), signature = try key.signature(for: bytes)
    let parsed = try P256.Signing.ECDSASignature(derRepresentation: signature.derRepresentation)
    XCTAssertTrue(key.publicKey.isValidSignature(parsed, for: bytes))
    XCTAssertFalse(key.publicKey.isValidSignature(parsed, for: bytes + Data([0])))
  }
  func testAllSharedCanonicalVectors() throws {
    // Exact shared RFC8785 UTF-8 bytes; native signing never reserializes caller-supplied JSON.
    let vectors: [(String, String)] = [
      ("eyJcciI6IkNSIiwiMSI6Im9uZSIsIjEyOCI6Im51bWVyaWMta2V5IiwiMiI6InR3byIsIuKCrCI6ImV1cm8iLCLwn5iAIjoiZW1vamkiLCLvrLMiOiJoZWJyZXcifQ==", "0ef45cec2acbeebfc35246b7a6ff16b12879b9ec33e2b4e46ccf10b2b9a87afa"),
      ("WzMzMzMzMzMzMy4zMzMzMzMzLDFlKzMwLDQuNSwwLjAwMiwxZS0yNywwLDAuMDAwMDAxLDFlLTcsMTAwMDAwMDAwMDAwMDAwMDAwMDAwLDFlKzIxXQ==", "17f4bfd1cfb41572dc8d58ae5418f6089b08ecc3f64047010c7c1df6e76316db"),
      ("eyJldmVudHMiOlt7InNlcXVlbmNlIjowLCJ0IjoibGluZVxuXHRcIlxcIn1dLCJudWxsVmFsdWUiOm51bGwsIm9mZnNldE5zIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAifQ==", "d3daa9fbd0e5445670cfb448d11b7e7b68a692ce5b56e124ba823f9d8d2579e2"),
      ("eyJfX3Byb3RvX18iOnsieCI6MX0sImNvbnN0cnVjdG9yIjpudWxsfQ==", "19924da02cb2c399e44240a96fbbab7ee2d142c3e93832a756bce3afad4f2da9")
    ]
    for (encoded, digest) in vectors {
      let bytes = try XCTUnwrap(Data(base64Encoded: encoded))
      XCTAssertEqual(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), digest)
    }
  }
  func testExactTransformedBarcodeBoundsAndRegionQuality() {
    XCTAssertEqual(ResearchRegions.bounds(CGRect(x: 10, y: 20, width: 20, height: 20), width: 100, height: 80), [10,20,30,40])
    XCTAssertNil(ResearchRegions.bounds(CGRect(x: -1, y: 0, width: 20, height: 20), width: 100, height: 80))
    XCTAssertNil(ResearchRegions.bounds(CGRect(x: 0, y: 0, width: 3, height: 3), width: 100, height: 80))
    XCTAssertEqual(ResearchRegions.quality(Data(repeating: 127, count: 64), width: 8, height: 8, bounds: [0,0,8,8])["sharpness"], 0)
  }
}
