type StripeCheckoutSession = {
  id: string;
  url: string | null;
  payment_status: string;
  customer: string | { id: string } | null;
  subscription: StripeSubscription | string | null;
  metadata?: Record<string, string>;
};

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string | { id: string };
  metadata?: Record<string, string>;
  current_period_start?: number;
  current_period_end?: number;
  items?: { data?: Array<{ current_period_start?: number; current_period_end?: number; price?: { id?: string } }> };
  latest_invoice?: {
    id: string;
    status?: string;
    amount_paid?: number;
  } | string | null;
};

export type StripeInvoice = {
  id: string;
  status?: string;
  amount_paid?: number;
  payments?: { data?: Array<{
    status?: string;
    amount_paid?: number;
    payment?: { type?: string; payment_intent?: { status?: string; latest_charge?: string | null } };
  }> };
};

export type StripeCharge = { id: string; refunded?: boolean; amount_refunded?: number };

function connectorAuthorization(): { hostname: string; token: string } {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!hostname || !token) throw new Error("Stripe integration is not connected.");
  return { hostname, token };
}

async function stripeRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { hostname, token } = connectorAuthorization();
  const response = await fetch(`https://${hostname}/api/v2/proxy${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Replit-Token": token,
      "Connector-Name": "stripe",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? `Stripe request failed (${response.status}).`);
  return payload;
}

export async function createStripeCheckout(input: {
  tenantId: string; clerkUserId: string; priceId: string; redirectUrl: string;
}): Promise<StripeCheckoutSession> {
  const body = new URLSearchParams({
    mode: "subscription",
    success_url: `${input.redirectUrl}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: input.redirectUrl,
    client_reference_id: input.tenantId,
    "line_items[0][price]": input.priceId,
    "line_items[0][quantity]": "1",
    "metadata[tenantId]": input.tenantId,
    "metadata[clerkUserId]": input.clerkUserId,
    "subscription_data[metadata][tenantId]": input.tenantId,
    "subscription_data[metadata][clerkUserId]": input.clerkUserId,
  });
  return stripeRequest("/v1/checkout/sessions", { method: "POST", body });
}

export function retrieveStripeCheckout(id: string): Promise<StripeCheckoutSession> {
  const query = new URLSearchParams({ "expand[]": "subscription.latest_invoice" });
  return stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(id)}?${query}`);
}

export function retrieveStripeInvoice(id: string): Promise<StripeInvoice> {
  const query = new URLSearchParams({ "expand[]": "payments.data.payment.payment_intent" });
  return stripeRequest(`/v1/invoices/${encodeURIComponent(id)}?${query}`);
}

export function retrieveStripeCharge(id: string): Promise<StripeCharge> {
  return stripeRequest(`/v1/charges/${encodeURIComponent(id)}`);
}