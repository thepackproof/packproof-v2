import type { AppConfig } from "../../config.js";
import { createHttpShopifyClient } from "../shopify/client.js";
import type { ShopifyOAuthRuntime } from "./providers/shopify.js";
import type { GoogleOAuthRuntime } from "./providers/google.js";
import type { FacebookOAuthRuntime } from "./providers/facebook.js";
import { createEtsyRuntime as buildEtsyRuntime } from "../etsy/runtime.js";
import { createEtsyRequestBudget } from "../etsy/request-budget.js";
import type { IntegrationCredentialStore } from "../credentials.js";
import type { Database } from "../../db/database.js";
import type { Clock } from "../../clock.js";

function oauthCallback(publicBaseUrl: string, provider: string): string {
  return `${publicBaseUrl.replace(/\/$/, "")}/oauth/${provider}/callback`;
}

export function createEtsyRuntime(config: AppConfig, credentials: IntegrationCredentialStore,
  db: Database, clock: Clock, fetchImpl: typeof fetch = fetch) {
  if (config.etsy.enabled && !["development", "test"].includes(config.release.environment) &&
      config.credentialStore !== "secrets-manager") {
    throw new Error("Enabled Etsy integration requires persistent managed credentials in hosted environments.");
  }
  return buildEtsyRuntime({
    ...config.etsy,
    redirectUri: config.etsy.redirectUri ?? oauthCallback(config.publicBaseUrl, "etsy"),
    credentials,
    fetchImpl,
    ...(config.etsy.clientId ? createEtsyRequestBudget(db, clock, config.etsy.clientId) : {}),
  });
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
