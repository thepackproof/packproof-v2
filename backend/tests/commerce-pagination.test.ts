import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { auth, createHarness, login, type TestHarness } from "./helpers.js";
import { createDefaultIntegrationRegistry } from "../src/integrations/registry.js";
import { systemClock } from "../src/clock.js";
import { MAX_COMMERCE_SYNC_PAGES } from "../src/domain/commerce-fulfillment-sync.js";
import { providerTemporarilyUnavailable } from "../src/domain/integration-errors.js";

describe("bounded commerce cursor progress", () => {
  let h: TestHarness;
  afterEach(async () => { await h?.close(); });

  it("resumes from completed pages after the batch limit and a provider failure", async () => {
    const registry = createDefaultIntegrationRegistry(systemClock);
    const adapter = registry.getCommerce("demo-storefront");
    const original = adapter.listFulfillmentOrders.bind(adapter);
    const pages: Array<string | null> = [];
    let failNext = false;
    adapter.listFulfillmentOrders = async (input) => {
      pages.push(input.cursor ?? null);
      if (failNext) { failNext = false; throw providerTemporarilyUnavailable(); }
      const index = Number(input.cursor ?? 0);
      const source = await original(input);
      const order = source.orders.find((order) => order.cancelled)!;
      return {
        orders: [{ ...order, externalOrderId: `PAGE-${index}` }],
        cursor: index < MAX_COMMERCE_SYNC_PAGES + 1 ? String(index + 1) : null,
      };
    };
    h = await createHarness(undefined, { integrations: registry });
    const seller = await login(h.app, "cursor-owner");
    const connected = await request(h.app).post("/dev/integrations/demo-storefront/connect").set(auth(seller)).send({});
    const id = connected.body.connection.connectionId;
    const sync = () => request(h.app).post(`/me/commerce-connections/${id}/sync`).set(auth(seller)).send({});
    const first = await sync();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ discoveredCount: MAX_COMMERCE_SYNC_PAGES, cursor: String(MAX_COMMERCE_SYNC_PAGES) });
    expect(pages).toHaveLength(MAX_COMMERCE_SYNC_PAGES);
    failNext = true;
    expect((await sync()).status).toBe(503);
    const stored = await h.db.query<{ provider_cursor: string }>("SELECT provider_cursor FROM commerce_connection_sync_states WHERE connection_id=$1", [id]);
    expect(stored.rows[0].provider_cursor).toBe(String(MAX_COMMERCE_SYNC_PAGES));
    const resumed = await sync();
    expect(resumed.body).toMatchObject({ discoveredCount: 2, cursor: null });
    expect(pages.slice(-2)).toEqual([String(MAX_COMMERCE_SYNC_PAGES), String(MAX_COMMERCE_SYNC_PAGES + 1)]);
    pages.length = 0;
    expect((await sync()).status).toBe(200);
    expect(pages[0]).toBeNull();
  });

  it("rejects a provider cursor cycle instead of looping or reporting completion", async () => {
    const registry = createDefaultIntegrationRegistry(systemClock);
    registry.getCommerce("demo-storefront").listFulfillmentOrders = async () => ({ orders: [], cursor: "same" });
    h = await createHarness(undefined, { integrations: registry });
    const seller = await login(h.app, "cycle-owner");
    const connected = await request(h.app).post("/dev/integrations/demo-storefront/connect").set(auth(seller)).send({});
    const result = await request(h.app).post(`/me/commerce-connections/${connected.body.connection.connectionId}/sync`).set(auth(seller)).send({});
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe("PROVIDER_RESPONSE_INVALID");
  });
});
