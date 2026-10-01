package com.packproof.unifiedcamera

import android.app.ActivityManager
import android.content.Context
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.barcode.common.Barcode
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/** Optional diagnostic tap on the existing CameraX analyzer. Never binds a camera or touches video.
 * All calls are serialized by the analyzer executor. Six latest full analysis-stream originals are the
 * entire memory/disk budget; JPEG is an explicitly recorded acquisition transform, not sensor RAW.
 * Quality floors are diagnostic rejection rules, never a calibrated physical-identity threshold.
 */
class SurfaceSampler(private val context: Context, private val directory: File) {
  private val binding = JSONObject(File(directory, "surface-context.json").readText())
  private val expected = binding.optString("expectedTracking").replace(Regex("[\\s-]"), "").uppercase()
  private var previous: String? = null
  private var sequence = 0
  private var count = 0
  private val retained = java.util.ArrayDeque<String>()
  private var lastSavedMs = -2000L
  private var stableReads = 0
  private var lastBounds: Rect? = null
  private var stopped = false
  private var lastFrameNanos = 0L

  init { append("STARTED", JSONObject().put("profileId", "android-analysis-v1-unqualified").put("qualified", false)
    .put("binding", binding).put("source", "CAMERAX_ANALYSIS_STREAM").put("closureState", "UNKNOWN")) }

  private fun append(type: String, value: JSONObject) {
    val event = JSONObject().put("sequence", sequence).put("previous", previous ?: JSONObject.NULL)
      .put("type", type).put("value", value)
    val eventJson = event.toString()
    val digest = hash(eventJson.toByteArray())
    val row = JSONObject().put("eventJson", eventJson).put("sha256", digest).toString() + "\n"
    FileOutputStream(File(directory, "surface-journal.jsonl"), true).use { it.write(row.toByteArray()); it.fd.sync() }
    sequence += 1
    previous = digest
  }

  fun unavailable(reason: String, timeMs: Long) {
    if (stopped) return
    stopped = true
    try { append("UNAVAILABLE", JSONObject().put("reason", reason).put("frameTimeMs", timeMs)) } catch (_: Exception) { }
  }

  fun sample(image: ImageProxy, codes: List<Barcode>, timeMs: Long) {
    if (stopped) return
    if (count >= 200) { unavailable("SAMPLING_BUDGET_REACHED", timeMs); return }
    try {
      if (expected.isEmpty()) { unavailable("NO_EXPECTED_SHIPMENT_IDENTIFIER", timeMs); return }
      if (StatFs(directory.path).availableBytes < 192L * 1024 * 1024) { unavailable("DISK_PRESSURE", timeMs); return }
      val memory = ActivityManager.MemoryInfo()
      (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(memory)
      if (memory.lowMemory || memory.availMem < 128L * 1024 * 1024) { unavailable("MEMORY_PRESSURE", timeMs); return }
      if (Build.VERSION.SDK_INT >= 29 && (context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus >= PowerManager.THERMAL_STATUS_MODERATE) {
        unavailable("THERMAL_PRESSURE", timeMs); return
      }
      if (image.width * image.height > 4_194_304 || image.format != ImageFormat.YUV_420_888) { unavailable("STREAM_UNSUPPORTED", timeMs); return }
      val now = SystemClock.elapsedRealtimeNanos()
      if (lastFrameNanos > 0 && now - lastFrameNanos > 1_000_000_000) {
        stableReads = 0; lastBounds = null
        append("CONTINUITY", JSONObject().put("reason", "ANALYSIS_GAP").put("frameTimeMs", timeMs))
      }
      lastFrameNanos = now
      // Same-frame association only. Multiple different codes are ambiguous, even if one matches.
      val distinct = codes.mapNotNull { it.rawValue?.replace(Regex("[\\s-]"), "")?.uppercase() }.distinct()
      val matched = codes.firstOrNull { it.rawValue?.replace(Regex("[\\s-]"), "")?.uppercase() == expected }
      val box = matched?.boundingBox
      if (distinct.size != 1 || box == null) {
        if (stableReads > 0) append("CONTINUITY", JSONObject().put("reason", if (distinct.size > 1) "AMBIGUOUS_PARCELS" else "TRACK_LOST").put("frameTimeMs", timeMs))
        stableReads = 0; lastBounds = null; return
      }
      val prior = lastBounds
      val intersection = if (prior == null) Rect() else Rect(prior).apply { if (!intersect(box)) setEmpty() }
      val overlaps = prior != null && intersection.width().coerceAtLeast(0) * intersection.height().coerceAtLeast(0) >= minOf(prior.width()*prior.height(), box.width()*box.height()) / 2
      stableReads = if (overlaps) stableReads + 1 else 1
      lastBounds = Rect(box)
      if (stableReads < 3 || timeMs - lastSavedMs < 1_500) return
      val width = image.width; val height = image.height
      val y = image.planes[0]; val plane = y.buffer.duplicate()
      var sum = 0.0; var sum2 = 0.0; var saturated = 0; var n = 0; var gradient = 0.0
      for (row in 1 until height step 8) for (col in 1 until width step 8) {
        val value = plane.get(row * y.rowStride + col * y.pixelStride).toInt() and 255
        val left = plane.get(row * y.rowStride + (col-1)*y.pixelStride).toInt() and 255
        sum += value; sum2 += value*value; gradient += kotlin.math.abs(value-left); if (value >= 250 || value <= 5) saturated++; n++
      }
      val variance = sum2/n - (sum/n)*(sum/n)
      // Diagnostic-only frame eligibility. No quality threshold is represented as scientifically qualified.
      if (variance < 20 || gradient/n < 1 || saturated.toDouble()/n > 0.8) return
      val nv21 = ByteArray(width*height*3/2)
      for (row in 0 until height) for (col in 0 until width) nv21[row*width+col] = plane.get(row*y.rowStride+col*y.pixelStride)
      for (p in 1..2) {
        val chroma = image.planes[p]; val buffer = chroma.buffer.duplicate()
        for (row in 0 until height/2) for (col in 0 until width/2) nv21[width*height + row*width + col*2 + (if (p == 2) 0 else 1)] = buffer.get(row*chroma.rowStride+col*chroma.pixelStride)
      }
      val encoded = ByteArrayOutputStream()
      check(YuvImage(nv21, ImageFormat.NV21, width, height, null).compressToJpeg(Rect(0,0,width,height), 95, encoded))
      val bytes = encoded.toByteArray()
      if (bytes.size > 8*1024*1024) { unavailable("SOURCE_BUDGET_EXCEEDED", timeMs); return }
      if (retained.sumOf { File(directory, it).length() } + bytes.size > 8L*1024*1024) { unavailable("CAPTURE_BYTE_BUDGET_REACHED", timeMs); return }
      val name = "surface-original-${count}.jpg"
      val original = File(directory, name)
      check(original.createNewFile())
      FileOutputStream(original).use { it.write(bytes); it.fd.sync() }
      val frame = JSONObject().put("fileName", name).put("sha256", hash(bytes)).put("byteSize", bytes.size)
        .put("width", width).put("height", height).put("rotationDegrees", image.imageInfo.rotationDegrees)
        .put("frameTimeMs", timeMs).put("timestampPrecision", "ENCODER_PROGRESS_APPROXIMATE")
        .put("sensorTimestampNs", image.imageInfo.timestamp.toString()).put("monotonicNs", now.toString())
        .put("lens", JSONObject.NULL).put("selectedCamera", "BACK_DEFAULT").put("iso", JSONObject.NULL).put("exposureSeconds", JSONObject.NULL)
        .put("zoom", JSONObject.NULL).put("focusDistance", JSONObject.NULL).put("viewAngle", JSONObject.NULL)
        .put("glareFraction", JSONObject.NULL).put("motionBlur", JSONObject.NULL)
        .put("quality", JSONObject().put("lumaVariance", variance).put("meanAbsGradient", gradient/n).put("saturatedFraction", saturated.toDouble()/n).put("calibrated", false))
        .put("barcodeBounds", JSONArray(listOf(box.left, box.top, box.right, box.bottom)))
        .put("boundsSpace", "ROTATED_ANALYSIS_PIXELS").put("transform", "YUV420_TO_JPEG_QUALITY_95_NO_CROP_NO_RESIZE")
        .put("trackId", "expected-barcode-overlap").put("association", "SAME_FRAME_EXPECTED_BARCODE_ONLY")
      append("SOURCE", frame)
      retained.addLast(name)
      if (retained.size > 6) {
        val discarded = retained.removeFirst()
        // Candidates are not enrolled evidence. Journal replacement before deleting only this candidate.
        append("SUPERSEDED", JSONObject().put("fileName", discarded).put("reason", "PREFER_LATER_PACKAGE_SEGMENT"))
        if (!File(directory, discarded).delete()) { unavailable("CANDIDATE_CLEANUP_FAILED", timeMs); return }
      }
      count++; lastSavedMs = timeMs
    } catch (_: OutOfMemoryError) { unavailable("MEMORY_PRESSURE", timeMs) }
      catch (_: Exception) { unavailable("SIDECAR_WRITE_OR_ANALYSIS_FAILED", timeMs) }
  }

  fun finish(timeMs: Long, interrupted: Boolean) {
    try { append("FINISHED", JSONObject().put("frameTimeMs", timeMs).put("interrupted", interrupted).put("selectedCount", retained.size).put("qualified", false)) } catch (_: Exception) { }
    stopped = true
  }

  companion object {
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun bind(context: Context, sessionId: String, contextJson: String) {
      require(sessionId.matches(Regex("cap_[A-Za-z0-9_-]{1,91}")))
      require(contextJson.toByteArray().size <= 16_384)
      val binding = JSONObject(contextJson)
      require(binding.getString("captureSessionId") == sessionId && binding.getBoolean("experimental"))
      val directory = File(File(context.filesDir,"packproof-captures"),sessionId); directory.mkdirs()
      require(!File(directory,"video.mp4").exists())
      val file = File(directory,"surface-context.json")
      if (file.exists()) { require(file.readText() == contextJson); return }
      FileOutputStream(file).use { it.write(contextJson.toByteArray()); it.fd.sync() }
    }
    fun inspectSource(context: Context, sessionId: String, fileName: String): Map<String, Any> {
      require(sessionId.matches(Regex("cap_[A-Za-z0-9_-]{1,91}")))
      require(fileName == "video.mp4" || fileName.matches(Regex("surface-original-[0-9]{1,3}\\.jpg")))
      val directory = File(File(context.filesDir,"packproof-captures"),sessionId)
      val file = File(directory,fileName)
      require(file.isFile && file.length() <= 250_000_000)
      val digest = MessageDigest.getInstance("SHA-256")
      file.inputStream().use { input -> val buffer = ByteArray(65536); var size = input.read(buffer); while(size > 0) { digest.update(buffer,0,size); size = input.read(buffer) } }
      return mapOf("sha256" to digest.digest().joinToString("") { "%02x".format(it) }, "byteSize" to file.length().toDouble())
    }
    fun read(context: Context, sessionId: String): String {
      require(sessionId.matches(Regex("cap_[A-Za-z0-9_-]{1,91}")))
      val file = File(File(File(context.filesDir,"packproof-captures"),sessionId),"surface-journal.jsonl")
      require(file.length() <= 512*1024)
      return if (file.exists()) file.readText() else ""
    }
  }
}
