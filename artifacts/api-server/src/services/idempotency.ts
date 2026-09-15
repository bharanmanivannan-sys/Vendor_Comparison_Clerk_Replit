import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { db, idempotencyKeysTable } from "@workspace/db";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function requestHash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(body)), "utf8").digest("hex");
}

export async function beginIdempotency(tenantId: string, key: string, hash: string) {
  const ownershipToken = randomBytes(32).toString("hex");
  const [created] = await db.insert(idempotencyKeysTable).values({
    tenantId,
    key,
    requestHash: hash,
    status: "in_progress",
    ownershipToken,
    leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  }).onConflictDoNothing().returning();
  if (created) return { state: "new" as const, ownershipToken };
  const [existing] = await db.select().from(idempotencyKeysTable).where(and(
    eq(idempotencyKeysTable.tenantId, tenantId),
    eq(idempotencyKeysTable.key, key),
  )).limit(1);
  if (!existing) return { state: "new" as const };
  if (existing.requestHash !== hash) return { state: "changed" as const };
  if (existing.status === "in_progress") {
    const [reclaimed] = await db.update(idempotencyKeysTable).set({
      ownershipToken,
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      updatedAt: new Date(),
    }).where(and(
      eq(idempotencyKeysTable.id, existing.id),
      eq(idempotencyKeysTable.status, "in_progress"),
      eq(idempotencyKeysTable.requestHash, hash),
      eq(idempotencyKeysTable.ownershipToken, existing.ownershipToken),
      lt(idempotencyKeysTable.leaseExpiresAt, new Date()),
    )).returning({ id: idempotencyKeysTable.id });
    return reclaimed ? { state: "new" as const, ownershipToken } : { state: "in_progress" as const };
  }
  if (existing.status === "completed" && existing.responseBody !== null) {
    return { state: "replay" as const, status: existing.responseStatus ?? 201, body: existing.responseBody, headers: existing.responseHeaders ?? {} };
  }
  return { state: "in_progress" as const };
}

export function startIdempotencyHeartbeat(tenantId: string, key: string, ownershipToken: string) {
  let lostOwnership = false;
  const timer = setInterval(() => {
    void db.update(idempotencyKeysTable).set({
      leaseExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
      updatedAt: new Date(),
    }).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
      eq(idempotencyKeysTable.ownershipToken, ownershipToken),
      eq(idempotencyKeysTable.status, "in_progress"),
    )).returning({ id: idempotencyKeysTable.id }).then((rows) => {
      if (!rows.length) lostOwnership = true;
    }).catch((cause) => {
      console.error("Idempotency lease heartbeat failed", cause);
    });
  }, 60_000);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    hasLostOwnership: () => lostOwnership,
  };
}

export async function completeIdempotency(
  executor: any,
  tenantId: string,
  key: string,
  ownershipToken: string,
  status: number,
  body: unknown,
  headers: Record<string, string>,
) {
  const [completed] = await executor.update(idempotencyKeysTable).set({
    status: "completed",
    responseStatus: status,
    responseBody: body,
    responseHeaders: headers,
    updatedAt: new Date(),
  }).where(and(
    eq(idempotencyKeysTable.tenantId, tenantId),
    eq(idempotencyKeysTable.key, key),
    eq(idempotencyKeysTable.ownershipToken, ownershipToken),
    eq(idempotencyKeysTable.status, "in_progress"),
  )).returning({ id: idempotencyKeysTable.id });
  if (!completed) throw new Error("Idempotency ownership was lost before completion.");
}

export async function failIdempotency(tenantId: string, key: string, ownershipToken: string) {
  await db.delete(idempotencyKeysTable).where(and(
    eq(idempotencyKeysTable.tenantId, tenantId),
    eq(idempotencyKeysTable.key, key),
    eq(idempotencyKeysTable.ownershipToken, ownershipToken),
    eq(idempotencyKeysTable.status, "in_progress"),
  ));
}