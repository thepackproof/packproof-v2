package com.packproof.unifiedcamera

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Bounded optional inspection of the original; never edits, re-encodes or deletes it.
 * MediaMetadataRetriever selects a nearby frame, but does not return that frame's PTS.
 * Therefore all offsets are explicitly approximate, never claimed to be exact PTS.
 */
internal object EncodedBarcodeReader {
  fun inspect(context: Context, sessionId: String, requestedOffsets: List<Double>): Map<String, Any> {
    require(sessionId.matches(Regex("cap_[A-Za-z0-9_-]{1,91}")))
    val root = File(context.filesDir, "packproof-captures").canonicalFile
    val original = File(root, "$sessionId/video.mp4").canonicalFile
    require(original.parentFile?.parentFile == root && original.isFile && original.length() in 1..250_000_000L)
    require(File(original.path + ".finalized.json").isFile)
    val retriever = MediaMetadataRetriever()
    val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(
      Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_CODE_93,
      Barcode.FORMAT_CODABAR, Barcode.FORMAT_ITF, Barcode.FORMAT_QR_CODE,
      Barcode.FORMAT_PDF417, Barcode.FORMAT_AZTEC, Barcode.FORMAT_DATA_MATRIX,
    ).build())
    val observations = arrayListOf<Map<String, Any?>>()
    val frames = arrayListOf<Map<String, Any>>()
    val seen = hashSetOf<String>()
    var inspected = 0
    try {
      retriever.setDataSource(original.path)
      val duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
      require(duration in 1..1_800_000L)
      val width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
      val height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
      require(width in 1..4096 && height in 1..4096)
      // Prioritize observed moments, then nearby frames, then evenly spaced fallbacks.
      val offsets = linkedSetOf<Long>()
      requestedOffsets.take(8).filter { it.isFinite() && it >= 0 && it < duration }.forEach { offsets.add(it.toLong()) }
      requestedOffsets.take(4).filter { it.isFinite() && it >= 0 && it < duration }.forEach {
        offsets.add((it.toLong() - 750).coerceAtLeast(0)); offsets.add((it.toLong() + 750).coerceAtMost(duration - 1))
      }
      listOf(0.1, 0.3, 0.5, 0.7, 0.9).forEach { offsets.add((duration * it).toLong().coerceAtMost(duration - 1)) }
      val began = SystemClock.elapsedRealtime()
      for (offset in offsets.take(12)) {
        if (SystemClock.elapsedRealtime() - began > 6_000) break
        val ratio = minOf(1.0, 1280.0 / maxOf(width, height))
        val frame = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          retriever.getScaledFrameAtTime(offset * 1000, MediaMetadataRetriever.OPTION_CLOSEST,
            (width * ratio).toInt().coerceAtLeast(1), (height * ratio).toInt().coerceAtLeast(1))
        } else retriever.getFrameAtTime(offset * 1000, MediaMetadataRetriever.OPTION_CLOSEST)
        if (frame == null) continue
        inspected += 1
        try {
          val task = scanner.process(InputImage.fromBitmap(frame, 0))
          // Ownership remains with ML Kit if its asynchronous task outlives our budget.
          val codes = try { Tasks.await(task, 750, TimeUnit.MILLISECONDS) } catch (_: Exception) {
            task.addOnCompleteListener { frame.recycle() }
            continue
          }
          val shipping = codes.filter { code ->
            val raw = code.rawValue ?: ""
            raw.matches(Regex("[A-Za-z0-9 \\t\\r\\n-]{10,64}")) && raw.any { it.isDigit() }
          }
          for (code in shipping) {
            val raw = code.rawValue ?: continue
            if (!seen.add(raw.replace(Regex("[ \\t\\r\\n-]"), "").uppercase()) || observations.size >= 8) continue
            observations.add(mapOf(
              "rawValue" to raw, "format" to format(code.format),
              "detectedAtMs" to offset.toDouble(), "detectedAtUnixMs" to 0.0, "latencyMs" to 0.0,
              "source" to "ENCODED_VIDEO_FRAME", "coordinateSpace" to "DECODED_VIDEO_PIXELS",
              "decoderVersion" to "mlkit-barcode-17.2.0", "frameWidth" to frame.width, "frameHeight" to frame.height,
              "bounds" to code.boundingBox?.let { mapOf("left" to it.left, "top" to it.top, "right" to it.right, "bottom" to it.bottom) },
            ))
          }
          if (frames.size < 3 && (frames.isEmpty() || shipping.isNotEmpty())) {
            val file = File(original.parentFile, "review-frame-${frames.size}.png")
            file.outputStream().use { check(frame.compress(Bitmap.CompressFormat.PNG, 100, it)) }
            val digest = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { stream -> val buffer = ByteArray(65536); while (true) { val count = stream.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) } }
            frames.add(mapOf("uri" to Uri.fromFile(file).toString(), "sha256" to digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) },
              "requestedOffsetMs" to offset.toDouble(), "timestampPrecision" to "NEAR_REQUESTED_TIME",
              "transform" to "Nearby original video frame; scaled to fit 1280 pixels; PNG; no overlays"))
          }
          frame.recycle()
        } catch (_: Exception) { frame.recycle() }
      }
      return mapOf("playable" to (inspected > 0), "inspectedFrames" to inspected,
        "durationMs" to duration.toDouble(), "observations" to observations, "frames" to frames,
        "timestampPrecision" to "NEAR_REQUESTED_TIME")
    } finally { scanner.close(); retriever.release() }
  }

  private fun format(value: Int): String = when (value) {
    Barcode.FORMAT_CODE_128 -> "code128"; Barcode.FORMAT_CODE_39 -> "code39"
    Barcode.FORMAT_CODE_93 -> "code93"; Barcode.FORMAT_CODABAR -> "codabar"
    Barcode.FORMAT_ITF -> "itf"; Barcode.FORMAT_QR_CODE -> "qr"
    Barcode.FORMAT_PDF417 -> "pdf417"; Barcode.FORMAT_AZTEC -> "aztec"
    Barcode.FORMAT_DATA_MATRIX -> "datamatrix"; else -> "unknown"
  }
}
