import { createPgDatabase } from "./postgres.js";
import { createDatabasePasswordProvider } from "./rotating-credentials.js";
import type { Database } from "./database.js";
import type { AppConfig } from "../config.js";

export async function openDatabase(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<{
  db: Database;
  close: () => Promise<void>;
  engine: "postgres" | "pglite";
}> {
  if (config.databaseUrl) {
    const secretId = env.PACKPROOF_DB_SECRET_ARN?.trim();
    const passwordProvider = secretId ? createDatabasePasswordProvider({
      secretId,
      region: config.awsRegion ?? "",
      expectedUsername: decodeURIComponent(new URL(config.databaseUrl).username),
    }) : undefined;
    const opened = createPgDatabase(config.databaseUrl, passwordProvider);
    return { ...opened, engine: "postgres" };
  }
  if (env.PACKPROOF_DB_SECRET_ARN?.trim()) {
    throw new Error("Rotating database credentials require a configured PostgreSQL database");
  }
  const { createPgliteDatabase } = await import("./pglite.js");
  const opened = await createPgliteDatabase(config.pgliteDir);
  return { ...opened, engine: "pglite" };
}
