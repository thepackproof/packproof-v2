package com.packproof.unifiedcamera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import androidx.annotation.OptIn
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** One CameraX binding owns the preview, encoder, and asynchronous barcode analysis. */
@SuppressLint("ViewConstructor")
class UnifiedCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true
  private val onReady by EventDispatcher()
  private val onBarcodeDetected by EventDispatcher()
  private val onRecordingStarted by EventDispatcher()
  private val onCaptureError by EventDispatcher()
  private val mainExecutor = ContextCompat.getMainExecutor(context)
  private val mainHandler = Handler(Looper.getMainLooper())
  private val analyzerExecutor = Executors.newSingleThreadExecutor()
  private val analysisInFlight = AtomicInteger(0)
  private val scanner = BarcodeScanning.getClient(
    BarcodeScannerOptions.Builder().setBarcodeFormats(
      Barcode.FORMAT_CODE_128, Barcode.FORMAT_CODE_39, Barcode.FORMAT_CODE_93,
      Barcode.FORMAT_CODABAR, Barcode.FORMAT_ITF, Barcode.FORMAT_QR_CODE,
      Barcode.FORMAT_PDF417, Barcode.FORMAT_AZTEC, Barcode.FORMAT_DATA_MATRIX,
      Barcode.FORMAT_EAN_13, Barcode.FORMAT_EAN_8, Barcode.FORMAT_UPC_A, Barcode.FORMAT_UPC_E,
    ).build(),
  )
  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
  }
  private var desiredActive = false
  private var torchEnabled = false
  @Volatile private var destroyed = false
  private var scannerClosed = false
  private var binding = false
  private var ready = false
  @Volatile private var generation = 0
  private var provider: ProcessCameraProvider? = null
  private var camera: Camera? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var analysis: ImageAnalysis? = null
  private var boundUseCases = emptyList<UseCase>()
  private var lifecycleOwner: LifecycleOwner? = null
  private var recording: Recording? = null
  private var session: CaptureSession? = null
  @Volatile private var epoch: RecordingEpoch? = null
  private var releaseAfterFinalize = false
  private var lastAnalysisNanos = 0L
  private var lastScannerErrorNanos = 0L
  private val recentCodes = LinkedHashMap<String, Long>()

  private class CaptureSession(val file: File, val promise: Promise) {
    var interrupted = false
    var stopping = false
    var started = false
  }

  private data class RecordingEpoch(val generation: Int, val startedNanos: Long, val startedUnixMs: Long)

  private val streamObserver = Observer<PreviewView.StreamState> { state ->
    if (state == PreviewView.StreamState.STREAMING && camera != null && canUseCamera() && !ready) {
      ready = true
      onReady(emptyMap<String, Any>())
    }
  }

  private val lifecycleObserver = object : DefaultLifecycleObserver {
    override fun onResume(owner: LifecycleOwner) { ensureCamera() }
    override fun onPause(owner: LifecycleOwner) { interruptAndRelease() }
    override fun onDestroy(owner: LifecycleOwner) { destroy() }
  }

  init { addView(previewView) }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    ensureCamera()
  }

  override fun onDetachedFromWindow() {
    interruptAndRelease()
    super.onDetachedFromWindow()
  }

  // ExpoView's child is native rather than managed by Yoga.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    previewView.layout(0, 0, right - left, bottom - top)
  }

  fun setCaptureActive(active: Boolean) {
    desiredActive = active
    if (!active) interruptAndRelease()
  }

  fun setTorchEnabled(enabled: Boolean) {
    torchEnabled = enabled
    applyTorch()
  }

  private fun hasPermission(permission: String) =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun canUseCamera() = !destroyed && desiredActive && isAttachedToWindow &&
    lifecycleOwner?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true

  fun ensureCamera() {
    if (destroyed || !desiredActive || !isAttachedToWindow) return
    val owner = appContext.currentActivity as? LifecycleOwner ?: run {
      reportError("CAMERA_ACTIVITY_UNAVAILABLE", "The camera needs an active Android screen.")
      return
    }
    if (lifecycleOwner !== owner) {
      lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver)
      lifecycleOwner = owner
      owner.lifecycle.addObserver(lifecycleObserver)
    }
    if (!canUseCamera() || binding || camera != null || session != null) return
    if (!hasPermission(Manifest.permission.CAMERA)) {
      reportError("CAMERA_PERMISSION_REQUIRED", "Allow camera access before starting the camera test.")
      return
    }
    binding = true
    val expectedGeneration = generation
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      // A superseded provider future must not clear a newer binding's in-progress flag.
      if (expectedGeneration != generation) return@addListener
      if (!canUseCamera()) {
        binding = false
        return@addListener
      }
      try {
        val cameraProvider = future.get()
        val rotation = display?.rotation ?: Surface.ROTATION_0
        val preview = Preview.Builder().setTargetRotation(rotation).build().also {
          it.setSurfaceProvider(previewView.surfaceProvider)
        }
        val recorder = Recorder.Builder().setQualitySelector(
          QualitySelector.from(Quality.HD, FallbackStrategy.lowerQualityOrHigherThan(Quality.HD)),
        ).build()
        val capture = VideoCapture.withOutput(recorder).also { it.targetRotation = rotation }
        val analyzer = ImageAnalysis.Builder()
          .setTargetRotation(rotation)
          .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
            ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER),
          ).build())
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build().also { useCase ->
            useCase.setAnalyzer(analyzerExecutor) { image -> analyzeImage(image, expectedGeneration) }
          }
        // No ImageCapture output, no second scanner, no rebind when a code is decoded.
        provider = cameraProvider
        boundUseCases = listOf(preview, capture, analyzer)
        analysis = analyzer
        videoCapture = capture
        camera = cameraProvider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, capture, analyzer)
        previewView.previewStreamState.observe(owner, streamObserver)
        applyTorch()
      } catch (_: Exception) {
        releaseBinding()
        reportError("CAMERA_COMBINATION_UNSUPPORTED", "This device could not start recording and barcode analysis together.")
      } finally {
        binding = false
      }
    }, mainExecutor)
  }

  private fun applyTorch() {
    val current = camera ?: return
    if (!current.cameraInfo.hasFlashUnit()) return
    val requested = torchEnabled && canUseCamera()
    try {
      val result = current.cameraControl.enableTorch(requested)
      result.addListener({
        try { result.get() } catch (_: Exception) {
          if (camera === current && canUseCamera()) {
            reportError("TORCH_UNAVAILABLE", "The light could not be changed. Recording can continue.")
          }
        }
      }, mainExecutor)
    } catch (_: Exception) {
      reportError("TORCH_UNAVAILABLE", "The light could not be changed. Recording can continue.")
    }
  }

  @SuppressLint("MissingPermission")
  fun startRecording(sessionId: String, audioEnabled: Boolean, promise: Promise) {
    if (session != null) {
      promise.reject("RECORDING_ALREADY_ACTIVE", "A camera test recording is already active.", null)
      return
    }
    if (!canUseCamera() || !ready || videoCapture == null || !hasPermission(Manifest.permission.CAMERA)) {
      promise.reject("CAMERA_NOT_READY", "Wait for the camera preview before recording.", null)
      return
    }
    if (audioEnabled && !hasPermission(Manifest.permission.RECORD_AUDIO)) {
      promise.reject("MICROPHONE_PERMISSION_REQUIRED", "Allow microphone access or record without sound.", null)
      return
    }
    if (!sessionId.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,95}"))) {
      promise.reject("INVALID_CAPTURE_SESSION", "The camera test session identifier is invalid.", null)
      return
    }
    try {
      val root = File(context.filesDir, "packproof-camera-spike")
      if (!root.exists() && !root.mkdirs()) throw IllegalStateException("Capture directory unavailable")
      val directory = File(root, sessionId)
      // The JS report may already exist here. Reserve only the video path atomically.
      if (!directory.exists() && !directory.mkdir()) throw IllegalStateException("Session directory unavailable")
      val output = File(directory, "video.mp4")
      if (!output.createNewFile()) {
        promise.reject("CAPTURE_SESSION_EXISTS", "Start a new camera test session to record another video.", null)
        return
      }
      val current = CaptureSession(output, promise)
      session = current
      epoch = null
      recentCodes.clear()
      releaseAfterFinalize = false
      val options = FileOutputOptions.Builder(output)
        .setDurationLimitMillis(10 * 60 * 1000L)
        .setFileSizeLimit(512 * 1024 * 1024L)
        .build()
      var pending = videoCapture!!.output.prepareRecording(context, options)
      if (audioEnabled) pending = pending.withAudioEnabled()
      recording = pending.start(mainExecutor) { event -> handleRecordEvent(current, event) }
      mainHandler.postDelayed({
        if (session === current && !current.started && !current.stopping) {
          current.interrupted = true
          reportError("RECORDING_START_TIMEOUT", "The video could not start. The camera test was stopped.")
          stopRecording()
        }
      }, 15_000L)
    } catch (_: Exception) {
      session = null
      epoch = null
      recording = null
      promise.reject("RECORDING_START_FAILED", "The camera could not start saving this video.", null)
    }
  }

  private fun handleRecordEvent(current: CaptureSession, event: VideoRecordEvent) {
    if (session !== current) return
    when (event) {
      is VideoRecordEvent.Start -> {
        current.started = true
        val started = RecordingEpoch(generation, SystemClock.elapsedRealtimeNanos(), System.currentTimeMillis())
        if (!current.stopping && canUseCamera()) {
          epoch = started
        }
        // A Stop/background request can race Start; report the native start for the saved record.
        if (!destroyed) onRecordingStarted(mapOf("startedAtUnixMs" to started.startedUnixMs.toDouble()))
      }
      is VideoRecordEvent.Finalize -> {
        epoch = null
        session = null
        recording = null
        val durationMs = event.recordingStats.recordedDurationNanos / 1_000_000L
        val byteSize = current.file.length()
        val recoverable = event.error == VideoRecordEvent.Finalize.ERROR_NONE ||
          event.error == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE ||
          event.error == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED ||
          event.error == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED
        if (recoverable && byteSize > 0 && durationMs > 0) {
          current.promise.resolve(mapOf(
            "uri" to Uri.fromFile(current.file).toString(),
            "durationMs" to durationMs.toDouble(),
            "byteSize" to byteSize.toDouble(),
            "interrupted" to (current.interrupted || event.error != VideoRecordEvent.Finalize.ERROR_NONE),
          ))
        } else {
          // Keep any bytes at the unique path for inspection; never claim failed bytes are evidence.
          current.promise.reject("RECORDING_FINALIZE_FAILED", "This camera test did not produce a completed video. Any local bytes were retained.", null)
        }
        if (releaseAfterFinalize || !canUseCamera()) {
          releaseAfterFinalize = false
          releaseBinding()
          if (!destroyed) ensureCamera()
        }
      }
    }
  }

  fun stopRecording() {
    val current = session ?: return
    if (current.stopping) return
    current.stopping = true
    epoch = null // Drop late analyzer callbacks as soon as stop is requested.
    recording?.stop()
  }

  @OptIn(ExperimentalGetImage::class)
  private fun analyzeImage(image: ImageProxy, expectedGeneration: Int) {
    val observedEpoch = epoch
    val sampledNanos = SystemClock.elapsedRealtimeNanos()
    if (destroyed || observedEpoch == null || observedEpoch.generation != expectedGeneration ||
      expectedGeneration != generation || sampledNanos - lastAnalysisNanos < 200_000_000L) {
      image.close()
      return
    }
    val mediaImage = image.image
    if (mediaImage == null) {
      image.close()
      return
    }
    lastAnalysisNanos = sampledNanos
    analysisInFlight.incrementAndGet()
    try {
      val input = InputImage.fromMediaImage(mediaImage, image.imageInfo.rotationDegrees)
      scanner.process(input)
        .addOnSuccessListener(mainExecutor) { codes ->
          // A stale ML task must not leak into another session, after Stop, or after backgrounding.
          if (destroyed || epoch !== observedEpoch || generation != expectedGeneration) return@addOnSuccessListener
          val now = SystemClock.elapsedRealtimeNanos()
          for (code in codes) {
            val raw = code.rawValue ?: continue
            if (raw.isEmpty() || raw.length > 512) continue
            val format = barcodeFormat(code.format)
            val key = "$format:$raw"
            val previous = recentCodes[key]
            if (previous != null && now - previous < 3_000_000_000L) continue
            if (recentCodes.size >= 128) recentCodes.remove(recentCodes.keys.first())
            recentCodes[key] = now
            val offsetMs = (sampledNanos - observedEpoch.startedNanos).coerceAtLeast(0L) / 1_000_000L
            onBarcodeDetected(mapOf(
              "rawValue" to raw,
              "format" to format,
              "detectedAtMs" to offsetMs.toDouble(),
              "detectedAtUnixMs" to (observedEpoch.startedUnixMs + offsetMs).toDouble(),
              "latencyMs" to ((now - sampledNanos) / 1_000_000L).toDouble(),
            ))
          }
        }
        .addOnFailureListener(mainExecutor) {
          val now = SystemClock.elapsedRealtimeNanos()
          if (epoch === observedEpoch && !destroyed && now - lastScannerErrorNanos > 10_000_000_000L) {
            lastScannerErrorNanos = now
            reportError("BARCODE_ANALYSIS_FAILED", "Barcode reading is unavailable for this frame. Video recording continues.")
          }
        }
        .addOnCompleteListener(mainExecutor) {
          image.close()
          analysisInFlight.decrementAndGet()
          closeScannerIfDestroyed()
        }
    } catch (_: Exception) {
      image.close()
      analysisInFlight.decrementAndGet()
      mainExecutor.execute {
        if (epoch === observedEpoch && !destroyed) {
          reportError("BARCODE_ANALYSIS_FAILED", "Barcode reading is unavailable for this frame. Video recording continues.")
        }
        closeScannerIfDestroyed()
      }
    }
  }

  private fun interruptAndRelease() {
    ready = false
    epoch = null
    generation += 1
    if (session != null) {
      session?.interrupted = true
      releaseAfterFinalize = true
      analysis?.clearAnalyzer()
      try { camera?.cameraControl?.enableTorch(false) } catch (_: Exception) { /* Best effort. */ }
      stopRecording()
      // The encoder keeps its binding until Finalize; lifecycle loss may still stop its source.
    } else {
      releaseBinding()
    }
  }

  private fun releaseBinding() {
    generation += 1
    binding = false
    ready = false
    epoch = null
    previewView.previewStreamState.removeObserver(streamObserver)
    analysis?.clearAnalyzer()
    val owned = boundUseCases.toTypedArray()
    boundUseCases = emptyList()
    analysis = null
    videoCapture = null
    camera = null
    if (owned.isNotEmpty()) {
      try { provider?.unbind(*owned) } catch (_: Exception) { /* Already released by Android. */ }
    }
  }

  fun destroy() {
    if (destroyed) return
    destroyed = true
    desiredActive = false
    lifecycleOwner?.lifecycle?.removeObserver(lifecycleObserver)
    interruptAndRelease()
    analyzerExecutor.shutdown()
    closeScannerIfDestroyed()
  }

  private fun closeScannerIfDestroyed() {
    if (destroyed && analysisInFlight.get() == 0 && !scannerClosed) {
      scannerClosed = true
      scanner.close()
    }
  }

  private fun reportError(code: String, message: String) {
    if (!destroyed) onCaptureError(mapOf("code" to code, "message" to message))
  }

  private fun barcodeFormat(format: Int): String = when (format) {
    Barcode.FORMAT_CODE_128 -> "code128"
    Barcode.FORMAT_CODE_39 -> "code39"
    Barcode.FORMAT_CODE_93 -> "code93"
    Barcode.FORMAT_CODABAR -> "codabar"
    Barcode.FORMAT_ITF -> "itf"
    Barcode.FORMAT_QR_CODE -> "qr"
    Barcode.FORMAT_PDF417 -> "pdf417"
    Barcode.FORMAT_AZTEC -> "aztec"
    Barcode.FORMAT_DATA_MATRIX -> "datamatrix"
    Barcode.FORMAT_EAN_13 -> "ean13"
    Barcode.FORMAT_EAN_8 -> "ean8"
    Barcode.FORMAT_UPC_A -> "upc_a"
    Barcode.FORMAT_UPC_E -> "upc_e"
    else -> "unknown"
  }
}
