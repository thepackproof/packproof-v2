import { DomainError } from "../../domain/errors.js";

const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const SHOP_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function normalizeShopifyShop(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError("INVALID_SHOP_DOMAIN", "A Shopify shop domain is required", 400);
  }
  let raw = value.trim().toLowerCase();
  raw = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
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
