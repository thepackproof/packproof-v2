package com.packproof.ordershare

import android.content.Context
import androidx.work.*
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/** Metadata-only delivery. Force-stop may defer execution; the host always retries on resume. */
class OrderShareWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
  override fun doWork(): Result {
    val id = inputData.getString("localId") ?: return Result.failure()
    val order = try { OrderShareStore.readOrder(applicationContext, id) } catch (_: Exception) { return Result.success() }
    if (order.optString("deliveryState") == "SERVER_ACCEPTED" || !order.isNull("errorCode")) return Result.success()
    val session = OrderShareSession.read(applicationContext) ?: return Result.success()
    val account = order.optString("accountId")
    if (account.isBlank() || account != OrderShareStore.activeAccount(applicationContext) || account != session.optString("accountId")) return Result.success()
    if (runCatching { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(session.getString("expiresAt"))!!.time <= System.currentTimeMillis() }.getOrDefault(true)) return Result.success()
    val body = JSONObject().put("schemaVersion", 1).put("clientSubmissionId", order.getString("clientSubmissionId"))
      .put("surface", order.getString("surface")).put("requestedAction", "QUEUE")
      .put("payload", JSONObject().put("kind", order.getString("payloadKind")).put("text", order.getString("text")))
    val bytes = body.toString().toByteArray(Charsets.UTF_8)
    if (bytes.size > 65536) return Result.failure()
    var connection: HttpURLConnection? = null
    return try {
      if (account != OrderShareStore.activeAccount(applicationContext)) return Result.success()
      connection = URL(session.getString("apiBaseURL").trimEnd('/') + "/me/intake/submissions").openConnection() as HttpURLConnection
      connection.instanceFollowRedirects = false; connection.connectTimeout = 10000; connection.readTimeout = 15000
      connection.requestMethod = "POST"; connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Authorization", "Bearer " + session.getString("token"))
      connection.outputStream.use { it.write(bytes) }
      when (connection.responseCode) {
        200, 201, 202 -> {
          val response = connection.inputStream.use { input ->
            val buffer = ByteArray(65537); var total = 0
            while (total < buffer.size) { val count = input.read(buffer, total, buffer.size - total); if (count < 0) break; total += count }
            require(total <= 65536); JSONObject(String(buffer, 0, total, Charsets.UTF_8))
          }
          require(response.getString("clientSubmissionId") == order.getString("clientSubmissionId"))
          require(response.getString("state") in listOf("RECEIVED", "RESOLVING", "READY", "NEEDS_CONNECTION", "NEEDS_SELECTION", "INVALID", "RETRYABLE_FAILED", "DISMISSED"))
          OrderShareStore.acknowledge(applicationContext, id, response.getString("submissionId")); Result.success()
        }
        408, 429 -> if (runAttemptCount < 8) Result.retry() else Result.failure()
        in 500..599 -> if (runAttemptCount < 8) Result.retry() else Result.failure()
        else -> Result.success() // Invalid/expired/disabled inputs stay local for foreground recovery.
      }
    } catch (_: Exception) { if (runAttemptCount < 8) Result.retry() else Result.failure() }
    finally { connection?.disconnect() }
  }
  companion object {
    fun schedule(context: Context, id: String) {
      val request = OneTimeWorkRequestBuilder<OrderShareWorker>().setInputData(workDataOf("localId" to id))
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS).build()
      WorkManager.getInstance(context).enqueueUniqueWork("packproof-intake-$id", ExistingWorkPolicy.KEEP, request)
    }
  }
}
