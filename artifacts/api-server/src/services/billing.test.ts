import test from "node:test";
import assert from "node:assert/strict";
import { deriveBillingPeriod } from "./billingPeriod";

test("derives a current period from supported Whop payment and membership fields", () => {
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