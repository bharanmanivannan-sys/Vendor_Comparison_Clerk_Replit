import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import { apiKeysTable, auditEventsTable, db, tenantsTable } from "@workspace/db";

export const API_KEY_SCOPES = ["comparisons:read", "comparisons:write", "usage:read"] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

export type AuthenticatedApiKey = {
  id: number;
  tenantId: string;
  scopes: string[];
};

function hashKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makePlaintextKey(): { key: string; prefix: string; hash: string } {
  const prefix = randomBytes(6).toString("hex");
  const environment = process.env.BILLING_ENABLED === "true" ? "live" : "beta";
  const key = `vc_${environment}_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix: `vc_${environment}_${prefix}`, hash: hashKey(key) };
}

export function activeEntitlementConditions(tenantId?: string) {
  const now = new Date();
  return and(
    ...(tenantId ? [eq(tenantsTable.id, tenantId)] : []),
    eq(tenantsTable.billingStatus, "active"),
    isNotNull(tenantsTable.billingPeriodStart),
    isNotNull(tenantsTable.billingPeriodEnd),
    lte(tenantsTable.billingPeriodStart, now),
    gt(tenantsTable.billingPeriodEnd, now),
  );
}

export async function isTenantBillingActive(tenantId: string, executor: any = db): Promise<boolean> {
  if (process.env.BILLING_ENABLED !== "true") return true;
  if (!process.env.STRIPE_PRICE_ID) return false;
  const [tenant] = await executor.select({ id: tenantsTable.id })
    .from(tenantsTable).where(activeEntitlementConditions(tenantId)).limit(1);
  return Boolean(tenant);
}

export async function createApiKey(input: {
  tenantId: string;
  actorId: string;
  name: string;
  scopes?: string[];
  expiresAt?: Date | null;
}): Promise<{ key: string; record: typeof apiKeysTable.$inferSelect }> {
  const generated = makePlaintextKey();
  const scopes = input.scopes?.length ? input.scopes : [...API_KEY_SCOPES];
  if (scopes.some((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope))) {
    throw new Error("Invalid API key scope");
  }
  return db.transaction(async (tx) => createApiKeyInTransaction(tx, input, generated, scopes));
}

export async function createApiKeyInTransaction(
  tx: any,
  input: { tenantId: string; actorId: string; name: string; scopes?: string[]; expiresAt?: Date | null },
  generated = makePlaintextKey(),
  scopes = input.scopes?.length ? input.scopes : [...API_KEY_SCOPES],
): Promise<{ key: string; record: typeof apiKeysTable.$inferSelect }> {
  if (scopes.some((scope) => !API_KEY_SCOPES.includes(scope as ApiKeyScope))) {
    throw new Error("Invalid API key scope");
  }
  if (!(await isTenantBillingActive(input.tenantId, tx))) {
    throw new Error("Tenant billing is inactive; verify an active Stripe subscription before creating API keys.");
  }
  const [created] = await tx.insert(apiKeysTable).values({
    tenantId: input.tenantId,
    name: input.name,
    keyPrefix: generated.prefix,
    keyHash: generated.hash,
    scopes,
    expiresAt: input.expiresAt ?? null,
  }).returning();
  await tx.insert(auditEventsTable).values({
    tenantId: input.tenantId,
    actorId: input.actorId,
    action: "api_key.created",
    metadata: { keyId: created.id, scopes },
  });
  return { key: generated.key, record: created };
}

export async function authenticateApiKey(authorization: string | undefined): Promise<AuthenticatedApiKey | null> {
  if (process.env.BILLING_ENABLED === "true" && !process.env.STRIPE_PRICE_ID) return null;
  const match = authorization?.match(/^Bearer\s+(vc_(?:beta|live)_[A-Za-z0-9]+_[A-Za-z0-9_-]+)$/i);
  if (!match) return null;
  const plaintext = match[1];
  const prefixMatch = plaintext.match(/^(vc_(?:beta|live)_[A-Za-z0-9]+)/);
  if (!prefixMatch) return null;
  const [candidate] = await db.select({
    key: apiKeysTable,
    billingStatus: tenantsTable.billingStatus,
    billingPeriodStart: tenantsTable.billingPeriodStart,
    billingPeriodEnd: tenantsTable.billingPeriodEnd,
  })
    .from(apiKeysTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, apiKeysTable.tenantId))
    .where(and(
      eq(apiKeysTable.keyPrefix, prefixMatch[1]),
      isNull(apiKeysTable.revokedAt),
      ...(process.env.BILLING_ENABLED === "true" ? [activeEntitlementConditions()] : []),
    )).limit(1);
  if (
    !candidate
    || (candidate.key.expiresAt && candidate.key.expiresAt.getTime() <= Date.now())
  ) return null;
  const expected = Buffer.from(candidate.key.keyHash, "hex");
  const actual = Buffer.from(hashKey(plaintext), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await db.update(apiKeysTable).set({ lastUsedAt: new Date() }).where(eq(apiKeysTable.id, candidate.key.id));
  return { id: candidate.key.id, tenantId: candidate.key.tenantId, scopes: candidate.key.scopes };
}

export async function revokeApiKey(tenantId: string, actorId: string, id: number): Promise<boolean> {
  return db.transaction(async (tx) => revokeApiKeyInTransaction(tx, tenantId, actorId, id));
}

export async function revokeApiKeyInTransaction(tx: any, tenantId: string, actorId: string, id: number): Promise<boolean> {
  const [revoked] = await tx.update(apiKeysTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeysTable.id, id), eq(apiKeysTable.tenantId, tenantId), isNull(apiKeysTable.revokedAt)))
    .returning();
  if (!revoked) return false;
  await tx.insert(auditEventsTable).values({
    tenantId,
    actorId,
    action: "api_key.revoked",
    metadata: { keyId: id },
  });
  return true;
}