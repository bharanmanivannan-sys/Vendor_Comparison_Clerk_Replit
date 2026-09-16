import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { apiKeysTable, auditEventsTable, db, tenantsTable } from "@workspace/db";
import { authenticateApiKey, createApiKey } from "./apiKeys";

test("free beta tenants can create and authenticate scoped bearer API keys", async () => {
  const tenantId = `beta_${randomUUID()}`;
  const previousBillingEnabled = process.env.BILLING_ENABLED;
  delete process.env.BILLING_ENABLED;
  await db.insert(tenantsTable).values({
    id: tenantId,
    name: "Beta API tenant",
    billingStatus: "inactive",
    includedComparisons: 100,
    requestsPerMinute: 30,
  });

  try {
    const created = await createApiKey({
      tenantId,
      actorId: "test-user",
      name: "Workflow beta key",
      scopes: ["comparisons:read", "comparisons:write"],
    });
    assert.match(created.key, /^vc_beta_[A-Za-z0-9]+_[A-Za-z0-9_-]+$/);

    const authenticated = await authenticateApiKey(`Bearer ${created.key}`);
    assert.equal(authenticated?.tenantId, tenantId);
    assert.deepEqual(authenticated?.scopes, ["comparisons:read", "comparisons:write"]);
  } finally {
    if (previousBillingEnabled === undefined) delete process.env.BILLING_ENABLED;
    else process.env.BILLING_ENABLED = previousBillingEnabled;
    await db.delete(auditEventsTable).where(eq(auditEventsTable.tenantId, tenantId));
    await db.delete(apiKeysTable).where(eq(apiKeysTable.tenantId, tenantId));
    await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
});