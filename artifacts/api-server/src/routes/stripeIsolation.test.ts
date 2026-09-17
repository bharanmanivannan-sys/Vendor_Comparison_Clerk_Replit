import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, tenantsTable } from "@workspace/db";
import app from "../app";

async function withApiServer(run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve());
    });
  }
}

test("retired Stripe flows cannot change either tenant's API entitlement", async () => {
  const tenantA = `stripe_isolation_a_${randomUUID()}`;
  const tenantB = `stripe_isolation_b_${randomUUID()}`;
  const tenantIds = [tenantA, tenantB];

  await db.insert(tenantsTable).values([
    {
      id: tenantA,
      name: "Stripe isolation tenant A",
      plan: "free",
      billingStatus: "inactive",
    },
    {
      id: tenantB,
      name: "Stripe isolation tenant B",
      plan: "free",
      billingStatus: "inactive",
    },
  ]);

  try {
    await withApiServer(async (baseUrl) => {
      const formerStripeRequests = [
        {
          description: "a paid checkout session for tenant A presented as tenant B",
          path: "/api/tenant/stripe/reconcile",
          body: { checkoutSessionId: `paid_for_${tenantA}`, tenantId: tenantB },
        },
        {
          description: "a success redirect without a verified session",
          path: "/api/stripe/checkout",
          body: { redirectUrl: "https://example.test/billing?success=true" },
        },
        {
          description: "an incomplete checkout session",
          path: "/api/tenant/stripe/reconcile",
          body: { checkoutSessionId: `incomplete_for_${tenantA}` },
        },
        {
          description: "a cancellation or refund reconciliation",
          path: "/api/tenant/stripe/reconcile",
          body: { checkoutSessionId: `canceled_or_refunded_for_${tenantA}` },
        },
      ];

      for (const request of formerStripeRequests) {
        const response = await fetch(`${baseUrl}${request.path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-tenant-id": tenantB,
          },
          body: JSON.stringify(request.body),
        });
        assert.equal(response.status, 404, request.description);
      }
    });

    const tenants = await db.select().from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    assert.equal(tenants.length, 2);
    for (const tenant of tenants) {
      assert.equal(tenant.plan, "free", `${tenant.id} plan`);
      assert.equal(tenant.billingStatus, "inactive", `${tenant.id} billing status`);
      assert.equal(tenant.billingPeriodStart, null, `${tenant.id} billing period start`);
      assert.equal(tenant.billingPeriodEnd, null, `${tenant.id} billing period end`);
    }
  } finally {
    await db.delete(tenantsTable).where(inArray(tenantsTable.id, tenantIds));
  }
});