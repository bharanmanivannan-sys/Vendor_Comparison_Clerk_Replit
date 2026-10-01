import { jsonb, pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const comparisonJobCheckpointsTable = pgTable("comparison_job_checkpoints", {
  id: text("id").primaryKey(),
  draftId: text("draft_id"),
  draftVersion: integer("draft_version"),
  draftContextHash: text("draft_context_hash"),
  owner: text("owner").notNull(),
  userId: text("user_id"),
  status: text("status").notNull(),
  stage: text("stage").notNull(),
  progress: jsonb("progress").$type<{ entities: string[]; subject: string }>().notNull(),
  result: jsonb("result"),
  recoverySnapshot: jsonb("recovery_snapshot"),
  resumeInput: jsonb("resume_input"),
  saveStatus: text("save_status"),
  previewDecision: jsonb("preview_decision"),
  message: text("message"),
  errorCode: text("error_code"),
  requestMapKey: text("request_map_key"),
  requestHash: text("request_hash"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  checkpointVersion: integer("checkpoint_version").notNull().default(1),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (table) => ({
  statusLeaseIndex: index("comparison_job_checkpoints_status_lease_idx").on(table.status, table.leaseExpiresAt),
  ownerCreatedIndex: index("comparison_job_checkpoints_owner_created_idx").on(table.owner, table.createdAt),
  createdIndex: index("comparison_job_checkpoints_created_at_idx").on(table.createdAt),
}));

export const comparisonJobUnitsTable = pgTable("comparison_job_units", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => comparisonJobCheckpointsTable.id, { onDelete: "cascade" }),
  unitKey: text("unit_key").notNull(),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  attempt: integer("attempt").notNull().default(1),
  checkpointVersion: integer("checkpoint_version").notNull().default(1),
  leaseOwner: text("lease_owner").notNull(),
  snapshot: jsonb("snapshot"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  jobUnitUnique: uniqueIndex("comparison_job_units_job_unit_idx").on(table.jobId, table.unitKey),
  jobStatusIndex: index("comparison_job_units_job_status_idx").on(table.jobId, table.status),
}));

export const insertComparisonJobCheckpointSchema = createInsertSchema(comparisonJobCheckpointsTable).omit({
  updatedAt: true,
  checkpointVersion: true,
});
export type InsertComparisonJobCheckpoint = z.infer<typeof insertComparisonJobCheckpointSchema>;
export type ComparisonJobCheckpoint = typeof comparisonJobCheckpointsTable.$inferSelect;
export type ComparisonJobUnit = typeof comparisonJobUnitsTable.$inferSelect;