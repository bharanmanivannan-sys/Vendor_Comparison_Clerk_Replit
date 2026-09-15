import { pgTable, serial, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const auditEventsTable = pgTable("audit_events", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantCreatedIndex: index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
}));

export type AuditEvent = typeof auditEventsTable.$inferSelect;