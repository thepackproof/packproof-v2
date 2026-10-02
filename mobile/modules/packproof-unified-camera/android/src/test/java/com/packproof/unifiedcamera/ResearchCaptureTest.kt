package com.packproof.unifiedcamera

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class ResearchCaptureTest {
  @Test fun qualityHasNoFabricatedDetail() {
    val flat = ResearchQuality.measure(ByteArray(64) { 127 }, 8, 8)
    assertEquals(127.0, flat.getValue("meanLuma"), 0.0)
    assertEquals(0.0, flat.getValue("sharpness"), 0.0)
    val stripes = ResearchQuality.measure(ByteArray(64) { if (it % 2 == 1) 255.toByte() else 0 }, 8, 8)
    assertEquals(255.0, stripes.getValue("sharpness"), 0.0)
    assertEquals(1.0, stripes.getValue("saturationFraction"), 0.0)
  }
  @Test fun jcsBytesMatchServerAndDerSignaturesBindExactBytes() {
    // Shared canonical-vectors.json, numbers. Native signs supplied JCS, never reserializes it.
    val bytes = "[333333333.3333333,1e+30,4.5,0.002,1e-27,0,0.000001,1e-7,100000000000000000000,1e+21]".toByteArray(Charsets.UTF_8)
    assertEquals("17f4bfd1cfb41572dc8d58ae5418f6089b08ecc3f64047010c7c1df6e76316db", MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(pair.private); update(bytes) }.sign()
    assertTrue(Signature.getInstance("SHA256withECDSA").apply { initVerify(pair.public); update(bytes) }.verify(signature))
    assertFalse(Signature.getInstance("SHA256withECDSA").apply { initVerify(pair.public); update(bytes + 0) }.verify(signature))
  }
  @Test fun allSharedCanonicalVectorsHaveExactUtf8Digests() {
    // Base64 is the exact RFC8785 UTF-8 byte sequence from packages/evidence-contracts/canonical-vectors.json.
    val vectors = listOf(
      "eyJcciI6IkNSIiwiMSI6Im9uZSIsIjEyOCI6Im51bWVyaWMta2V5IiwiMiI6InR3byIsIuKCrCI6ImV1cm8iLCLwn5iAIjoiZW1vamkiLCLvrLMiOiJoZWJyZXcifQ==" to "0ef45cec2acbeebfc35246b7a6ff16b12879b9ec33e2b4e46ccf10b2b9a87afa",
      "WzMzMzMzMzMzMy4zMzMzMzMzLDFlKzMwLDQuNSwwLjAwMiwxZS0yNywwLDAuMDAwMDAxLDFlLTcsMTAwMDAwMDAwMDAwMDAwMDAwMDAwLDFlKzIxXQ==" to "17f4bfd1cfb41572dc8d58ae5418f6089b08ecc3f64047010c7c1df6e76316db",
      "eyJldmVudHMiOlt7InNlcXVlbmNlIjowLCJ0IjoibGluZVxuXHRcIlxcIn1dLCJudWxsVmFsdWUiOm51bGwsIm9mZnNldE5zIjoiMTIzNDU2Nzg5MDEyMzQ1Njc4OTAifQ==" to "d3daa9fbd0e5445670cfb448d11b7e7b68a692ce5b56e124ba823f9d8d2579e2",
      "eyJfX3Byb3RvX18iOnsieCI6MX0sImNvbnN0cnVjdG9yIjpudWxsfQ==" to "19924da02cb2c399e44240a96fbbab7ee2d142c3e93832a756bce3afad4f2da9"
    )
    for ((encoded, digest) in vectors) {
      val bytes = java.util.Base64.getDecoder().decode(encoded)
      assertEquals(digest, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
    }
  }
  @Test fun decoderRegionsMapExactlyAndRejectClippedAmbiguousGeometry() {
    assertArrayEquals(intArrayOf(10,20,30,40),ResearchRegions.nativeBounds(intArrayOf(10,20,30,40),100,80,0))
    assertArrayEquals(intArrayOf(20,50,40,70),ResearchRegions.nativeBounds(intArrayOf(10,20,30,40),100,80,90))
    assertArrayEquals(intArrayOf(70,40,90,60),ResearchRegions.nativeBounds(intArrayOf(10,20,30,40),100,80,180))
    assertArrayEquals(intArrayOf(60,10,80,30),ResearchRegions.nativeBounds(intArrayOf(10,20,30,40),100,80,270))
    assertNull(ResearchRegions.nativeBounds(intArrayOf(-1,0,40,40),100,80,0))
    assertNull(ResearchRegions.nativeBounds(intArrayOf(0,0,3,4),100,80,0))
    assertNull(ResearchRegions.nativeBounds(intArrayOf(0,0,40,40),100,80,45))
    val flat=ResearchRegions.quality(ByteArray(64){127},8,8,intArrayOf(0,0,8,8))
    assertEquals(0.0,flat.getValue("sharpness"),0.0);assertEquals(127.0,flat.getValue("meanLuma"),0.0)
  }
}
