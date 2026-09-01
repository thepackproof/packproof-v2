import {
  EBAY_SCOPES,
  ebayApiBaseUrl,
  ebayAuthBaseUrl,
  ebayScopeParam,
  type EbayEnvironment,
} from "./constants.js";

export function buildEbayAuthorizationUrl(input: {
  environment: EbayEnvironment;
  clientId: string;
  ruName: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(`${ebayAuthBaseUrl(input.environment)}/oauth2/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.ruName);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ebayScopeParam(input.scopes ?? EBAY_SCOPES));
  url.searchParams.set("state", input.state);
  return url.toString();
}

export function ebayTokenUrl(environment: EbayEnvironment): string {
  return `${ebayApiBaseUrl(environment)}/identity/v1/oauth2/token`;
}

export function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`;
}
