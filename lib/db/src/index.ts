import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (error) => {
  const code = typeof (error as Error & { code?: unknown }).code === "string"
    ? (error as Error & { code: string }).code
    : "unknown";
  console.error(
    "Database pool discarded an idle client after an unexpected error",
    `name=${error.name}`,
    `message=${error.message}`,
    `code=${code}`,
  );
});
export const db = drizzle(pool, { schema });

export * from "./schema";
