package com.packproof.unifiedcamera

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.Future

/** Serial fsync journal; disk IO and hashing never run on the camera/main/analysis executor. */
class CaptureJournal(private val directory: File) {
  private val writer = Executors.newSingleThreadExecutor()
  private var failure: Exception? = null
  private var sequence = 0
  private var previous: String? = null
  private var startedNanos = SystemClock.elapsedRealtimeNanos()
  fun start() { startedNanos = SystemClock.elapsedRealtimeNanos(); append("CAPTURE_STARTED", 0, null) }
  fun append(type: String, mediaTimeMs: Long, value: String?) {
    val nanos = SystemClock.elapsedRealtimeNanos() - startedNanos
    writer.execute {
      if (failure != null) return@execute
      try {
        val event = JSONObject().put("sequence",sequence++).put("type",type)
          .put("mediaTimeMs",mediaTimeMs.coerceAtLeast(0)).put("monotonicNs",nanos.coerceAtLeast(0))
          .put("value",value ?: JSONObject.NULL).put("previous",previous ?: JSONObject.NULL)
        val bytes=event.toString().toByteArray(Charsets.UTF_8)
        val digest=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val record=JSONObject().put("event",event).put("sha256",digest).toString()+"\n"
        FileOutputStream(File(directory,"native-journal.jsonl"),true).use { out -> out.write(record.toByteArray());out.fd.sync() }
        previous=digest
      } catch(e:Exception) { failure=e }
    }
  }
  fun finish(durationMs:Long, completed:()->Unit, failed:()->Unit) {
    append("CAPTURE_ENDED",durationMs,null)
    writer.execute { if(failure==null) completed() else failed();writer.shutdown() }
  }
  companion object {
    private fun directory(context:Context,sessionId:String):File {
      require(sessionId.matches(Regex("cap_[A-Za-z0-9_-]{1,91}"))) { "Invalid capture session" }
      return File(File(context.filesDir,"packproof-captures"),sessionId)
    }
    fun bind(context:Context,sessionId:String,proofId:String,contextJson:String) {
      val supplied=JSONObject(contextJson)
      require(supplied.getString("captureId")==sessionId && supplied.getString("proofId")==proofId)
      require(contextJson.toByteArray().size<=65536)
      val directory=directory(context,sessionId);directory.mkdirs()
      val file=File(directory,"capture-context.json")
      if(file.exists()) { require(file.readText()==contextJson) { "Capture binding cannot change" };return }
      require(!File(directory,"video.mp4").exists()) { "Bind before recording" }
      val tmp=File(directory,"capture-context.json.tmp")
      FileOutputStream(tmp).use {it.write(contextJson.toByteArray());it.fd.sync()}
      require(tmp.renameTo(file)) { "Unable to preserve binding" }
    }
    fun read(context:Context,sessionId:String):String {
      val file=File(directory(context,sessionId),"native-journal.jsonl")
      require(file.length()<=1024*1024) { "Capture journal exceeds limits" }
      return if(file.exists())file.readText() else ""
    }
  }
}
