import { and, desc, eq } from "drizzle-orm";
import { db, stripeSubscriptionsTable, tenantsTable } from "@workspace/db";
import {
  retrieveStripeCharge,
  retrieveStripeCheckout,
  retrieveStripeInvoice,
  type StripeSubscription,
} from "../lib/stripeClient";
import { getUsageForExecutor } from "./usage";
import { isVerifiedStripeEntitlement, resolveTenantStripeEntitlement } from "./stripeEntitlement";

function idOf(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function subscriptionPeriod(subscription: StripeSubscription): { periodStart: Date; periodEnd: Date } | null {
  const item = subscription.items?.data?.[0];
  const start = subscription.current_period_start ?? item?.current_period_start;
  const end = subscription.current_period_end ?? item?.current_period_end;
  if (!start || !end) return null;
  const periodStart = new Date(start * 1000);
  const periodEnd = new Date(end * 1000);
  const now = Date.now();
  return periodStart.getTime() <= now && periodEnd.getTime() > now ? { periodStart, periodEnd } : null;
}

export async function reconcileStripeTenant(tenantId: string, checkoutSessionId?: string) {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) throw new Error("Stripe billing is not configured.");
  const mappings = await db.select().from(stripeSubscriptionsTable).where(and(
    eq(stripeSubscriptionsTable.tenantId, tenantId),
    eq(stripeSubscriptionsTable.priceId, priceId),
  )).orderBy(desc(stripeSubscriptionsTable.id));
  if (!mappings.length) throw new Error("No stored Stripe checkout exists for this tenant.");
  if (checkoutSessionId && !mappings.some((mapping) => mapping.checkoutSessionId === checkoutSessionId)) {
    throw new Error("The returned Stripe checkout does not belong to this tenant.");
  }

  const orderedMappings = checkoutSessionId
    ? [...mappings].sort((a, b) => Number(b.checkoutSessionId === checkoutSessionId) - Number(a.checkoutSessionId === checkoutSessionId))
    : mappings;
  const candidates: Array<{ verified: boolean; id: string; periodStart: Date | null; periodEnd: Date | null }> = [];
  let anyPastDue = false;
  let successfulChecks = 0;
  let failedChecks = 0;
  for (const mapping of orderedMappings) {
    try {
      const session = await retrieveStripeCheckout(mapping.checkoutSessionId);
      const subscription = typeof session.subscription === "object" ? session.subscription : null;
      const embeddedInvoice = subscription && typeof subscription.latest_invoice === "object" ? subscription.latest_invoice : null;
      const invoice = embeddedInvoice ? await retrieveStripeInvoice(embeddedInvoice.id) : null;
      const invoicePayment = invoice?.payments?.data?.find((candidate) =>
        candidate.status === "paid" && candidate.payment?.payment_intent?.status === "succeeded"
      );
      const chargeId = invoicePayment?.payment?.payment_intent?.latest_charge;
      const charge = chargeId ? await retrieveStripeCharge(chargeId) : null;
      const period = subscription ? subscriptionPeriod(subscription) : null;
      const providerStatus = subscription?.status ?? "unverified";
      const active = isVerifiedStripeEntitlement({
        subscriptionStatus: subscription?.status,
        sessionPaymentStatus: session.payment_status,
        invoiceStatus: invoice?.status,
        amountPaid: Number(invoice?.amount_paid ?? 0),
        chargeRefunded: charge?.refunded,
        amountRefunded: Number(charge?.amount_refunded ?? 0),
        tenantMatches: session.metadata?.tenantId === tenantId && subscription?.metadata?.tenantId === tenantId,
        itemPriceId: subscription?.items?.data?.[0]?.price?.id,
        configuredPriceId: priceId,
        hasCurrentPeriod: Boolean(period),
      });
      successfulChecks += 1;
      anyPastDue ||= /past_due|unpaid/i.test(providerStatus);
      candidates.push({
        verified: active,
        id: subscription?.id ?? mapping.checkoutSessionId,
        periodStart: period?.periodStart ?? null,
        periodEnd: period?.periodEnd ?? null,
      });
      await db.update(stripeSubscriptionsTable).set({
        stripeCustomerId: idOf(session.customer),
        stripeSubscriptionId: subscription?.id ?? null,
        status: active ? "active" : providerStatus,
        currentPeriodStart: period?.periodStart ?? null,
        currentPeriodEnd: period?.periodEnd ?? null,
        verifiedAt: active ? new Date() : null,
        lastCheckedAt: new Date(),
      }).where(eq(stripeSubscriptionsTable.id, mapping.id));
    } catch {
      // A provider failure is not proof that an existing entitlement ended.
      failedChecks += 1;
    }
  }
  if (successfulChecks === 0) throw new Error("Stripe could not verify any checkout for this tenant.");
  const decision = resolveTenantStripeEntitlement(candidates, failedChecks);
  if (decision.status === "indeterminate") {
    throw new Error("Stripe could not conclusively verify that this tenant's entitlement ended.");
  }
  const activeSubscription = decision.status === "active" ? decision.candidate : null;
  const active = Boolean(activeSubscription);
  const billingStatus = active ? "active" : anyPastDue ? "past_due" : "inactive";

  await db.transaction(async (tx) => {
    await tx.update(tenantsTable).set({
      plan: active ? "commercial" : "free",
      billingStatus,
      billingReconciliationStatus: active ? "verified" : anyPastDue ? "stripe_past_due" : "stripe_inactive",
      billingPeriodStart: activeSubscription?.periodStart ?? null,
      billingPeriodEnd: activeSubscription?.periodEnd ?? null,
      billingReconciledAt: new Date(),
    }).where(eq(tenantsTable.id, tenantId));
    if (active) {
      const usage = await getUsageForExecutor(tx, tenantId);
      await tx.update(tenantsTable).set({ billingUsage: usage.used, accruedOverageCents: 0 })
        .where(eq(tenantsTable.id, tenantId));
    }
  });
  return active
    ? { status: "active" as const, subscriptionId: activeSubscription!.id }
    : { status: "unverified" as const };
}

export async function reconcileAllStripeTenants() {
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) return { skipped: true as const, checked: 0, active: 0, unverified: 0, failed: 0 };
  const mappings = await db.select({ tenantId: stripeSubscriptionsTable.tenantId })
    .from(stripeSubscriptionsTable).where(eq(stripeSubscriptionsTable.priceId, priceId));
  const unique = [...new Map(mappings.map((row) => [row.tenantId, row])).values()];
  let active = 0, unverified = 0, failed = 0;
  for (const mapping of unique) {
    try {
      const result = await reconcileStripeTenant(mapping.tenantId);
      result.status === "active" ? active += 1 : unverified += 1;
    } catch {
      failed += 1;
    }
  }
  return { skipped: false as const, checked: unique.length, active, unverified, failed };
}