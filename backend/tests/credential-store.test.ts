import { describe, expect, it } from "vitest";
import { CompositeCredentialStore } from "../src/integrations/create-credential-store.js";
import { EnvCredentialStore } from "../src/integrations/env-credential-store.js";
import { MemoryCredentialStore } from "../src/integrations/memory-credential-store.js";
import {
  integrationCredentialReference,
  SecretsManagerCredentialStore,
} from "../src/integrations/secrets-manager-credential-store.js";
import { InMemorySecretsManagerClient } from "./fakes/in-memory-secrets-manager.js";

function durableStore(backend: InMemorySecretsManagerClient, memory = new MemoryCredentialStore()) {
  return new CompositeCredentialStore(
    memory,
    new EnvCredentialStore({}),
    new SecretsManagerCredentialStore(backend),
  );
}

describe("durable integration credential store", () => {
  it("puts, gets, updates, and deletes Secrets Manager credentials without live AWS", async () => {
    const backend = new InMemorySecretsManagerClient();
    const store = durableStore(backend);
    const credentialReference = integrationCredentialReference({
      packproofEnvironment: "test",
      adapterKey: "ebay",
      connectionId: "icn_test_1",
      suffix: "sandbox",
    });
    await store.put({
      adapterKey: "ebay",
      credentialReference,
      material: { accessToken: "access-1", refreshToken: "refresh-1" },
    });
    const created = await store.getCredentials({ adapterKey: "ebay", credentialReference });
    expect(created?.material).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });

    await store.put({
      adapterKey: "ebay",
      credentialReference,
      material: { accessToken: "access-2", refreshToken: "refresh-1" },
    });
    const updated = await store.getCredentials({ adapterKey: "ebay", credentialReference });
    expect(updated?.material.accessToken).toBe("access-2");

    await store.deleteCredentials({ adapterKey: "ebay", credentialReference });
    expect(await store.getCredentials({ adapterKey: "ebay", credentialReference })).toBeNull();
    expect(backend.secrets.size).toBe(0);
  });

  it("recovers credentials after a process-style store re-instantiation", async () => {
    const backend = new InMemorySecretsManagerClient();
    const first = durableStore(backend);
    const credentialReference = "packproof/test/integrations/ebay/sandbox/icn_restart";
    await first.put({
      adapterKey: "ebay",
      credentialReference,
      material: { accessToken: "access-live", refreshToken: "refresh-live" },
    });

    const reconstructed = durableStore(backend, new MemoryCredentialStore());
    const recovered = await reconstructed.getCredentials({ adapterKey: "ebay", credentialReference });
    expect(recovered?.material.refreshToken).toBe("refresh-live");
    expect(JSON.stringify(recovered?.credentialReference)).not.toContain("access-live");
  });

  it("does not persist memory: references to Secrets Manager", async () => {
    const backend = new InMemorySecretsManagerClient();
    const store = durableStore(backend);
    await store.put({
      adapterKey: "ebay",
      credentialReference: "memory:ebay-app",
      material: { clientSecret: "test-cert-id" },
    });
    expect(backend.secrets.size).toBe(0);
    expect(
      await store.getCredentials({ adapterKey: "ebay", credentialReference: "memory:ebay-app" }),
    ).toMatchObject({ material: { clientSecret: "test-cert-id" } });
  });
});
