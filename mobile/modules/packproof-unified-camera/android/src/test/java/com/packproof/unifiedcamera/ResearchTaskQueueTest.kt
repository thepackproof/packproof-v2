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
}
