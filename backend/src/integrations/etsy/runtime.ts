import type { IntegrationCredentialStore } from "../credentials.js";
import { createHttpEtsyClient } from "./client.js";
import { parseEtsySharedSecret } from "./credentials.js";
import type { EtsyClient } from "./types.js";

export interface EtsyRuntime {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
  redirectUri: string;
  client: EtsyClient | null;
}

export function createEtsyRuntime(input: Omit<EtsyRuntime, "client"> & {
  credentials: IntegrationCredentialStore; fetchImpl?: typeof fetch;
  beforeRequest?: () => Promise<void>;
  afterResponse?: (response: Pick<Response, "status" | "headers">) => Promise<void>;
}): EtsyRuntime {
  return {
    enabled: input.enabled,
    clientId: input.clientId,
    appCredentialReference: input.appCredentialReference,
    redirectUri: input.redirectUri,
    client: input.enabled && input.clientId && input.appCredentialReference ? createHttpEtsyClient({
      clientId: input.clientId,
      fetchImpl: input.fetchImpl,
      beforeRequest: input.beforeRequest,
      afterResponse: input.afterResponse,
      getSharedSecret: async () => parseEtsySharedSecret(await input.credentials.getCredentials({
        adapterKey: "etsy", credentialReference: input.appCredentialReference!,
      })),
    }) : null,
  };
}

export function disabledEtsyRuntime(): EtsyRuntime {
  return { enabled: false, clientId: null, appCredentialReference: null, redirectUri: "https://thepackproof.com/api/oauth/etsy/callback", client: null };
}
