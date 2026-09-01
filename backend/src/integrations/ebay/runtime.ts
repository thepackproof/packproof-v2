import type { AppConfig } from "../../config.js";
import { createHttpEbayClient } from "./client.js";
import type { EbayRuntime } from "../../domain/ebay-marketplace.js";

export function createEbayRuntime(
  config: AppConfig,
  input: { publicBaseUrl: string; webOrigins: string[] },
): EbayRuntime {
  const webReturnUrl = input.webOrigins[0]
    ? `${input.webOrigins[0].replace(/\/$/, "")}/stores`
    : null;
  const deletionEndpoint = `${input.publicBaseUrl.replace(/\/$/, "")}/integrations/webhooks/ebay/account-deletion`;
  return {
    enabled: config.ebay.enabled,
    environment: config.ebay.environment,
    clientId: config.ebay.clientId,
    ruName: config.ebay.ruName,
    marketplaceId: config.ebay.marketplaceId,
    appCredentialReference: config.ebay.appCredentialReference,
    deletionVerificationToken: config.ebay.deletionVerificationToken,
    deletionEndpoint,
    webReturnUrl,
    client: config.ebay.enabled ? createHttpEbayClient() : null,
  };
}

export function disabledEbayRuntime(): EbayRuntime {
  return {
    enabled: false,
    environment: "sandbox",
    clientId: null,
    ruName: null,
    marketplaceId: "EBAY_US",
    appCredentialReference: null,
    deletionVerificationToken: null,
    deletionEndpoint: null,
    webReturnUrl: null,
    client: null,
  };
}
