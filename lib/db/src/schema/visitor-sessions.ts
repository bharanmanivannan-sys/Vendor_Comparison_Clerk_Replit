import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const visitorSessionsTable = pgTable("visitor_sessions", {
  id: serial("id").primaryKey(),
  sessionHash: text("session_hash").notNull(),
  ipHash: text("ip_hash").notNull(),
  accessMode: text("access_mode").notNull(),
  environment: text("environment").notNull(),
  activityCount: integer("activity_count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => ({
  sessionModeEnvironmentUnique: uniqueIndex("visitor_sessions_session_mode_environment_idx")
    .on(table.sessionHash, table.accessMode, table.environment),
  expiresIndex: index("visitor_sessions_expires_idx").on(table.expiresAt),
  environmentSeenIndex: index("visitor_sessions_environment_seen_idx")
    .on(table.environment, table.lastSeenAt),
}));

export type VisitorSession = typeof visitorSessionsTable.$inferSelect;