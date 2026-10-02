package com.packproof.unifiedcamera

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.StatFs
import android.os.SystemClock
import androidx.camera.core.ImageProxy
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Optional R&D work shares the existing camera. One pending native task; no pixels cross JS. */
class ResearchCapture(private val context: Context, private val directory: File) {
  private val queue = Executors.newSingleThreadExecutor()
  private val busy = AtomicBoolean(false)
  private val ended = AtomicBoolean(false)
  private val started = SystemClock.elapsedRealtimeNanos()
  private var lastSample = 0L
  private var lumaBuffer: ByteArray? = null
  private var count = 0
  private var dropped = 0
  @Volatile private var disabled: String? = if(JSONObject(File(directory, "research-context.json").readText()).optBoolean("samplingEnabled", false)) null else "COLLECTION_DISABLED"
  private val frames = arrayOfNulls<JSONObject>(6)
  private data class RegionFrame(val pts:String,val luma:ByteArray,val metadata:String,val width:Int,val height:Int)
  @Volatile private var regionFrame:RegionFrame?=null
  @Volatile private var regionUnavailableReason="NO_EXACT_BARCODE_FRAME"
  private var lastRegionMs=-1000L
  private val telemetry = JSONArray()
  private var lastTelemetry = -1000L
  private val challenge = JSONObject(File(directory, "research-context.json").readText()).optJSONObject("passiveChallenge")
  private val controlEvents = JSONArray()
  fun passiveLeaseDurationMs(): Long {
    if (challenge == null || challenge.optString("mode") != "PASSIVE_LAB" || challenge.optBoolean("activeIlluminationEnabled", true) || challenge.optJSONArray("commands")?.length() != 0) return 0
    return (challenge.optLong("expiresAtMs") - System.currentTimeMillis()).coerceIn(0, 5000)
  }
  fun controlEvent(type: String, reason: String) {
    val at = (SystemClock.elapsedRealtimeNanos()-started).toString()
    if (!ended.get()) queue.execute {
      if(controlEvents.length()<8) controlEvents.put(JSONObject().put("type",type).put("reason",reason).put("monotonicNs",at).put("restoration","ORDINARY_CONTROLS_UNCHANGED"))
    }
  }
  // At most one full luma copy (2 MiB) is pending, plus six disk artifacts. Never retain ImageProxy.
  fun sample(image: ImageProxy, mediaTimeMs: Long) {
    if (ended.get() || disabled != null) return
    val now = SystemClock.elapsedRealtimeNanos()
    if (now - lastSample < 250_000_000L) return
    lastSample = now
    if (Build.VERSION.SDK_INT >= 29 && (context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE) { disable("THERMAL_PRESSURE"); return }
    if (StatFs(directory.path).availableBytes < 64L * 1024 * 1024) { disable("DISK_PRESSURE"); return }
    if (image.width * image.height > 2_097_152) { disable("ANALYSIS_FRAME_EXCEEDS_BUFFER"); return }
    if (!busy.compareAndSet(false, true)) { dropped++; return }
    try {
      val plane = image.planes[0]
      val buffer = plane.buffer.duplicate()
      val luma = lumaBuffer?.takeIf { it.size == image.width * image.height } ?: ByteArray(image.width * image.height).also { lumaBuffer = it }
      for (y in 0 until image.height) for (x in 0 until image.width) luma[y * image.width + x] = buffer.get(y * plane.rowStride + x * plane.pixelStride)
      val width = image.width; val height = image.height
      val pts = image.imageInfo.timestamp.toString(); val rotation = image.imageInfo.rotationDegrees
      queue.execute {
        try { process(luma, width, height, rotation, pts, now, mediaTimeMs) }
        catch (_: Exception) { disabled = "OPTIONAL_STORAGE_OR_PROCESSING_FAILURE" }
        finally { busy.set(false) }
      }
    } catch (_: OutOfMemoryError) { busy.set(false); lumaBuffer = null; disable("MEMORY_PRESSURE") }
    catch (_: Exception) { busy.set(false); disable("OPTIONAL_FRAME_UNAVAILABLE") }
  }
  private fun process(luma: ByteArray, width: Int, height: Int, rotation: Int, pts: String, now: Long, mediaMs: Long) {
    val quality = ResearchQuality.measure(luma, width, height)
    val frame = JSONObject().put("sampleId", count++).put("mediaTimeMs", mediaMs)
      .put("presentationTimestampNs", pts).put("presentationClockDomain", "CAMERAX_IMAGEINFO_UNQUALIFIED")
      .put("monotonicNs", (now - started).toString()).put("clockDomain", "ANDROID_ELAPSED_REALTIME")
      .put("timestampRelationship", "CONCURRENT_WITH_ENCODER_APPROXIMATE").put("timestampUncertaintyMs", JSONObject.NULL)
      .put("width", width).put("height", height).put("rotationDegrees", rotation)
      .put("cameraId", JSONObject.NULL).put("cameraIdReason", "CAMERAX_OWNER_BACK_CAMERA_NO_CAMERA2_ASSERTION")
      .put("exposureSeconds", JSONObject.NULL).put("focusDistance", JSONObject.NULL)
      .put("unavailableMetadataReason", "CAMERAX_PUBLIC_ANALYSIS_METADATA_NOT_EXPOSED")
      .put("streamProfile", "existing-preview-video-analysis").put("quality", JSONObject(quality))
    if (mediaMs - lastTelemetry >= 1000 && telemetry.length() < 301) { telemetry.put(JSONObject(frame.toString())); lastTelemetry = mediaMs }
    // One bounded immutable candidate cache permits exact asynchronous decoder linkage.
    regionFrame=RegionFrame(pts,luma.copyOf(),frame.toString(),width,height)
    // Context, ambiguous evidence, one barcode-region winner, and three diverse general frames.
    val slot = when {
      frames[0] == null -> 0
      frames[1] == null || quality.getValue("sharpness") < frames[1]!!.getJSONObject("quality").getDouble("sharpness") -> 1
      frames.drop(3).any { it != null && kotlin.math.abs(mediaMs - it.getLong("mediaTimeMs")) < 1000 } -> -1
      else -> (3..5).minByOrNull { frames[it]?.getJSONObject("quality")?.getDouble("sharpness") ?: -1.0 } ?: -1
    }
    if (slot >= 0 && (slot < 2 || frames[slot] == null || quality.getValue("sharpness") > frames[slot]!!.getJSONObject("quality").getDouble("sharpness") * 1.1)) {
      val bytes = "P5\n$width $height\n255\n".toByteArray() + luma
      val file = File(directory, "research-frame-$slot.pgm")
      write(file, bytes)
      frame.put("fileName", file.name).put("sha256", sha256(bytes)).put("byteLength", bytes.size)
        .put("relationship", "CONCURRENT_CAPTURED_SIDECAR").put("transform", "NATIVE_LUMA_PLANE_PGM_NO_RESIZE")
        .put("colorLimitation", "Luma plane only; not RGB or pixel-identical decoded video")
      frames[slot] = frame
      persist()
    }
  }
  fun observeBarcodeRegions(pts:String,width:Int,height:Int,rotation:Int,regions:List<IntArray>) {
    if(ended.get() || disabled!=null)return
    if(regions.size!=1){regionUnavailableReason=if(regions.isEmpty()) "NO_BARCODE_REGION" else "AMBIGUOUS_MULTIPLE_BARCODES";return}
    val candidate=regionFrame
    if(candidate==null || candidate.pts!=pts || candidate.width!=width || candidate.height!=height){regionUnavailableReason="DECODER_FRAME_NOT_IN_BOUNDED_CACHE";return}
    val bounds=ResearchRegions.nativeBounds(regions[0],width,height,rotation) ?: run {regionUnavailableReason="UNMAPPABLE_OR_CLIPPED_REGION";return}
    if(!busy.compareAndSet(false,true)){regionUnavailableReason="OPTIONAL_WORK_BACKPRESSURE";return}
    queue.execute {try {
      val frame=JSONObject(candidate.metadata);val mediaMs=frame.getLong("mediaTimeMs")
      val quality=ResearchRegions.quality(candidate.luma,width,height,bounds)
      if(quality.getValue("meanLuma")<12 || quality.getValue("meanLuma")>243 || quality.getValue("saturationFraction")>0.6){regionUnavailableReason="REGION_EXPOSURE_UNUSABLE";return@execute}
      val previous=frames[2]?.optJSONObject("regionQuality")?.optDouble("sharpness",-1.0) ?: -1.0
      if(frames[2]!=null && (mediaMs-lastRegionMs<750 || quality.getValue("sharpness")<=previous*1.1))return@execute
      val polygon=JSONArray().put(JSONArray(listOf(bounds[0],bounds[1]))).put(JSONArray(listOf(bounds[2],bounds[1]))).put(JSONArray(listOf(bounds[2],bounds[3]))).put(JSONArray(listOf(bounds[0],bounds[3])))
      frame.put("regionCandidates",JSONArray().put(JSONObject().put("target","BARCODE_REGION").put("coordinateSpace","stored-native-luma-pixels").put("polygon",polygon).put("association","EXACT_ANALYSIS_TIMESTAMP").put("identityInterpretation","UNASSIGNED")))
      frame.put("regionQuality",JSONObject(quality)).put("selectionTask","BARCODE_REGION")
      val bytes="P5\n$width $height\n255\n".toByteArray()+candidate.luma
      val file=File(directory,"research-frame-2.pgm");write(file,bytes)
      frame.put("fileName",file.name).put("sha256",sha256(bytes)).put("byteLength",bytes.size).put("relationship","CONCURRENT_CAPTURED_SIDECAR").put("transform","NATIVE_LUMA_PLANE_PGM_NO_RESIZE").put("colorLimitation","Luma only; not RGB or pixel-identical decoded video")
      frames[2]=frame;lastRegionMs=mediaMs;regionUnavailableReason="NONE";persist()
    }catch(_:Exception){regionUnavailableReason="OPTIONAL_REGION_FAILURE"}finally{busy.set(false)}}
  }
  fun disable(reason: String) { disabled = reason }
  fun finish(completion: () -> Unit) {
    ended.set(true)
    regionFrame=null
    queue.execute { try { persist(); write(File(directory, "research-complete.json"), "{}".toByteArray()) } catch (_: Exception) { /* Original remains independent. */ }; completion(); queue.shutdown() }
  }
  private fun persist() {
    val result = JSONObject().put("schemaVersion", "packproof.native-acquisition.v1").put("mode", "PASSIVE")
      .put("qualification", "UNQUALIFIED").put("findingState", "NOT_CHECKED").put("chainCoverage", "FINAL_FILE_ONLY")
      .put("samplesObserved", count).put("optionalBackpressureDrops", dropped).put("disabledReason", disabled ?: JSONObject.NULL)
      .put("taskCoverage",JSONObject().put("context",if(frames[0]!=null) "RECORDED" else "UNMET").put("barcodeRegion",if(frames[2]!=null) "RECORDED_UNQUALIFIED" else "UNMET").put("barcodeRegionReason",regionUnavailableReason)
        .put("labelOCR","UNMET_NO_NATIVE_OCR_PROFILE").put("serialOCR","UNMET_NO_NATIVE_OCR_PROFILE").put("cartonTexture","UNMET_NO_QUALIFIED_REGION_ASSOCIATION").put("itemSurface","UNMET_NO_QUALIFIED_REGION_ASSOCIATION").put("condition","UNMET_NO_QUALIFIED_REGION_ASSOCIATION"))
      .put("selectionPolicy","context-ambiguous-barcode-region-three-general-v1")
      .put("frames", JSONArray(frames.filterNotNull())).put("telemetry", telemetry).put("controlEvents", controlEvents)
      .put("controls", JSONObject().put("illumination", "NOT_REQUESTED").put("focus", "PASSIVE_ONLY").put("lease", if(controlEvents.length() == 0) "NONE" else "SEE_OWNER_EVENTS"))
    write(File(directory, "research-acquisition.json"), result.toString().toByteArray())
  }
  companion object {
    fun create(context: Context, directory: File): ResearchCapture? =
      if (context.packageName == "com.packproof.mobile.research" && File(directory, "research-context.json").exists()) runCatching { ResearchCapture(context, directory) }.getOrNull() else null
    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun write(file: File, bytes: ByteArray) { val temp = File(file.path + ".tmp"); FileOutputStream(temp).use { it.write(bytes); it.fd.sync() }; check(temp.renameTo(file)) }
  }
}

/** Interpretable luma measurements; never a physical-identity or authenticity score. */
object ResearchQuality {
  fun measure(luma: ByteArray, width: Int, height: Int): Map<String, Double> {
    require(width > 1 && height > 1 && luma.size == width * height)
    val step = maxOf(1, minOf(width, height) / 48)
    var sum = 0.0; var edge = 0.0; var saturated = 0; var count = 0
    for (y in step until height step step) for (x in step until width step step) {
      val v = luma[y * width + x].toInt() and 255
      sum += v; edge += kotlin.math.abs(v - (luma[y * width + x - step].toInt() and 255))
      if (v <= 5 || v >= 250) saturated++
      count++
    }
    return mapOf("meanLuma" to sum / count, "sharpness" to edge / count, "saturationFraction" to saturated.toDouble() / count)
  }
}
