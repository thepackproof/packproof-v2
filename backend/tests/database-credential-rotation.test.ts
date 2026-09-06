import { describe, expect, it, vi } from "vitest";
import { createDatabasePasswordProvider } from "../src/db/rotating-credentials.js";
import { postgresPoolConfig } from "../src/db/postgres.js";

const input = { secretId: "unit-test-database", region: "us-east-1", expectedUsername: "packproof" };
const secret = (password: string) => ({ SecretString: JSON.stringify({ username: "packproof", password }) });

describe("RDS credential rotation", () => {
  it("loads the current password for each new physical connection", async () => {
    const readSecret = vi.fn().mockResolvedValueOnce(secret("before-rotation")).mockResolvedValueOnce(secret("after-rotation"));
    const password = createDatabasePasswordProvider({ ...input, readSecret });
    expect(await password()).toBe("before-rotation");
    expect(await password()).toBe("after-rotation");
    expect(readSecret).toHaveBeenCalledTimes(2);
  });

  it("does not let the stale connection-string password override the callback", () => {
    const password = async () => "current-password";
    const config = postgresPoolConfig("postgres://packproof:stale-password@db.example:5432/packproof_v2?sslmode=verify-full", password);
    expect(config.connectionString).toBeUndefined();
    expect(config.password).toBe(password);
    expect(config.host).toBe("db.example");
    expect(config.database).toBe("packproof_v2");
    expect(config.user).toBe("packproof");
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(JSON.stringify(config)).not.toContain("stale-password");
  });

  it.each([undefined, "not-json", "[]", "{}", JSON.stringify({ username: "another-user", password: "sensitive-value" })])(
    "fails closed on malformed or mismatched credentials", async (SecretString) => {
      const password = createDatabasePasswordProvider({ ...input, readSecret: async () => ({ SecretString }) });
      await expect(password()).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
      await expect(password()).rejects.not.toThrow("sensitive-value");
    },
  );

  it("does not leak AWS errors and recovers on a later credential lookup", async () => {
    const readSecret = vi.fn().mockRejectedValueOnce(new Error("secret-in-aws-error")).mockResolvedValueOnce(secret("new-password"));
    const password = createDatabasePasswordProvider({ ...input, readSecret });
    await expect(password()).rejects.not.toThrow("secret-in-aws-error");
    expect(await password()).toBe("new-password");
  });

  it("preserves the existing static-credential and TLS configuration path", () => {
    const config = postgresPoolConfig("postgres://user:password@localhost/db?sslmode=require");
    expect(config.connectionString).not.toContain("sslmode");
    expect(config.ssl).toEqual({ rejectUnauthorized: false });
    expect(config.password).toBeUndefined();
  });
});
