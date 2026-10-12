package com.packproof.unifiedcamera

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Serial optional work with atomic admission/finalization; never blocks the recorder on disk I/O. */
internal class ResearchTaskQueue(private val executor: ExecutorService = Executors.newSingleThreadExecutor()) {
  private var closed = false
  @Volatile private var samplingAllowed = true

  @Synchronized
  fun submit(optionalSample: Boolean = false, settled: () -> Unit = {}, action: () -> Unit): Boolean {
    if (closed || (optionalSample && !samplingAllowed)) return false
    executor.execute {
      try {
        // Policy can change while this task waits behind earlier native work.
        if (!optionalSample || samplingAllowed) action()
      } finally { settled() }
    }
    return true
  }

  @Synchronized
  fun disableSampling() { samplingAllowed = false }

  @Synchronized
  fun finish(action: () -> Unit): Boolean {
    if (closed) return false
    closed = true
    // Holding the admission lock makes this the final queued task. A late producer is refused.
    executor.execute { try { action() } finally { executor.shutdown() } }
    return true
  }
}
