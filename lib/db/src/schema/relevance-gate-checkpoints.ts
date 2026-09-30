import { boolean, jsonb, pgTable, text, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const relevanceGateCheckpointsTable = pgTable("relevance_gate_checkpoints", {
  id: text("id").primaryKey(),
  comparisonId: text("comparison_id"),
  draftId: text("draft_id").notNull(),
  jobId: text("job_id").notNull(),
  optionId: text("option_id").notNull(),
  gateType: text("gate_type").notNull(),
  status: text("status").notNull(),
  preservePassed: boolean("preserve_passed").notNull().default(false),
  attempt: integer("attempt").notNull().default(0),
  checkpointVersion: integer("checkpoint_version").notNull().default(1),
  evidence: jsonb("evidence").$type<unknown[]>().notNull().default([]),
  pendingResult: jsonb("pending_result"),
  result: jsonb("result"),
  reason: text("reason"),
  marketContextHash: text("market_context_hash").notNull(),
  objectiveHash: text("objective_hash").notNull(),
  confirmedIdentityVersion: integer("confirmed_identity_version").notNull(),
  provenance: jsonb("provenance").$type<Record<string, unknown>>().notNull().default({}),
  freshUntil: timestamp("fresh_until", { withTimezone: true }),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => ({
  identityUnique: uniqueIndex("relevance_gate_checkpoints_identity_idx").on(
    table.jobId,
    table.optionId,
    table.gateType,
    table.marketContextHash,
    table.objectiveHash,
    table.confirmedIdentityVersion,
  ),
  jobStatusIndex: index("relevance_gate_checkpoints_job_status_idx").on(table.jobId, table.status),
  leaseIndex: index("relevance_gate_checkpoints_lease_idx").on(table.status, table.leaseExpiresAt),
}));

export const insertRelevanceGateCheckpointSchema = createInsertSchema(relevanceGateCheckpointsTable).omit({
  createdAt: true,
  updatedAt: true,
  checkpointVersion: true,
});
export type InsertRelevanceGateCheckpoint = z.infer<typeof insertRelevanceGateCheckpointSchema>;
export type RelevanceGateCheckpoint = typeof relevanceGateCheckpointsTable.$inferSelect;