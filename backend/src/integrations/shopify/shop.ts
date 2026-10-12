import { DomainError } from "../../domain/errors.js";

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SHOP_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeShopifyShop(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_SHOP_DOMAIN", "A Shopify shop domain is required", 400);
  }
  let raw = value.trim().toLowerCase();
  // Do not allow a line terminator in a URL to turn an invalid domain into a
  // valid one when discarding its path. Native prefix/index operations are linear.
  if (/[\r\n\u2028\u2029]/.test(raw))
    throw new DomainError("INVALID_SHOP_DOMAIN", "Shop must be a myshopify.com domain", 400);
  if (raw.startsWith("https://")) raw = raw.slice(8);
  else if (raw.startsWith("http://")) raw = raw.slice(7);
  const pathStart = raw.indexOf("/");
  if (pathStart !== -1) raw = raw.slice(0, pathStart);
  if (SHOP_NAME.test(raw)) {
    raw = `${raw}.myshopify.com`;
  }
  if (!SHOP_HOST.test(raw)) {
    throw new DomainError(
      "INVALID_SHOP_DOMAIN",
      "Shop must be a myshopify.com domain",
      400,
    );
  }
  return raw;
}

export function shopifyShopHandle(shop: string): string {
  return shop.replace(/\.myshopify\.com$/, "");
}
