import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Short-lived model-only inputs; source documents and researched reports never belong here. */
export const preliminaryScorecardsTable = pgTable("preliminary_scorecards", {
  key: text("key").primaryKey(),
  modelOutput: jsonb("model_output").$type<unknown>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const insertPreliminaryScorecardSchema = createInsertSchema(preliminaryScorecardsTable);
export type PreliminaryScorecard = z.infer<typeof insertPreliminaryScorecardSchema>;