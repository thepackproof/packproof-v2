// A replaceable reference adapter: no database access or Proof state mutation.
// Node 22+. Keep the key in the merchant server's secret store.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export class PackProofAdapter {
  constructor({ baseUrl, apiKey, fetcher = fetch }) {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname))
      throw new Error("Use an HTTPS PackProof API origin");
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }
  async request(path, { method = "GET", body, key } = {}) {
    const response = await this.fetcher(`${this.baseUrl}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok) {
      const e = new Error(data.error?.message ?? "PackProof request failed");
      e.status = response.status;
      e.requestId = response.headers.get("X-Request-Id");
      throw e;
    }
    return data;
  }
  createOrder(order) {
    if (!order.id || !order.itemTitle)
      throw new Error("An external order ID and item title are required");
    return this.request("/proofs", {
      method: "POST",
      key: `order-${createHash("sha256").update(String(order.id)).digest("hex")}`,
      body: {
        externalId: String(order.id),
        transaction: {
          itemTitle: order.itemTitle,
          itemDescription: order.itemDescription ?? null,
          quantity: order.quantity ?? 1,
          transactionValue: order.value ?? null,
          currency: order.currency ?? null,
          shipping: order.shipping ?? {},
          metadata: { source: "reference-merchant-adapter" },
        },
      },
    });
  }
  getProof(proofId) {
    return this.request(`/proofs/${encodeURIComponent(proofId)}`);
  }
}

// Pass the EXACT raw UTF-8 request body before JSON parsing. Check persistent
// event-ID deduplication in the merchant application before applying a side effect.
export function verifyEvent(secret, header, rawBody, nowSeconds = Math.floor(Date.now() / 1000)) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header ?? "");
  if (!match || Math.abs(nowSeconds - Number(match[1])) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${match[1]}.${rawBody}`).digest();
  const received = Buffer.from(match[2], "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PACKPROOF_API_KEY || !process.env.PACKPROOF_API_URL || !process.argv[2])
    throw new Error(
      "Set PACKPROOF_API_URL and PACKPROOF_API_KEY; pass a confirmed order JSON file",
    );
  const adapter = new PackProofAdapter({
    baseUrl: process.env.PACKPROOF_API_URL,
    apiKey: process.env.PACKPROOF_API_KEY,
  });
  const result = await adapter.createOrder(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log(
    JSON.stringify(
      {
        proofId: result.proof.proofId,
        status: result.proof.status,
        capture: result.links.capture,
        viewer: result.links.viewer,
      },
      null,
      2,
    ),
  );
}
