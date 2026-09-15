package com.packproof.unifiedcamera

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

/** Keeps the existing upload owner alive during a user-requested transfer. Journals remain the retry authority. */
class UploadNotificationService : Service() {
  private val operations = mutableSetOf<String>()
  private val handler = Handler(Looper.getMainLooper())
  private var wakeLock: PowerManager.WakeLock? = null
  private val expire = Runnable { stopSelf() }

  override fun onCreate() {
    super.onCreate()
    instance = this
    channels(this)
    val notification = builder(this, UPLOAD_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setContentTitle("Uploading your recording")
      .setContentText("You can keep packing. Your original is saved on this device.")
      .setOngoing(true).setOnlyAlertOnce(true).setProgress(0, 0, true)
      .setContentIntent(openApp(this, null)).build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(FOREGROUND_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(FOREGROUND_ID, notification)
    wakeLock = (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PackProof:Upload").also {
      it.setReferenceCounted(false)
      it.acquire(LEASE_MS)
    }
    handler.postDelayed(expire, LEASE_MS)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    intent?.getStringExtra("operationId")?.let { operations.add(it) }
    // Never resurrect an upload without the authenticated JS owner and its journal.
    return START_NOT_STICKY
  }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }
  override fun onDestroy() {
    handler.removeCallbacks(expire)
    wakeLock?.let { if (it.isHeld) it.release() }
    if (instance === this) instance = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  companion object {
    private const val UPLOAD_CHANNEL = "packproof_uploads"
    private const val COMPLETE_CHANNEL = "packproof_upload_complete"
    private const val FOREGROUND_ID = 7311
    private const val LEASE_MS = 15 * 60 * 1000L
    private var instance: UploadNotificationService? = null

    fun begin(context: Context, operationId: String) {
      require(operationId.length in 1..200)
      val running = instance
      if (running != null) { running.operations.add(operationId); return }
      val intent = Intent(context, UploadNotificationService::class.java).putExtra("operationId", operationId)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }
    fun finish(operationId: String) {
      instance?.let { service ->
        service.operations.remove(operationId)
        if (service.operations.isEmpty()) service.stopSelf()
      }
    }
    fun complete(context: Context, operationId: String, proofId: String): Boolean {
      require(operationId.length in 1..200 && proofId.matches(Regex("[A-Za-z0-9_-]{1,100}")))
      val options = context.getSharedPreferences("packproof_notification_options", Context.MODE_PRIVATE)
      if (!options.getBoolean("enabled", true) || !options.getBoolean("uploads", true) || options.getStringSet("muted", emptySet())!!.contains(proofId)) return false
      channels(context)
      val manager = context.getSystemService(NotificationManager::class.java)
      if (!manager.areNotificationsEnabled() || (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(COMPLETE_CHANNEL)?.importance == NotificationManager.IMPORTANCE_NONE)) return false
      val sent = context.getSharedPreferences("packproof_upload_notifications", Context.MODE_PRIVATE)
      if (sent.getBoolean(operationId, false)) return true
      val notification = builder(context, COMPLETE_CHANNEL)
        .setSmallIcon(android.R.drawable.stat_sys_upload_done)
        .setContentTitle("Proof saved")
        .setContentText("Your video is uploaded and your Proof is ready.")
        .setVisibility(Notification.VISIBILITY_PRIVATE).setAutoCancel(true).setOnlyAlertOnce(true)
        .setContentIntent(openApp(context, proofId)).build()
      // A stable tag replaces a prior notification if delivery was interrupted before the receipt write.
      manager.notify(operationId, 1, notification)
      sent.edit().putBoolean(operationId, true).commit()
      return true
    }
    private fun channels(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(NotificationChannel(UPLOAD_CHANNEL, "Video uploads", NotificationManager.IMPORTANCE_LOW))
      manager.createNotificationChannel(NotificationChannel(COMPLETE_CHANNEL, "Completed Proofs", NotificationManager.IMPORTANCE_DEFAULT))
    }
    @Suppress("DEPRECATION")
    private fun builder(context: Context, channel: String): Notification.Builder =
      if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, channel) else Notification.Builder(context)

    private fun openApp(context: Context, proofId: String?): PendingIntent {
      val intent = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
      intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      if (proofId != null) {
        intent.action = Intent.ACTION_VIEW
        intent.data = Uri.parse("packproof://proof/$proofId")
      }
      return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
  }
}
