import assert from "node:assert/strict";
import test from "node:test";
import { clearSharedLinkCache, isShareTransportFailure, loadSharedLink, removeSharedLink, reusableSharedLink, saveSharedLink } from "../src/copy/share-cache.ts";
import type { ShareCacheStorage } from "../src/copy/share-cache.ts";
import type { AccessLinkView } from "../src/v2-api.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); },
    getAllKeys: async () => [...values.keys()],
  } satisfies ShareCacheStorage & { values: Map<string, string> };
}
const api = "https://api.packproof.test";
function grant(proofId = "proof1"): AccessLinkView {
  return { accessLinkId: "pal_1", proofId, scope: "EVIDENCE_VIEW", token: "approved-token", url: "https://thepackproof.test/p/approved-token", createdAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), revokedAt: null };
}

test("reopening a Proof restores the exact approved URL within its account and API", async () => {
  const cache = storage(), link = grant();
  await saveSharedLink(cache, api, "seller", "proof1", link);
  assert.deepEqual(await loadSharedLink(cache, `${api}/`, "seller", "proof1"), link);
  assert.equal(await loadSharedLink(cache, api, "buyer", "proof1"), null);
  assert.equal(await loadSharedLink(cache, "https://other-api.test", "seller", "proof1"), null);
  assert.equal(await loadSharedLink(cache, api, "seller", "proof2"), null);
});

test("expired, revoked, mismatched, and corrupt grants cannot be copied offline", async () => {
  const cache = storage(), link = grant();
  await saveSharedLink(cache, api, "seller", "proof1", link);
  assert.equal(await loadSharedLink(cache, api, "seller", "proof1", Date.parse(link.expiresAt!)), null);
  assert.equal(cache.values.size, 0);
  assert.equal(reusableSharedLink({ ...link, revokedAt: new Date().toISOString() }, "proof1"), false);
  assert.equal(reusableSharedLink(link, "another-proof"), false);
  assert.equal(reusableSharedLink({ ...link, scope: "SUMMARY" }, "proof1"), false);
  assert.equal(reusableSharedLink({ ...link, expiresAt: "invalid" }, "proof1"), false);
  assert.equal(reusableSharedLink({ ...link, url: "https://thepackproof.test/p/different-token" }, "proof1"), false);
  assert.equal(reusableSharedLink({ ...link, url: "javascript:alert(1)" }, "proof1"), false);
  await saveSharedLink(cache, api, "seller", "proof1", link);
  cache.values.set([...cache.values.keys()][0], "{broken");
  assert.equal(await loadSharedLink(cache, api, "seller", "proof1"), null);
});

test("sign-out clears all links for the departed account without crossing account boundaries", async () => {
  const cache = storage();
  await saveSharedLink(cache, api, "seller", "proof1", grant());
  await saveSharedLink(cache, api, "seller", "proof2", grant("proof2"));
  await saveSharedLink(cache, api, "seller:another", "proof1", grant());
  await saveSharedLink(cache, "https://other-api.test", "seller", "proof1", grant());
  cache.values.set("packproof.capture-recovery", "preserve recoverable media");
  await clearSharedLinkCache(cache, api, "seller");
  assert.equal(await loadSharedLink(cache, api, "seller", "proof1"), null);
  assert.equal(await loadSharedLink(cache, api, "seller", "proof2"), null);
  assert.ok(await loadSharedLink(cache, api, "seller:another", "proof1"));
  assert.ok(await loadSharedLink(cache, "https://other-api.test", "seller", "proof1"));
  assert.equal(cache.values.get("packproof.capture-recovery"), "preserve recoverable media");
});

test("revocation removes the cached token and cache never retains evidence projection extras", async () => {
  const cache = storage();
  await saveSharedLink(cache, api, "seller", "proof1", { ...grant(), preview: { evidence: ["private-evidence"] } } as AccessLinkView);
  assert.ok(![...cache.values.values()][0].includes("private-evidence"));
  await removeSharedLink(cache, api, "seller", "proof1");
  assert.equal(await loadSharedLink(cache, api, "seller", "proof1"), null);
});

test("only transport failures permit cached-link fallback, never access denial", () => {
  assert.equal(isShareTransportFailure(new TypeError("Network request failed")), true);
  assert.equal(isShareTransportFailure({ name: "RequestTimeoutError", code: "REQUEST_TIMEOUT", status: 408 }), true);
  assert.equal(isShareTransportFailure({ code: "ACCESS_LINK_REVOKED", status: 410 }), false);
  assert.equal(isShareTransportFailure({ code: "ACCESS_LINK_EXPIRED", status: 410 }), false);
  assert.equal(isShareTransportFailure({ code: "FORBIDDEN", status: 403 }), false);
  assert.equal(isShareTransportFailure({ code: "UNAUTHENTICATED", status: 401 }), false);
  assert.equal(isShareTransportFailure({ code: "NOT_FOUND", status: 404 }), false);
  assert.equal(isShareTransportFailure(new TypeError("Cannot read properties of undefined")), false);
  assert.equal(isShareTransportFailure({ status: 500, message: "Network request failed" }), false);
});
