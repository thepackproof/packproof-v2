import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import request from "supertest";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { systemClock, type Clock } from "../src/clock.js";
import {
  createServerApp,
  type EbayDeletionSignatureVerifier,
} from "../src/server-app.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteDatabase } from "../src/db/pglite.js";
import type { Database } from "../src/db/database.js";
import { LocalObjectStore } from "../src/s3/local-object-store.js";
import type { ObjectStore } from "../src/s3/object-store.js";
import { insertUser } from "../src/domain/users.js";
import type { MutableCredentialStore } from "../src/integrations/credentials.js";
import { MemoryCredentialStore } from "../src/integrations/memory-credential-store.js";
import type { IntegrationAdapterRegistry } from "../src/integrations/registry.js";
import { commitAttestation } from "../src/domain/attestations.js";
import { commitEvidence, initializeEvidenceUpload } from "../src/domain/evidence.js";
import { sha256Hex } from "../src/hash.js";

export interface TestHarness {
  db: Database;
  app: ReturnType<typeof createServerApp>;
  clock: Clock;
  objectStore: ObjectStore;
  credentialStore: MutableCredentialStore;
  close: () => Promise<void>;
}

export async function createHarness(
  clock: Clock = systemClock,
  options: {
    publicBaseUrl?: string;
    objectStore?: ObjectStore;
    integrations?: IntegrationAdapterRegistry;
    ebay?: import("../src/domain/ebay-marketplace.js").EbayRuntime;
    shopify?: import("../src/integrations/connected-accounts/providers/shopify.js").ShopifyOAuthRuntime;
    google?: import("../src/integrations/connected-accounts/providers/google.js").GoogleOAuthRuntime;
    facebook?: import("../src/integrations/connected-accounts/providers/facebook.js").FacebookOAuthRuntime;
    credentialStore?: MutableCredentialStore;
    opened?: { db: Database; close: () => Promise<void> };
    ebayDeletionSignatureVerifier?: EbayDeletionSignatureVerifier;
  } = {},
): Promise<TestHarness> {
  const resolvedClock = clock ?? systemClock;
  const publicBaseUrl = options.publicBaseUrl ?? "http://127.0.0.1";
  const dir = await mkdtemp(path.join(os.tmpdir(), "packproof-v2-"));
  const opened = options.opened ?? (await createPgliteDatabase());
  const ownsDatabase = !options.opened;
  await migrate(opened.db);
  const objectStore =
    options.objectStore ??
    new LocalObjectStore(
      path.join(dir, "objects"),
      publicBaseUrl,
      "test-upload-secret",
    );
  const credentialStore = options.credentialStore ?? new MemoryCredentialStore();
  const app = createServerApp({
    db: opened.db,
    objectStore,
    clock: resolvedClock,
    auth: new BearerUserAdapter(opened.db),
    publicBaseUrl,
    devAuth: true,
    credentialStore,
    integrations: options.integrations,
    ebay: options.ebay,
    shopify: options.shopify,
    google: options.google,
    facebook: options.facebook,
    // Unit/integration tests opt out of the external eBay key lookup by default.
    // Dedicated verifier tests exercise the real cryptographic implementation.
    ebayDeletionSignatureVerifier:
      options.ebayDeletionSignatureVerifier ?? (async () => undefined),
  });

  return {
    db: opened.db,
    app,
    clock: resolvedClock,
    objectStore,
    credentialStore,
    close: async () => {
      if (ownsDatabase) {
        await opened.close();
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function createUser(harness: TestHarness, userId?: string): Promise<string> {
  return insertUser(harness.db, harness.clock, userId);
}

export function auth(userId: string): { Authorization: string } {
  return { Authorization: `Bearer ${userId}` };
}

export async function login(app: TestHarness["app"], subject: string): Promise<string> {
  const response = await request(app).post("/auth/dev/login").send({ subject });
  if (response.status !== 200) {
    throw new Error(`login failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body.userId as string;
}

export async function commitProofEvidence(
  harness: TestHarness,
  seller: string,
  proofId: string,
  input: {
    evidenceType?: string;
    contentType?: string;
    bytes?: Buffer;
    idempotencyKey?: string;
  } = {},
) {
  const bytes = input.bytes ?? Buffer.from(`evidence-${proofId}-${input.evidenceType ?? "default"}`);
  const contentType = input.contentType ?? "video/mp4";
  const upload = await initializeEvidenceUpload(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    {
      contentType,
      evidenceType: input.evidenceType,
      idempotencyKey: input.idempotencyKey ?? `evd-${proofId}-${input.evidenceType ?? "default"}`,
    },
  );
  await harness.objectStore.put(upload.objectKey, bytes, contentType);
  return commitEvidence(
    harness.db,
    harness.clock,
    harness.objectStore,
    seller,
    proofId,
    upload.evidenceId,
    sha256Hex(bytes),
  );
}

export async function commitFulfillmentAndAttest(
  harness: TestHarness,
  seller: string,
  proofId: string,
  input: {
    bytes?: Buffer;
    idempotencyKey?: string;
  } = {},
) {
  const committed = await commitProofEvidence(harness, seller, proofId, {
    evidenceType: "FULFILLMENT_CAPTURE",
    bytes: input.bytes,
    idempotencyKey: input.idempotencyKey,
  });
  await commitAttestation(harness.db, harness.clock, seller, proofId, {
    statement: "PACKED_DESCRIBED_ITEM",
    relatedEvidenceId: committed.evidenceId,
  });
  return committed;
}
