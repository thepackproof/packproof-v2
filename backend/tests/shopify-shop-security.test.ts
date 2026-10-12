import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { normalizeShopifyShop, shopifyShopHandle } from "../src/integrations/shopify/shop.js";

describe("Shopify domain normalization", () => {
  it("preserves handles, canonical domains, HTTP(S) prefixes and ordinary paths", () => {
    for (const value of ["my-store", " My-Store.MyShopify.COM ", "https://my-store.myshopify.com/", "http://MY-STORE/path?x=1", "my-store/admin/orders/123"])
      expect(normalizeShopifyShop(value)).toBe("my-store.myshopify.com");
    expect(shopifyShopHandle(normalizeShopifyShop("my-store"))).toBe("my-store");
  });

  it("rejects lookalike hosts, unsupported protocols, credentials and embedded line terminators", () => {
    for (const value of [null, "", " ", "my-store.myshopify.com.attacker.test", "ftp://my-store.myshopify.com", "user@my-store.myshopify.com",
      "my-store.myshopify.com:443", "https://my-store.myshopify.com/path\nrest", "my-store/\rrest", "my-store/\u2028rest", "my-store/\u2029rest"])
      expect(() => normalizeShopifyShop(value)).toThrow();
  });

  it("rejects long slash/line-terminator near-matches without repeated suffix scanning", () => {
    const moduleUrl = new URL("../src/integrations/shopify/shop.ts", import.meta.url).href;
    const loaderUrl = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--import", loaderUrl, "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import {normalizeShopifyShop} from ${JSON.stringify(moduleUrl)};
      for(const value of ['/'.repeat(250000)+'\\nX', 'my-store/'+ '/'.repeat(250000)+'\\u2028X'])
        assert.throws(()=>normalizeShopifyShop(value));
      assert.equal(normalizeShopifyShop('my-store/'+ '/'.repeat(250000)), 'my-store.myshopify.com');
    `], { timeout: 5000, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
