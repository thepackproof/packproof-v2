import type { AppConfig } from "../../config.js";
import { createHttpShopifyClient } from "../shopify/client.js";
import type { ShopifyOAuthRuntime } from "./providers/shopify.js";
import type { GoogleOAuthRuntime } from "./providers/google.js";
import type { FacebookOAuthRuntime } from "./providers/facebook.js";

function oauthCallback(publicBaseUrl: string, provider: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/oauth/${provider}/callback`;
}

export function createShopifyRuntime(config: AppConfig): ShopifyOAuthRuntime {
  return {
    enabled: config.shopify.enabled,
    clientId: config.shopify.clientId,
    appCredentialReference: config.shopify.appCredentialReference,
    redirectUri: oauthCallback(config.publicBaseUrl, "shopify"),
    client: config.shopify.enabled ? createHttpShopifyClient() : null,
  };
}

export function createGoogleRuntime(config: AppConfig, fetchImpl: typeof fetch = fetch): GoogleOAuthRuntime {
  return {
    enabled: config.google.enabled,
    clientId: config.google.clientId,
    appCredentialReference: config.google.appCredentialReference,
    redirectUri: oauthCallback(config.publicBaseUrl, "google"),
    fetchImpl,
  };
}

export function createFacebookRuntime(
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): FacebookOAuthRuntime {
  return {
    enabled: config.facebook.enabled,
    appId: config.facebook.appId,
    appCredentialReference: config.facebook.appCredentialReference,
    redirectUri: oauthCallback(config.publicBaseUrl, "facebook"),
    fetchImpl,
  };
}
