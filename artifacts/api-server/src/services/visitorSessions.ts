import type { Request, Response } from "express";
import { createHmac, randomUUID } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { db, visitorSessionsTable } from "@workspace/db";
import { logger } from "../lib/logger";

export type VisitorAccessMode = "guest" | "authenticated";

const COOKIE_NAME = "vendor_compare_session";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let lastCleanupAt = 0;

export function normalizeClientIp(value: string): string {
  const first = value.split(",")[0]?.trim() || "unknown";
  return first.startsWith("::ffff:") ? first.slice(7) : first;
}

export function pseudonymizeVisitorValue(value: string, secret: string, purpose: "ip" | "session"): string {
  return createHmac("sha256", secret)
    .update(`visitor-analytics:v1:${purpose}:${value}`)
    .digest("hex");
}

function cookieValue(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === COOKIE_NAME) {
      const value = decodeURIComponent(valueParts.join("="));
      return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
        ? value
        : undefined;
    }
  }
  return undefined;
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return normalizeClientIp(value || req.socket.remoteAddress || req.ip || "unknown");
}

function runtimeEnvironment(): "development" | "production" {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export async function recordVisitorSession(
  req: Request,
  res: Response,
  accessMode: VisitorAccessMode,
): Promise<void> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    logger.warn("Visitor session analytics skipped because SESSION_SECRET is unavailable");
    return;
  }

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + RETENTION_MS);
    const rawSessionId = cookieValue(req) || randomUUID();
    if (!cookieValue(req)) {
      res.cookie(COOKIE_NAME, rawSessionId, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        maxAge: RETENTION_MS,
        path: "/",
      });
    }
    const environment = runtimeEnvironment();
    const sessionHash = pseudonymizeVisitorValue(rawSessionId, secret, "session");
    const ipHash = pseudonymizeVisitorValue(clientIp(req), secret, "ip");

    await db.insert(visitorSessionsTable).values({
      sessionHash,
      ipHash,
      accessMode,
      environment,
      firstSeenAt: now,
      lastSeenAt: now,
      expiresAt,
    }).onConflictDoUpdate({
      target: [
        visitorSessionsTable.sessionHash,
        visitorSessionsTable.accessMode,
        visitorSessionsTable.environment,
      ],
      set: {
        ipHash,
        lastSeenAt: now,
        expiresAt,
        activityCount: sql`${visitorSessionsTable.activityCount} + 1`,
      },
    });

    if (now.getTime() - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
      lastCleanupAt = now.getTime();
      await db.delete(visitorSessionsTable).where(lt(visitorSessionsTable.expiresAt, now));
    }
  } catch (error) {
    logger.warn({ error }, "Visitor session analytics could not be recorded");
  }
}