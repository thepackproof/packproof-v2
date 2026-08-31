import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import request from "supertest";
import { BearerUserAdapter } from "../src/auth/adapter.js";
import { systemClock, type Clock } from "../src/clock.js";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { createPgliteDatabase } from "../src/db/pglite.js";
import type { Database } from "../src/db/database.js";
import { LocalObjectStore } from "../src/s3/local-object-store.js";
import type { ObjectStore } from "../src/s3/object-store.js";
import { insertUser } from "../src/domain/users.js";
import { MemoryCredentialStore } from "../src/integrations/memory-credential-store.js";

export interface TestHarness {
  db: Database;
  app: ReturnType<typeof createApp>;
  clock: Clock;
  objectStore: ObjectStore;
  credentialStore: MemoryCredentialStore;
  close: () => Promise<void>;
}

export async function createHarness(
  clock: Clock = systemClock,
  options: { publicBaseUrl?: string; objectStore?: ObjectStore } = {},
): Promise<TestHarness> {
  const resolvedClock = clock ?? systemClock;
  const publicBaseUrl = options.publicBaseUrl ?? "http://127.0.0.1";
  const dir = await mkdtemp(path.join(os.tmpdir(), "packproof-v2-"));
  const opened = await createPgliteDatabase();
  await migrate(opened.db);
  const objectStore =
    options.objectStore ??
    new LocalObjectStore(
      path.join(dir, "objects"),
      publicBaseUrl,
      "test-upload-secret",
    );
  const credentialStore = new MemoryCredentialStore();
  const app = createApp({
    db: opened.db,
    objectStore,
    clock: resolvedClock,
    auth: new BearerUserAdapter(opened.db),
    publicBaseUrl,
    devAuth: true,
    credentialStore,
  });

  return {
    db: opened.db,
    app,
    clock: resolvedClock,
    objectStore,
    credentialStore,
    close: async () => {
      await opened.close();
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
