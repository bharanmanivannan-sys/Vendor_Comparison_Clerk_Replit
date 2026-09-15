import { and, desc, eq } from "drizzle-orm";
import { db, tenantsTable, whopMembershipsTable } from "@workspace/db";
import { getWhopClient } from "../lib/whopClient";
import { getUsageForExecutor } from "./usage";
import { deriveBillingPeriod } from "./billingPeriod";

export async function reconcileWhopTenant(tenantId: string, clerkUserId: string) {
  const companyId = process.env.WHOP_COMPANY_ID;
  const planId = process.env.WHOP_PLAN_ID;
  if (!companyId || !planId) throw new Error("Whop billing is not configured.");
  const [mapping] = await db.select().from(whopMembershipsTable)
    .where(and(
      eq(whopMembershipsTable.tenantId, tenantId),
      eq(whopMembershipsTable.clerkUserId, clerkUserId),
      eq(whopMembershipsTable.planId, planId),
    ))
    .orderBy(desc(whopMembershipsTable.id)).limit(1);
  if (!mapping) throw new Error("No stored Whop checkout exists for this tenant.");

  const client = await getWhopClient();
  const payments = await client.payments.list({ account_id: companyId, plan_id: planId, first: 100 });
  const payment = payments.data.filter((candidate) =>
    (candidate.checkout_configuration_id === mapping.checkoutConfigurationId
      || (mapping.whopMembershipId !== null && candidate.membership_id === mapping.whopMembershipId)) &&
    candidate.paid_at !== null &&
    candidate.refunded_at === null,
  ).sort((a, b) => new Date(b.paid_at!).getTime() - new Date(a.paid_at!).getTime())[0];
  if (!payment || !payment.membership_id) {
    await db.update(tenantsTable).set({
      billingStatus: mapping.status === "active" ? "past_due" : "inactive",
      billingReconciliationStatus: "unverified",
      billingReconciledAt: new Date(),
    }).where(eq(tenantsTable.id, tenantId));
    return { status: "unverified" as const };
  }
  const memberships = await client.memberships.list({ account_id: companyId, plan_id: planId, first: 100 });
  const membership = memberships.data.find((candidate) =>
    candidate.id === payment.membership_id &&
    ["active", "trialing"].includes(candidate.status) &&
    candidate.current_period_end !== null,
  );
  if (!membership) {
    await db.update(tenantsTable).set({
      billingStatus: "past_due",
      billingReconciliationStatus: "unverified",
      billingReconciledAt: new Date(),
    }).where(eq(tenantsTable.id, tenantId));
    return { status: "unverified" as const };
  }
  const period = deriveBillingPeriod(membership, payment);
  if (!period) {
    await db.update(tenantsTable).set({
      billingStatus: "past_due",
      billingReconciliationStatus: "invalid_period",
      billingReconciledAt: new Date(),
    }).where(eq(tenantsTable.id, tenantId));
    return { status: "unverified" as const };
  }
  const { periodStart, periodEnd } = period;
  await db.transaction(async (tx) => {
    await tx.update(whopMembershipsTable).set({
      whopMembershipId: membership.id,
      whopPaymentId: payment.id,
      whopUserId: membership.user_id,
      status: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      verifiedAt: new Date(),
      lastCheckedAt: new Date(),
    }).where(eq(whopMembershipsTable.id, mapping.id));
    await tx.update(tenantsTable).set({
      plan: "commercial",
      billingStatus: "active",
      billingReconciliationStatus: "verified",
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      billingReconciledAt: new Date(),
    }).where(eq(tenantsTable.id, tenantId));
    const usage = await getUsageForExecutor(tx, tenantId);
    await tx.update(tenantsTable).set({
      billingUsage: usage.used,
      accruedOverageCents: 0,
    }).where(eq(tenantsTable.id, tenantId));
  });
  return { status: "active" as const, membershipId: membership.id };
}