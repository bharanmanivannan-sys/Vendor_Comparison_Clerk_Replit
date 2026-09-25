import { and, desc, eq } from "drizzle-orm";
import { comparisonsTable, db, verificationCheckoutsTable } from "@workspace/db";
import type { Whop } from "@whop/sdk";
import { getWhopClient } from "./whopClient";

export type VerificationAccess = "active" | "payment_required" | "not_configured";
export const VERIFICATION_PRICE_AMOUNT = 20;
export const VERIFICATION_PRICE_CURRENCY = "aud";

export type VerificationPlan = {
  id: string;
  accountId: string | null;
  currency: string;
  initialPrice: number;
  billingPeriod: number | null;
  planType: string;
  adaptivePricingEnabled: boolean;
};

export function isConfiguredVerificationPlan(
  plan: VerificationPlan,
  accountId: string,
  planId: string,
): boolean {
  return plan.id === planId
    && plan.accountId === accountId
    && plan.currency.toLowerCase() === VERIFICATION_PRICE_CURRENCY
    && Number.isFinite(plan.initialPrice)
    && Math.abs(plan.initialPrice * 100 - VERIFICATION_PRICE_AMOUNT * 100) < 0.000001
    && plan.planType === "one_time"
    && plan.billingPeriod === null
    && !plan.adaptivePricingEnabled;
}

export type VerificationPayment = Pick<
  Whop.Payment,
  | "id"
  | "account_id"
  | "checkout_configuration_id"
  | "plan_id"
  | "status"
  | "substatus"
  | "paid_at"
  | "refunded_at"
  | "refunded_amount"
  | "auto_refunded"
  | "total"
>;

export type VerificationCheckoutBinding = {
  userId: string;
  comparisonId: number;
  accountId: string;
  planId: string;
  checkoutConfigurationId: string;
  createdAt: Date;
};

export class VerificationComparisonNotFoundError extends Error {
  constructor() {
    super("Saved decision not found.");
    this.name = "VerificationComparisonNotFoundError";
  }
}

export class VerificationAccessRequiredError extends Error {
  readonly access: Exclude<VerificationAccess, "active">;

  constructor(access: Exclude<VerificationAccess, "active">) {
    super(access === "not_configured" ? "Verification checkout is not configured." : "Payment is required to verify this decision.");
    this.name = "VerificationAccessRequiredError";
    this.access = access;
  }
}

export class VerificationAlreadyPaidError extends Error {
  constructor() {
    super("This saved decision already has active verification access.");
    this.name = "VerificationAlreadyPaidError";
  }
}

export type VerificationCheckoutResult = {
  id: string;
  purchaseUrl: string;
};

export type VerificationAccessDependencies = {
  isOwnedDecision(userId: string, comparisonId: number): Promise<boolean>;
  getBindings(userId: string, comparisonId: number): Promise<VerificationCheckoutBinding[]>;
  listPayments(binding: VerificationCheckoutBinding): Promise<VerificationPayment[]>;
  retrieveWhopPlan(accountId: string, planId: string): Promise<VerificationPlan>;
  createWhopCheckout(accountId: string, planId: string, redirectUrl: string): Promise<VerificationCheckoutResult>;
  getReturnOrigin(): string | null;
  insertBinding(binding: VerificationCheckoutBinding): Promise<void>;
  saveVerifiedPayment(binding: VerificationCheckoutBinding, payment: VerificationPayment): Promise<void>;
};

export type VerificationBillingConfig = {
  accountId: string;
  planId: string;
};

export function isValidVerificationPayment(
  payment: VerificationPayment,
  binding: VerificationCheckoutBinding,
): boolean {
  const refundedAmount = payment.refunded_amount?.amount;
  const total = payment.total?.amount;
  return payment.id.length > 0
    && payment.account_id === binding.accountId
    && payment.checkout_configuration_id === binding.checkoutConfigurationId
    && payment.plan_id === binding.planId
    && payment.status === "paid"
    && payment.substatus === "succeeded"
    && Boolean(payment.paid_at)
    && payment.refunded_at === null
    && payment.auto_refunded === false
    && (payment.refunded_amount === null || /^0(?:\.0+)?$/.test(refundedAmount ?? ""))
    && typeof total === "string"
    && Number.isFinite(Number(total))
    && Number(total) > 0;
}

export function createVerificationAccessService(
  dependencies: VerificationAccessDependencies,
  getConfig: () => VerificationBillingConfig | null,
) {
  async function assertDecisionOwner(userId: string, comparisonId: number): Promise<void> {
    if (!await dependencies.isOwnedDecision(userId, comparisonId)) {
      throw new VerificationComparisonNotFoundError();
    }
  }

  async function getAccess(userId: string, comparisonId: number): Promise<VerificationAccess> {
    await assertDecisionOwner(userId, comparisonId);
    const config = getConfig();
    if (!config) return "not_configured";
    const plan = await dependencies.retrieveWhopPlan(config.accountId, config.planId);
    if (!isConfiguredVerificationPlan(plan, config.accountId, config.planId)) return "not_configured";

    const bindings = await dependencies.getBindings(userId, comparisonId);
    for (const binding of bindings) {
      if (binding.accountId !== config.accountId || binding.planId !== config.planId) continue;
      const payments = await dependencies.listPayments(binding);
      const paidPayment = payments.find((payment) => isValidVerificationPayment(payment, binding));
      if (!paidPayment) continue;
      await dependencies.saveVerifiedPayment(binding, paidPayment);
      return "active";
    }
    return "payment_required";
  }

  async function createCheckout(userId: string, comparisonId: number): Promise<VerificationCheckoutResult> {
    const access = await getAccess(userId, comparisonId);
    if (access === "active") throw new VerificationAlreadyPaidError();
    if (access !== "payment_required") throw new VerificationAccessRequiredError("not_configured");
    const config = getConfig();
    if (!config) throw new VerificationAccessRequiredError("not_configured");
    const origin = dependencies.getReturnOrigin();
    if (!origin) throw new VerificationAccessRequiredError("not_configured");

    const redirectUrl = new URL(`/verify/${comparisonId}?checkout=return`, origin).toString();
    const checkout = await dependencies.createWhopCheckout(config.accountId, config.planId, redirectUrl);
    const purchaseUrl = new URL(checkout.purchaseUrl);
    if (purchaseUrl.protocol !== "https:"
      || !(purchaseUrl.hostname === "whop.com" || purchaseUrl.hostname.endsWith(".whop.com") || purchaseUrl.hostname.endsWith(".whop.me"))) {
      throw new Error("Whop returned an unexpected hosted checkout URL.");
    }

    await dependencies.insertBinding({
      userId,
      comparisonId,
      accountId: config.accountId,
      planId: config.planId,
      checkoutConfigurationId: checkout.id,
      createdAt: new Date(),
    });
    return { id: checkout.id, purchaseUrl: purchaseUrl.toString() };
  }

  async function requireAccess(userId: string, comparisonId: number): Promise<void> {
    const access = await getAccess(userId, comparisonId);
    if (access !== "active") throw new VerificationAccessRequiredError(access);
  }

  return { getAccess, createCheckout, requireAccess };
}

function readBillingConfig(): VerificationBillingConfig | null {
  const accountId = process.env.WHOP_COMPANY_ID?.trim();
  const planId = process.env.WHOP_PLAN_ID?.trim();
  if (!accountId || !planId) return null;
  return { accountId, planId };
}

const VERIFIED_PUBLISHED_ORIGIN = "https://vendor-comparison-workspace.replit.app";

/** Development redirects use only the workspace's TLS Replit dev origin; production uses the verified published URL. */
export function getVerificationReturnOrigin(): string | null {
  const developmentDomain = process.env.REPLIT_DEV_DOMAIN?.trim().toLowerCase();
  if (process.env.NODE_ENV === "development"
    && developmentDomain
    && /^[a-z0-9-]+\.replit\.dev$/.test(developmentDomain)) {
    return `https://${developmentDomain}`;
  }
  return VERIFIED_PUBLISHED_ORIGIN;
}

async function listWhopPayments(binding: VerificationCheckoutBinding): Promise<VerificationPayment[]> {
  const client = await getWhopClient();
  const createdAfter = new Date(binding.createdAt.getTime() - 60_000).toISOString();
  let page = await client.payments.list({
    account_id: binding.accountId,
    plan_id: binding.planId,
    created_after: createdAfter,
    first: 100,
    order: "created_at",
    direction: "asc",
  });
  const payments: VerificationPayment[] = [];
  let pages = 0;
  const maximumPages = 25;
  while (true) {
    payments.push(...page.data);
    pages += 1;
    if (!page.hasNextPage()) break;
    if (pages >= maximumPages) {
      throw new Error("Whop payment verification exceeded the safe pagination limit.");
    }
    page = await page.getNextPage();
  }
  return payments;
}

const service = createVerificationAccessService({
  isOwnedDecision: async (userId, comparisonId) => {
    const [row] = await db.select({ id: comparisonsTable.id }).from(comparisonsTable)
      .where(and(eq(comparisonsTable.id, comparisonId), eq(comparisonsTable.userId, userId)));
    return Boolean(row);
  },
  getBindings: async (userId, comparisonId) => db.select({
    userId: verificationCheckoutsTable.userId,
    comparisonId: verificationCheckoutsTable.comparisonId,
    accountId: verificationCheckoutsTable.accountId,
    planId: verificationCheckoutsTable.planId,
    checkoutConfigurationId: verificationCheckoutsTable.checkoutConfigurationId,
    createdAt: verificationCheckoutsTable.createdAt,
  }).from(verificationCheckoutsTable)
    .where(and(
      eq(verificationCheckoutsTable.userId, userId),
      eq(verificationCheckoutsTable.comparisonId, comparisonId),
    ))
    .orderBy(desc(verificationCheckoutsTable.createdAt)),
  listPayments: listWhopPayments,
  retrieveWhopPlan: async (accountId, planId) => {
    const client = await getWhopClient();
    const plan = await client.plans.retrieve({ id: planId });
    return {
      id: plan.id,
      accountId: plan.account?.id ?? null,
      currency: plan.currency,
      initialPrice: plan.initial_price,
      billingPeriod: plan.billing_period,
      planType: plan.plan_type,
      adaptivePricingEnabled: plan.adaptive_pricing_enabled,
    };
  },
  getReturnOrigin: getVerificationReturnOrigin,
  createWhopCheckout: async (accountId, planId, redirectUrl) => {
    const client = await getWhopClient();
    const checkout = await client.checkoutConfigurations.create({
      account_id: accountId,
      plan_id: planId,
      mode: "payment",
      redirect_url: redirectUrl,
    });
    if (!checkout.id || !checkout.purchase_url) {
      throw new Error("Whop did not return a hosted payment checkout URL.");
    }
    return { id: checkout.id, purchaseUrl: checkout.purchase_url };
  },
  insertBinding: async (binding) => {
    await db.insert(verificationCheckoutsTable).values(binding);
  },
  saveVerifiedPayment: async (binding, payment) => {
    await db.update(verificationCheckoutsTable).set({
      verifiedPaymentId: payment.id,
      verifiedAt: new Date(),
    }).where(and(
      eq(verificationCheckoutsTable.userId, binding.userId),
      eq(verificationCheckoutsTable.comparisonId, binding.comparisonId),
      eq(verificationCheckoutsTable.checkoutConfigurationId, binding.checkoutConfigurationId),
    ));
  },
}, readBillingConfig);

/** Re-checks Whop server-side on every call; a redirect or client-supplied ID never grants access. */
export function getVerificationAccess(userId: string, comparisonId: number): Promise<VerificationAccess> {
  return service.getAccess(userId, comparisonId);
}

/** Throws unless the saved decision is owned by the user and Whop confirms an unreversed payment. */
export function requireVerificationAccess(userId: string, comparisonId: number): Promise<void> {
  return service.requireAccess(userId, comparisonId);
}

export function createVerificationCheckout(userId: string, comparisonId: number): Promise<VerificationCheckoutResult> {
  return service.createCheckout(userId, comparisonId);
}