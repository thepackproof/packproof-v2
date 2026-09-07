import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Etsy server configuration", () => {
  it("stays disabled until enabled and keeps the shared secret out of config", () => {
    const config = loadConfig({PACKPROOF_ETSY_CLIENT_ID:"synthetic-keystring", PACKPROOF_ETSY_SHARED_SECRET:"synthetic-secret-value"});
    expect(config.etsy).toEqual({enabled:false,clientId:"synthetic-keystring",appCredentialReference:"env:PACKPROOF_ETSY_SHARED_SECRET",redirectUri:null});
    expect(JSON.stringify(config)).not.toContain("synthetic-secret-value");
  });
  it("requires app keys when enabled and accepts a managed credential reference", () => {
    expect(() => loadConfig({PACKPROOF_ETSY_INTEGRATION_ENABLED:"true"})).toThrow(/PACKPROOF_ETSY_CLIENT_ID/);
    expect(loadConfig({PACKPROOF_ETSY_INTEGRATION_ENABLED:"true", PACKPROOF_ETSY_CLIENT_ID:"synthetic-keystring", PACKPROOF_ETSY_APP_CREDENTIAL_REFERENCE:"packproof/test/integrations/etsy/app"}).etsy.enabled).toBe(true);
  });
  it("accepts exact HTTPS callback paths and rejects credentials, query, or plaintext", () => {
    expect(loadConfig({PACKPROOF_ETSY_REDIRECT_URI:"https://thepackproof.com/api/oauth/etsy/callback"}).etsy.redirectUri).toBe("https://thepackproof.com/api/oauth/etsy/callback");
    for (const url of ["http://example.test/oauth/etsy/callback", "https://u:p@example.test/oauth/etsy/callback", "https://example.test/oauth/etsy/callback?x=1", "https://example.test/oauth/etsy/callback#x", "https://example.test/oauth/etsy/callback/"]) {
      expect(() => loadConfig({PACKPROOF_ETSY_REDIRECT_URI:url})).toThrow(/PACKPROOF_ETSY_REDIRECT_URI/);
    }
  });
});
