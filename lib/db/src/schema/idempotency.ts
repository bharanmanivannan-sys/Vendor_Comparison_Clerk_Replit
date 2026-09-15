import { pgTable, serial, text, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const idempotencyKeysTable = pgTable("idempotency_keys", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: text("status").notNull().default("in_progress"),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  responseHeaders: jsonb("response_headers").$type<Record<string, string>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ownershipToken: text("ownership_token").notNull(),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (table) => ({
  tenantKeyIndex: uniqueIndex("idempotency_tenant_key_idx").on(table.tenantId, table.key),
}));

export type IdempotencyKey = typeof idempotencyKeysTable.$inferSelect;