import { integer, jsonb, pgTable, serial, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { comparisonsTable } from "./comparisons";

export const comparisonReportVersionsTable = pgTable("comparison_report_versions", {
  id: serial("id").primaryKey(),
  comparisonId: integer("comparison_id").notNull().references(() => comparisonsTable.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
}, (table) => [
  uniqueIndex("comparison_report_versions_comparison_version_idx").on(table.comparisonId, table.version),
]);

export type ComparisonReportVersion = typeof comparisonReportVersionsTable.$inferSelect;