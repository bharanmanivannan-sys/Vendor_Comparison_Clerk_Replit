export function deriveBillingPeriod(
  membership: { created_at: string; current_period_end: string | null },
  payment: { paid_at: string | null },
) {
  const periodStart = new Date(payment.paid_at ?? membership.created_at);
  const periodEnd = new Date(membership.current_period_end ?? "");
  const now = Date.now();
  if (
    !Number.isFinite(periodStart.getTime())
    || !Number.isFinite(periodEnd.getTime())
    || periodStart.getTime() > now
    || periodEnd.getTime() <= now
    || periodStart.getTime() >= periodEnd.getTime()
  ) return null;
  return { periodStart, periodEnd };
}