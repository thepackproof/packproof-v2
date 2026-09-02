import type { EbayRuntime } from "../../domain/ebay-marketplace.js";
import type { IntegrationCredentialStore } from "../credentials.js";
import { ConnectedAccountProviderRegistry } from "./registry.js";
import { createEbayConnectedAccountProvider } from "./providers/ebay.js";
import {
  createShopifyConnectedAccountProvider,
  disabledShopifyRuntime,
  type ShopifyOAuthRuntime,
} from "./providers/shopify.js";
import {
  createGoogleConnectedAccountProvider,
  disabledGoogleRuntime,
  type GoogleOAuthRuntime,
} from "./providers/google.js";
import {
  createFacebookConnectedAccountProvider,
  disabledFacebookRuntime,
  type FacebookOAuthRuntime,
} from "./providers/facebook.js";

export interface ConnectedAccountRuntimes {
  ebay: EbayRuntime;
  shopify: ShopifyOAuthRuntime;
  google: GoogleOAuthRuntime;
  facebook: FacebookOAuthRuntime;
  credentials: IntegrationCredentialStore;
}

export function createConnectedAccountRegistry(
  input: ConnectedAccountRuntimes,
): ConnectedAccountProviderRegistry {
  return new ConnectedAccountProviderRegistry(
    new Map([
      ["ebay", createEbayConnectedAccountProvider({ runtime: input.ebay, credentials: input.credentials })],
      [
        "shopify",
        createShopifyConnectedAccountProvider({ runtime: input.shopify, credentials: input.credentials }),
      ],
      ["google", createGoogleConnectedAccountProvider({ runtime: input.google, credentials: input.credentials })],
      ["facebook", createFacebookConnectedAccountProvider({ runtime: input.facebook, credentials: input.credentials })],
    ]),
  );
}

export function disabledConnectedAccountRuntimes(
  ebay: EbayRuntime,
  credentials: IntegrationCredentialStore,
): ConnectedAccountRuntimes {
  return {
    ebay,
    shopify: disabledShopifyRuntime(),
    google: disabledGoogleRuntime(),
    facebook: disabledFacebookRuntime(),
    credentials,
  };
}
