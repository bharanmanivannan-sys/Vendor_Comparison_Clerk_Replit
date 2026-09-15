import { createInsertSchema } from "drizzle-zod";
import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  keyHash: text("key_hash").notNull(),
  scopes: text("scopes").array().notNull().default(["comparisons:read", "comparisons:write", "usage:read"]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  keyHashIndex: uniqueIndex("api_keys_hash_idx").on(table.keyHash),
  tenantPrefixIndex: uniqueIndex("api_keys_tenant_prefix_idx").on(table.tenantId, table.keyPrefix),
}));

export const insertApiKeySchema = createInsertSchema(apiKeysTable).omit({ id: true, createdAt: true, lastUsedAt: true });
export type InsertApiKey = z.infer<typeof insertApiKeySchema>;
export type ApiKey = typeof apiKeysTable.$inferSelect;