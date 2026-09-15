import { createInsertSchema } from "drizzle-zod";
import { pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const tenantMembershipsTable = pgTable("tenant_memberships", {
  id: serial("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  userId: text("user_id").notNull(),
  role: text("role").notNull().default("member"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  tenantUserIndex: uniqueIndex("tenant_memberships_tenant_user_idx").on(table.tenantId, table.userId),
}));

export const insertTenantMembershipSchema = createInsertSchema(tenantMembershipsTable).omit({ id: true, createdAt: true });
export type InsertTenantMembership = z.infer<typeof insertTenantMembershipSchema>;
export type TenantMembership = typeof tenantMembershipsTable.$inferSelect;