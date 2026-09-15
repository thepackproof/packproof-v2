package com.packproof.ordershare

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** The only receiver store. noBackupFilesDir is app-private and survives process death.
 * AtomicFile fsync/rename precedes returning the opaque locator to MainActivity. */
object OrderShareStore {
  private const val MAX_TEXT = 20000
  private const val MAX_AGE = 7L * 24 * 60 * 60 * 1000
  private val uuid = Regex("^[a-fA-F0-9-]{36}$")
  private fun directory(context: Context) = File(context.noBackupFilesDir, "order-intake-v1").apply { mkdirs() }
  private fun file(context: Context, id: String): File {
    require(uuid.matches(id)) { "Invalid saved order identifier" }
    return File(directory(context), "$id.json")
  }
  private fun write(file: File, value: JSONObject) {
    val atomic = AtomicFile(file)
    val stream = atomic.startWrite()
    try { stream.write(value.toString().toByteArray(Charsets.UTF_8)); atomic.finishWrite(stream) }
    catch (error: Exception) { atomic.failWrite(stream); throw error }
  }
  private fun read(file: File) = JSONObject(AtomicFile(file).openRead().use { it.readBytes().toString(Charsets.UTF_8) })
  private fun activeFile(context: Context) = File(directory(context), "account.json")
  @Synchronized fun activeAccount(context: Context): String? = try { read(activeFile(context)).optString("accountId").takeIf { it.isNotBlank() } } catch (_: Exception) { null }
  @Synchronized fun setActiveAccount(context: Context, accountId: String?) {
    require(accountId == null || (accountId.isNotBlank() && accountId.length <= 256))
    if (activeAccount(context) != accountId) OrderShareSession.clear(context)
    write(activeFile(context), JSONObject().put("accountId", accountId ?: ""))
  }
  @Synchronized fun enqueue(context: Context, text: String, kind: String, surface: String, errorCode: String? = null): JSONObject {
    require(kind in listOf("TEXT", "URL"))
    require(surface in listOf("ANDROID_SHARE", "EXPLICIT_PASTE", "IOS_SHARE"))
    require(errorCode != null || (text.isNotBlank() && text.length <= MAX_TEXT && text.toByteArray().size <= 60000)) { "Share text or a link of at most 20,000 characters" }
    val id = UUID.randomUUID().toString()
    val value = JSONObject().put("schemaVersion", 1).put("id", id).put("clientSubmissionId", id)
      .put("createdAt", System.currentTimeMillis()).put("accountId", activeAccount(context) ?: JSONObject.NULL)
      .put("deliveryState", "LOCAL_PENDING").put("serverSubmissionId", JSONObject.NULL)
      .put("text", if (errorCode == null) text else "").put("payloadKind", kind).put("surface", surface)
      .put("attachmentCount", 0).put("warnings", org.json.JSONArray()).put("errorCode", errorCode ?: JSONObject.NULL)
      .put("payloadHash", MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) })
    write(file(context, id), value)
    if (errorCode == null && !value.isNull("accountId")) runCatching { OrderShareWorker.schedule(context, id) }
    return value
  }
  @Synchronized fun readOrder(context: Context, id: String): JSONObject {
    val value = read(file(context, id))
    if (value.optString("deliveryState") == "LOCAL_PENDING" && System.currentTimeMillis() - value.optLong("createdAt") > MAX_AGE) {
      value.put("text", "").put("errorCode", "INPUT_EXPIRED")
      write(file(context, id), value)
    }
    return value
  }
  @Synchronized fun listPending(context: Context): List<JSONObject> = directory(context).listFiles()?.filter { it.name.endsWith(".json") && uuid.matches(it.nameWithoutExtension) }
    ?.map { try { readOrder(context, it.nameWithoutExtension) } catch (_: Exception) {
      JSONObject().put("id", it.nameWithoutExtension).put("clientSubmissionId", it.nameWithoutExtension)
        .put("accountId", JSONObject.NULL).put("createdAt", it.lastModified()).put("attachmentCount", 0)
        .put("deliveryState", "LOCAL_PENDING").put("serverSubmissionId", JSONObject.NULL).put("errorCode", "LOCAL_RECORD_UNREADABLE")
    } }
    ?.sortedBy { it.optLong("createdAt") } ?: emptyList()
  @Synchronized fun assignAccount(context: Context, id: String, accountId: String) {
    require(activeAccount(context) == accountId) { "Return to the selected account" }
    val value = readOrder(context, id)
    require(value.isNull("accountId") || value.optString("accountId") == accountId) { "This order belongs to another account" }
    value.put("accountId", accountId); write(file(context, id), value); runCatching { OrderShareWorker.schedule(context, id) }
  }
  @Synchronized fun acknowledge(context: Context, id: String, serverId: String) {
    require(serverId.matches(Regex("^[A-Za-z0-9_-]{1,200}$")))
    val value = readOrder(context, id)
    if (value.optString("deliveryState") == "SERVER_ACCEPTED") {
      require(value.optString("serverSubmissionId") == serverId); return
    }
    value.put("deliveryState", "SERVER_ACCEPTED").put("serverSubmissionId", serverId).put("text", "")
    write(file(context, id), value)
  }
  @Synchronized fun discard(context: Context, id: String) { AtomicFile(file(context, id)).delete() }
  /** Never preserve sender extras, ClipData or raw content on the normalized intent. */
  @JvmStatic fun receive(context: Context, incoming: Intent): Intent {
    if (incoming.action != Intent.ACTION_SEND) return incoming
    val shared = try { incoming.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() } catch (_: Exception) { null }
    val code = when {
      incoming.type !in listOf("text/plain", "text/html") -> "UNSUPPORTED_INPUT"
      shared.isNullOrBlank() -> "EMPTY_INPUT"
      shared.length > MAX_TEXT || shared.toByteArray().size > 60000 -> "INPUT_TOO_LARGE"
      else -> null
    }
    return try {
      val saved = enqueue(context, if (code == null) shared!! else "", "TEXT", "ANDROID_SHARE", code)
      android.widget.Toast.makeText(context, if (code == null) "Order saved for later" else "Shared input needs attention", android.widget.Toast.LENGTH_SHORT).show()
      Intent(Intent.ACTION_VIEW, Uri.Builder().scheme("packproof-v2").authority("intake").appendQueryParameter("localId", saved.getString("id")).build())
    } catch (_: Exception) {
      android.widget.Toast.makeText(context, "Could not save the shared order. Try again.", android.widget.Toast.LENGTH_LONG).show()
      // This locator carries no order data and does not pretend persistence succeeded.
      Intent(Intent.ACTION_VIEW, Uri.parse("packproof-v2://intake?error=LOCAL_SAVE_FAILED"))
    }
  }
}
