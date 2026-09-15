package com.packproof.ordershare

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Only a revocable intake-only credential is stored, encrypted by Android Keystore. */
object OrderShareSession {
  private const val ALIAS = "packproof.order-intake.session.v1"
  private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "order-intake-session"))
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  fun save(context: Context, value: JSONObject) {
    require(value.optString("accountId") == OrderShareStore.activeAccount(context)) { "Account changed" }
    val url = android.net.Uri.parse(value.getString("apiBaseURL"))
    require(url.scheme == "https" && url.userInfo == null && !url.host.isNullOrBlank())
    synchronized(this) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val encoded = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("cipher", Base64.encodeToString(cipher.doFinal(value.toString().toByteArray()), Base64.NO_WRAP))
    val target = file(context); val stream = target.startWrite()
    try { stream.write(encoded.toString().toByteArray()); target.finishWrite(stream) }
    catch (error: Exception) { target.failWrite(stream); throw error }
    }
  }
  @Synchronized fun read(context: Context): JSONObject? = try {
    val encoded = JSONObject(file(context).openRead().use { it.readBytes().toString(Charsets.UTF_8) })
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(encoded.getString("iv"), Base64.NO_WRAP))) }
    JSONObject(cipher.doFinal(Base64.decode(encoded.getString("cipher"), Base64.NO_WRAP)).toString(Charsets.UTF_8))
  } catch (_: Exception) { null }
  @Synchronized fun clear(context: Context) { file(context).delete() }
}
