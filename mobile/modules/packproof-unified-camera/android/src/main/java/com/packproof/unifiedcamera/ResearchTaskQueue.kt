package com.packproof.unifiedcamera

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Serial optional work with atomic admission/finalization and an isolated failure boundary. */
internal class ResearchTaskQueue(
  private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
  private val onFailure: (String) -> Unit = {}
) {
  private var closed = false
  @Volatile private var samplingAllowed = true

  @Synchronized
  fun submit(optionalSample: Boolean = false, settled: () -> Unit = {}, action: () -> Unit): Boolean {
    if (closed || (optionalSample && !samplingAllowed)) return false
    return enqueue {
      try {
        // Policy can change while this task waits behind earlier native work.
        if (!optionalSample || samplingAllowed) safely(action)
      } finally { settled() }
    }
  }

  @Synchronized
  fun disableSampling() { samplingAllowed = false }

  @Synchronized
  fun finish(action: () -> Unit): Boolean {
    if (closed) return false
    closed = true
    // Holding the admission lock makes this the final queued task. A late producer is refused.
    val admitted = enqueue { try { safely(action) } finally { executor.shutdown() } }
    if (!admitted) executor.shutdown()
    return admitted
  }

  private fun fail(reason: String) {
    samplingAllowed = false
    // Failure reporting must not become another failure in the ordinary recorder.
    try { onFailure(reason) } catch (_: Exception) {} catch (_: OutOfMemoryError) {}
  }
  private fun safely(action: () -> Unit) {
    try { action() }
    catch (_: OutOfMemoryError) { fail("MEMORY_PRESSURE") }
    catch (_: Exception) { fail("OPTIONAL_STORAGE_OR_PROCESSING_FAILURE") }
  }
  private fun enqueue(action: () -> Unit): Boolean {
    return try { executor.execute(action); true }
    catch (_: OutOfMemoryError) { fail("MEMORY_PRESSURE"); false }
    catch (_: Exception) { fail("OPTIONAL_QUEUE_UNAVAILABLE"); false }
  }
}
