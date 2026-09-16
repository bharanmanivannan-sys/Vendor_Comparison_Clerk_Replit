import test from "node:test";
import assert from "node:assert/strict";
import { deriveBillingPeriod } from "./billingPeriod";
import {
  chooseVerifiedStripeEntitlement,
  isVerifiedStripeEntitlement,
  resolveTenantStripeEntitlement,
} from "./stripeEntitlement";

test("derives a current period from supported provider billing fields", () => {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString();
  const period = deriveBillingPeriod(
    { created_at: start, current_period_end: end },
    { paid_at: start },
  );
  assert.equal(period?.periodStart.toISOString(), start);
  assert.equal(period?.periodEnd.toISOString(), end);
});

test("rejects expired and malformed provider periods", () => {
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(deriveBillingPeriod({ created_at: past, current_period_end: past }, { paid_at: past }), null);
  assert.equal(deriveBillingPeriod({ created_at: "invalid", current_period_end: "invalid" }, { paid_at: null }), null);
});

const verifiedStripeInput = {
  subscriptionStatus: "active",
  sessionPaymentStatus: "paid",
  invoiceStatus: "paid",
  amountPaid: 4900,
  chargeRefunded: false,
  amountRefunded: 0,
  tenantMatches: true,
  itemPriceId: "price_commercial",
  configuredPriceId: "price_commercial",
  hasCurrentPeriod: true,
};

test("activates only a fully verified Stripe entitlement", () => {
  assert.equal(isVerifiedStripeEntitlement(verifiedStripeInput), true);
});

test("rejects wrong tenant, wrong price, unpaid, refunded, and expired Stripe entitlements", () => {
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, tenantMatches: false }), false);
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, itemPriceId: "price_other" }), false);
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, sessionPaymentStatus: "unpaid" }), false);
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, chargeRefunded: true }), false);
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, amountRefunded: 4900 }), false);
  assert.equal(isVerifiedStripeEntitlement({ ...verifiedStripeInput, hasCurrentPeriod: false }), false);
});

test("keeps a paid older subscription active when a newer checkout is pending or abandoned", () => {
  const paidOld = { verified: true, id: "paid-old", actor: "admin-a" };
  const pendingNew = { verified: false, id: "pending-new", actor: "admin-a" };
  assert.equal(chooseVerifiedStripeEntitlement([pendingNew, paidOld])?.id, "paid-old");
});

test("keeps any valid tenant subscription active across multiple admins", () => {
  const abandonedByAdminB = { verified: false, id: "pending-b", actor: "admin-b" };
  const activeByAdminA = { verified: true, id: "active-a", actor: "admin-a" };
  assert.equal(chooseVerifiedStripeEntitlement([abandonedByAdminB, activeByAdminA])?.id, "active-a");
  assert.equal(chooseVerifiedStripeEntitlement([abandonedByAdminB]), null);
});

test("does not revoke access when an active mapping lookup fails and a pending mapping succeeds", () => {
  const pending = { verified: false, id: "pending" };
  assert.deepEqual(resolveTenantStripeEntitlement([pending], 1), { status: "indeterminate" });
});

test("downgrades only after every mapping is successfully checked and none is valid", () => {
  const canceled = { verified: false, id: "canceled" };
  const abandoned = { verified: false, id: "abandoned" };
  assert.deepEqual(resolveTenantStripeEntitlement([canceled, abandoned], 0), { status: "inactive" });
});