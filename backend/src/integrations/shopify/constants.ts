export const SHOPIFY_ADAPTER_KEY = "shopify";
export const SHOPIFY_PROVIDER = "shopify";
export const SHOPIFY_API_VERSION = "2026-07";

export const SHOPIFY_SCOPES = ["read_orders"] as const;

export const SHOPIFY_CAPABILITIES = {
  identity: true,
  transactions: true,
  fulfillment: true,
  shipping: false,
  webhooks: true,
} as const;

export const SHOPIFY_LIMITATIONS = [
  "PackProof connects a Shopify shop through official OAuth install and reads orders/fulfillments the Admin API returns.",
  "One PackProof user may connect multiple shops.",
  "Automatic order creation starts only after the seller enables it. Recent order access and any required Shopify app approval must be verified for each shop.",
  "The GraphQL Admin connector reads the most recent 60 days of orders. Older-order access is not requested, and app approval remains a Shopify-managed requirement.",
  "Shopify Marketplace / Shop App buyer surfaces are not implemented.",
  "Carrier-grade shipping APIs are not included in this connection.",
];

export function shopifyAdminApiUrl(shop: string, path: string): string {
  return `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
}

export function shopifyAuthorizeUrl(shop: string): string {
  return `https://${shop}/admin/oauth/authorize`;
}

export function shopifyTokenUrl(shop: string): string {
  return `https://${shop}/admin/oauth/access_token`;
}
