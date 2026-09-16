import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../../../../lib/db/src/schema";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database tests.");

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
export * from "../../../../lib/db/src/schema";