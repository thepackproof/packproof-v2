export const EBAY_ADAPTER_KEY = "ebay";
export const EBAY_PROVIDER = "ebay";

export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
] as const;

export type EbayEnvironment = "sandbox" | "production";

export function ebayAuthBaseUrl(environment: EbayEnvironment): string {
  return environment === "production"
    ? "https://auth.ebay.com"
    : "https://auth.sandbox.ebay.com";
}

export function ebayApiBaseUrl(environment: EbayEnvironment): string {
  return environment === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";
}

export function ebayScopeParam(scopes: readonly string[] = EBAY_SCOPES): string {
  return scopes.join(" ");
}
