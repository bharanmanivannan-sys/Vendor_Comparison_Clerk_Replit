import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { idempotencyKeysTable } from "../../../../lib/db/src/schema/idempotency";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database tests.");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema: { idempotencyKeysTable } });
export { idempotencyKeysTable };