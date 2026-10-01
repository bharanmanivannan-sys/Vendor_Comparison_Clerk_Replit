import assert from "node:assert/strict";
import test from "node:test";
import {
  createVerificationAccessService,
  isConfiguredVerificationPlan,
  isValidVerificationPayment,
  type VerificationAccessDependencies,
  type VerificationCheckoutBinding,
  type VerificationPlan,
  type VerificationPayment,
} from "./verificationAccess";

const config = { accountId: "biz_test", planId: "plan_test" };
const binding: VerificationCheckoutBinding = {
  userId: "clerk-user-a",
  comparisonId: 31,
  accountId: config.accountId,
  planId: config.planId,
  checkoutConfigurationId: "ch_test_a",
  createdAt: new Date("2025-01-01T00:00:00.000Z"),
};
const paidPayment: VerificationPayment = {
  id: "pay_test_a",
  account_id: config.accountId,
  checkout_configuration_id: binding.checkoutConfigurationId,
  plan_id: config.planId,
  status: "paid",
  substatus: "succeeded",
  paid_at: "2025-01-01T00:01:00.000Z",
  refunded_at: null,
  refunded_amount: { amount: "0.00", currency: "aud", decimals: 2, display_decimals: 2 },
  auto_refunded: false,
  total: { amount: "20.00", currency: "aud", decimals: 2, display_decimals: 2 },
};
const plan: VerificationPlan = {
  id: config.planId,
  accountId: config.accountId,
  currency: "AUD",
  initialPrice: 20,
  billingPeriod: null,
  planType: "one_time",
  adaptivePricingEnabled: false,
};

function makeService(
  overrides: Partial<VerificationAccessDependencies> = {},
  serviceConfig: typeof config | null = config,
) {
  const dependencies: VerificationAccessDependencies = {
    isOwnedDecision: async (userId, comparisonId) => userId === binding.userId && comparisonId === binding.comparisonId,
    getBindings: async () => [binding],
    listPayments: async () => [],
    retrieveWhopPlan: async () => plan,
    createWhopCheckout: async () => ({ id: "ch_new", purchaseUrl: "https://whop.com/checkout/test" }),
    getReturnOrigin: () => "https://vendor-comparison-workspace.replit.app",
    insertBinding: async () => {},
    saveVerifiedPayment: async () => {},
    ...overrides,
  };
  return createVerificationAccessService(dependencies, () => serviceConfig);
}

test("verification access rejects users who do not own the saved decision", async () => {
  const service = makeService();
  await assert.rejects(
    service.getAccess("clerk-user-b", binding.comparisonId),
    /Saved decision not found/,
  );
});

test("missing Whop plan fails closed as not configured", async () => {
  const service = makeService({}, null);
  assert.equal(await service.getAccess(binding.userId, binding.comparisonId), "not_configured");
});

test("checkout accepts only the configured one-time AUD 20 plan", () => {
  assert.equal(isConfiguredVerificationPlan(plan, config.accountId, config.planId), true);
  assert.equal(isConfiguredVerificationPlan({ ...plan, currency: "USD" }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, initialPrice: 19.99 }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, initialPrice: 20.001 }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, planType: "renewal", billingPeriod: 30 }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, billingPeriod: 30 }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, adaptivePricingEnabled: true }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, accountId: "biz_other" }, config.accountId, config.planId), false);
  assert.equal(isConfiguredVerificationPlan({ ...plan, id: "plan_other" }, config.accountId, config.planId), false);
});

test("a mispriced or recurring plan is unavailable and cannot start checkout", async () => {
  let created = false;
  const service = makeService({
    retrieveWhopPlan: async () => ({ ...plan, initialPrice: 19 }),
    createWhopCheckout: async () => {
      created = true;
      return { id: "ch_new", purchaseUrl: "https://whop.com/checkout/test" };
    },
  });
  assert.equal(await service.getAccess(binding.userId, binding.comparisonId), "not_configured");
  await assert.rejects(service.createCheckout(binding.userId, binding.comparisonId), /checkout is not configured/i);
  assert.equal(created, false);
});

test("a checkout redirect or unpaid payment does not grant access", async () => {
  const service = makeService({
    listPayments: async () => [{
      ...paidPayment,
      status: "pending",
      substatus: "pending",
      paid_at: null,
    }],
  });
  assert.equal(await service.getAccess(binding.userId, binding.comparisonId), "payment_required");
});

test("a paid payment for the exact owner, decision, account and plan grants access", async () => {
  const service = makeService({ listPayments: async () => [paidPayment] });
  assert.equal(await service.getAccess(binding.userId, binding.comparisonId), "active");
});

test("an already-paid decision cannot open or create another checkout", async () => {
  let created = false;
  let savedBinding = false;
  const service = makeService({
    listPayments: async () => [paidPayment],
    createWhopCheckout: async () => {
      created = true;
      return { id: "ch_duplicate", purchaseUrl: "https://whop.com/checkout/test" };
    },
    insertBinding: async () => { savedBinding = true; },
  });
  await assert.rejects(
    service.createCheckout(binding.userId, binding.comparisonId),
    /already has active verification access/i,
  );
  assert.equal(created, false);
  assert.equal(savedBinding, false);
});

test("hosted checkout redirects only to the configured origin and saved decision", async () => {
  let receivedRedirect = "";
  const service = makeService({
    createWhopCheckout: async (_accountId, _planId, redirectUrl) => {
      receivedRedirect = redirectUrl;
      return { id: "ch_redirect", purchaseUrl: "https://whop.com/checkout/test" };
    },
  });
  await service.createCheckout(binding.userId, binding.comparisonId);
  assert.equal(receivedRedirect, "https://vendor-comparison-workspace.replit.app/verify/31?checkout=return");
});

test("checkout is unavailable when no safe return origin is configured", async () => {
  let created = false;
  const service = makeService({
    getReturnOrigin: () => null,
    createWhopCheckout: async () => {
      created = true;
      return { id: "ch_new", purchaseUrl: "https://whop.com/checkout/test" };
    },
  });
  await assert.rejects(service.createCheckout(binding.userId, binding.comparisonId), /checkout is not configured/i);
  assert.equal(created, false);
});

test("refunded, mismatched-account, mismatched-plan, and other-checkout payments never grant access", () => {
  assert.equal(isValidVerificationPayment({ ...paidPayment, refunded_at: "2025-01-02T00:00:00.000Z" }, binding), false);
  assert.equal(isValidVerificationPayment({ ...paidPayment, refunded_amount: { ...paidPayment.refunded_amount!, amount: "10.00" } }, binding), false);
  assert.equal(isValidVerificationPayment({ ...paidPayment, auto_refunded: true }, binding), false);
  assert.equal(isValidVerificationPayment({ ...paidPayment, account_id: "biz_other" }, binding), false);
  assert.equal(isValidVerificationPayment({ ...paidPayment, plan_id: "plan_other" }, binding), false);
  assert.equal(isValidVerificationPayment({ ...paidPayment, checkout_configuration_id: "ch_other" }, binding), false);
});

test("Whop verification errors propagate instead of treating the user as paid", async () => {
  const service = makeService({
    listPayments: async () => { throw new Error("Whop unavailable"); },
  });
  await assert.rejects(service.getAccess(binding.userId, binding.comparisonId), /Whop unavailable/);
});