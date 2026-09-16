export type StripeEntitlementInput = {
  subscriptionStatus: string | undefined;
  sessionPaymentStatus: string | undefined;
  invoiceStatus: string | undefined;
  amountPaid: number;
  chargeRefunded: boolean | undefined;
  amountRefunded: number;
  tenantMatches: boolean;
  itemPriceId: string | undefined;
  configuredPriceId: string;
  hasCurrentPeriod: boolean;
};

export function isVerifiedStripeEntitlement(input: StripeEntitlementInput): boolean {
  return Boolean(
    input.subscriptionStatus
    && ["active", "trialing"].includes(input.subscriptionStatus)
    && input.sessionPaymentStatus === "paid"
    && input.invoiceStatus === "paid"
    && input.amountPaid > 0
    && input.chargeRefunded !== true
    && input.amountRefunded === 0
    && input.tenantMatches
    && input.itemPriceId === input.configuredPriceId
    && input.hasCurrentPeriod,
  );
}

export function chooseVerifiedStripeEntitlement<T extends { verified: boolean }>(candidates: T[]): T | null {
  return candidates.find((candidate) => candidate.verified) ?? null;
}

export function resolveTenantStripeEntitlement<T extends { verified: boolean }>(
  candidates: T[],
  failedChecks: number,
): { status: "active"; candidate: T } | { status: "inactive" } | { status: "indeterminate" } {
  const candidate = chooseVerifiedStripeEntitlement(candidates);
  if (candidate) return { status: "active", candidate };
  if (failedChecks > 0) return { status: "indeterminate" };
  return { status: "inactive" };
}