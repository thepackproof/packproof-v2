package com.packproof.ordershare

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class OrderShareModule : Module() {
  private fun context() = appContext.reactContext ?: throw IllegalStateException("Open PackProof to continue")
  private fun bridge(value: JSONObject): Map<String, Any?> = value.keys().asSequence().associateWith { key ->
    when (val item = value.get(key)) { JSONObject.NULL -> null; is org.json.JSONArray -> emptyList<String>(); else -> item }
  }
  override fun definition() = ModuleDefinition {
    Name("PackProofOrderShare")
    AsyncFunction("listPending") { OrderShareStore.listPending(context()).map { value -> bridge(JSONObject(value.toString()).apply { remove("text"); remove("payloadHash") }) } }
    AsyncFunction("readOrder") { id: String -> bridge(OrderShareStore.readOrder(context(), id)) }
    AsyncFunction("assignAccount") { id: String, accountId: String -> OrderShareStore.assignAccount(context(), id, accountId) }
    AsyncFunction("acknowledge") { id: String, serverId: String -> OrderShareStore.acknowledge(context(), id, serverId) }
    AsyncFunction("discard") { id: String -> OrderShareStore.discard(context(), id) }
    AsyncFunction("setActiveAccount") { accountId: String? -> OrderShareStore.setActiveAccount(context(), accountId) }
    AsyncFunction("enqueue") { text: String, kind: String, surface: String -> bridge(OrderShareStore.enqueue(context(), text, kind, surface)) }
    AsyncFunction("setIntakeSession") { value: Map<String, Any> ->
      OrderShareSession.save(context(), JSONObject(value))
      OrderShareStore.listPending(context()).filter { it.optString("accountId") == value["accountId"] && it.optString("deliveryState") == "LOCAL_PENDING" }.forEach { OrderShareWorker.schedule(context(), it.getString("id")) }
    }
    AsyncFunction("clearIntakeSession") { OrderShareSession.clear(context()) }
  }
}
