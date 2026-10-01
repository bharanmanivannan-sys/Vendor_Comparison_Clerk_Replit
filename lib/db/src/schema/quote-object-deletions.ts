import { integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Durable deletion outbox: object keys remain here until storage confirms removal. */
export const quoteObjectDeletionsTable = pgTable("quote_object_deletions", {
  id: serial("id").primaryKey(),
  objectKey: text("object_key").notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("quote_object_deletions_object_key_unique").on(table.objectKey),
]);