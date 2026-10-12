package com.packproof.unifiedcamera

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.AbstractExecutorService
import java.util.concurrent.TimeUnit

class ResearchTaskQueueTest {
  private class ControlledExecutor : AbstractExecutorService() {
    private val tasks = ArrayDeque<Runnable>()
    private var stopped = false
    override fun execute(task: Runnable) { check(!stopped); tasks.addLast(task) }
    fun drain() { while (tasks.isNotEmpty()) tasks.removeFirst().run() }
    override fun shutdown() { stopped = true }
    override fun shutdownNow(): MutableList<Runnable> { stopped = true; return tasks.toMutableList().also { tasks.clear() } }
    override fun isShutdown() = stopped
    override fun isTerminated() = stopped && tasks.isEmpty()
    override fun awaitTermination(timeout: Long, unit: TimeUnit) = isTerminated()
  }

  @Test fun finalMarkerFollowsAdmittedWorkAndRefusesLateCopiedFrame() {
    val executor = ControlledExecutor(); val queue = ResearchTaskQueue(executor)
    val writes = mutableListOf<String>(); var settled = 0
    assertTrue(queue.submit(optionalSample = true, settled = { settled++ }) { writes.add("frame") })
    assertTrue(queue.submit { writes.add("control-event") })
    assertTrue(queue.finish { writes.add("completion-marker") })
    // A camera callback can finish copying its luma after finish has already closed admission.
    assertFalse(queue.submit(optionalSample = true) { writes.add("late-frame") })
    assertFalse(queue.submit { writes.add("late-event") })
    assertFalse(queue.finish { writes.add("second-marker") })
    executor.drain()
    assertEquals(listOf("frame", "control-event", "completion-marker"), writes)
    assertEquals(1, settled); assertTrue(executor.isShutdown())
    assertFalse(queue.submit(optionalSample = true) { writes.add("after-shutdown") })
  }

  @Test fun policyDisableSkipsPendingFramesButReleasesBackpressureAndPersistsFinalMetadata() {
    val executor = ControlledExecutor(); val queue = ResearchTaskQueue(executor)
    val writes = mutableListOf<String>(); var settled = 0
    assertTrue(queue.submit(optionalSample = true, settled = { settled++ }) { writes.add("frame") })
    queue.disableSampling()
    assertFalse(queue.submit(optionalSample = true) { writes.add("new-frame") })
    assertTrue(queue.submit { writes.add("policy-event") })
    assertTrue(queue.finish { writes.add("disabled-metadata-marker") })
    executor.drain()
    assertEquals(listOf("policy-event", "disabled-metadata-marker"), writes)
    assertEquals(1, settled)
  }

  @Test fun allocationFailureCannotEscapeWorkerAndLaterSamplesAreSkipped() {
    val executor = ControlledExecutor(); val failures = mutableListOf<String>()
    val queue = ResearchTaskQueue(executor) { failures.add(it) }; var settled = 0; var samples = 0; var finalized = false
    queue.submit(optionalSample = true, settled = { settled++ }) { throw OutOfMemoryError("synthetic optional allocation failure") }
    queue.submit(optionalSample = true, settled = { settled++ }) { samples++ }
    queue.finish { finalized = true }
    executor.drain()
    assertEquals(listOf("MEMORY_PRESSURE"), failures)
    assertEquals(2, settled); assertEquals(0, samples); assertTrue(finalized); assertTrue(executor.isShutdown())
  }

  @Test fun failedOptionalStorageStillSettlesAndFinalizationShutsDown() {
    val executor = ControlledExecutor(); val failures = mutableListOf<String>()
    val queue = ResearchTaskQueue(executor) { failures.add(it) }; var settled = false
    queue.submit(settled = { settled = true }) { throw IllegalStateException("synthetic storage failure") }
    queue.finish { throw OutOfMemoryError("synthetic final metadata failure") }
    executor.drain()
    assertTrue(settled); assertTrue(executor.isShutdown())
    assertEquals(listOf("OPTIONAL_STORAGE_OR_PROCESSING_FAILURE", "MEMORY_PRESSURE"), failures)
  }

  @Test fun rejectedExecutorAdmissionReturnsUnavailableWithoutLeakingFinalizer() {
    val executor = ControlledExecutor(); executor.shutdown()
    val failures = mutableListOf<String>(); val queue = ResearchTaskQueue(executor) { failures.add(it) }
    assertFalse(queue.submit { fail("No work may run") })
    assertFalse(queue.finish { fail("No finalizer may run") })
    assertTrue(executor.isShutdown()); assertEquals(listOf("OPTIONAL_QUEUE_UNAVAILABLE", "OPTIONAL_QUEUE_UNAVAILABLE"), failures)
  }
}
