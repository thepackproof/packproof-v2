import { describe, expect, it, vi } from "vitest";
import type { Database } from "../src/db/database.js";
import type { ObjectStore } from "../src/s3/object-store.js";
import { infrastructureSection, platformHealth } from "../src/admin/infrastructure.js";

const checkedAt = "2026-09-24T15:00:00.000Z";
const clock = { now: () => new Date(checkedAt) };

function database(options: { stale?: boolean; failure?: boolean } = {}): Database {
  const db: Database = {
    query: vi.fn(async (sql: string) => {
      if (options.failure) throw new Error("private database connection details");
      const rows = sql.includes("SELECT 1") ? [{ connected: 1 }]
        : sql.includes("FROM evidence") ? [{ object_key: "private-object-reference", object_version_id: "private-version", byte_size: "7" }]
          : sql.includes("operational_worker_heartbeats") ? [
            { worker_name: "usage-reconciliation", state: "IDLE", heartbeat_at: options.stale ? "2026-09-24T10:00:00Z" : checkedAt, last_success_at: checkedAt },
            { worker_name: "operational-cleanup", state: "IDLE", heartbeat_at: "2026-09-24T14:30:00Z", last_success_at: "2026-09-24T14:30:00Z" },
          ] : [];
      return { rows, rowCount: rows.length };
    }) as Database["query"],
    transaction: async (callback) => callback(db),
  };
  return db;
}

describe("admin infrastructure observations", () => {
  it("shares metadata-only probes while respecting the hourly worker interval", async () => {
    const head = vi.fn(async () => ({ byteSize: 7, contentType: "video/mp4" }));
    const deps = { db: database(), clock, objectStore: { head } as unknown as ObjectStore, adminAwsTelemetry: { env: {} } };
    const [health, section] = await Promise.all([platformHealth(deps), infrastructureSection(deps)]);
    expect(head).toHaveBeenCalledExactlyOnceWith("private-object-reference", { versionId: "private-version" });
    expect(health.find((item) => item.key === "workers")?.status).toBe("healthy");
    expect(section.metrics.find((item) => item.key === "healthyWorkers")?.value).toBe(2);
    expect(section.metrics.find((item) => item.key === "awsCost")?.value).toBeNull();
    expect(JSON.stringify(section)).not.toContain("private-object-reference");
    expect(JSON.stringify(section)).not.toContain("private-version");
  });

  it("warns about stale worker groups and never treats absent probes as healthy", async () => {
    const health = await platformHealth({ db: database({ stale: true }), clock, objectStore: {} as ObjectStore });
    expect(health.find((item) => item.key === "workers")?.status).toBe("warning");
    expect(health.find((item) => item.key === "storage")?.status).toBe("unavailable");
    expect(health.find((item) => item.key === "authentication")?.status).toBe("unavailable");
  });

  it("redacts dependency failures and retains useful partial health", async () => {
    const objectStore = { head: async () => { throw new Error("private provider credentials"); } } as unknown as ObjectStore;
    const health = await platformHealth({ db: database(), clock, objectStore });
    expect(health.find((item) => item.key === "database")?.status).toBe("healthy");
    expect(health.find((item) => item.key === "storage")?.status).toBe("unavailable");
    expect(JSON.stringify(health)).not.toContain("private provider credentials");
    const unavailable = await platformHealth({ db: database({ failure: true }), clock, objectStore });
    expect(unavailable.find((item) => item.key === "database")?.status).toBe("unavailable");
    expect(JSON.stringify(unavailable)).not.toContain("private database connection details");
  });
});
