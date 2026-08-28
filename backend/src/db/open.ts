import { createPgliteDatabase } from "./pglite.js";
import { createPgDatabase } from "./postgres.js";
import type { Database } from "./database.js";
import type { AppConfig } from "../config.js";

export async function openDatabase(config: AppConfig): Promise<{
  db: Database;
  close: () => Promise<void>;
  engine: "postgres" | "pglite";
}> {
  if (config.databaseUrl) {
    const opened = createPgDatabase(config.databaseUrl);
    return { ...opened, engine: "postgres" };
  }
  const opened = await createPgliteDatabase(config.pgliteDir);
  return { ...opened, engine: "pglite" };
}
