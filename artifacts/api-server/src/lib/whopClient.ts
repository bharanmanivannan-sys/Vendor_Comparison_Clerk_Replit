type WhopList<T> = { data: T[] };

type WhopPayment = {
  id: string;
  checkout_configuration_id: string | null;
  membership_id: string | null;
  paid_at: string | null;
  refunded_at: string | null;
  created_at?: string | null;
};

type WhopMembership = {
  id: string;
  user_id: string;
  status: string;
  current_period_end: string | null;
  created_at: string;
};

type WhopCheckoutConfiguration = {
  id: string;
  purchase_url: string;
};

type WhopClient = {
  checkoutConfigurations: {
    create(input: { account_id: string; plan_id: string; redirect_url: string }): Promise<WhopCheckoutConfiguration>;
  };
  payments: {
    list(input: { account_id: string; plan_id: string; first: number }): Promise<WhopList<WhopPayment>>;
  };
  memberships: {
    list(input: { account_id: string; plan_id: string; first: number }): Promise<WhopList<WhopMembership>>;
  };
};

function connectorAuthorization(): { hostname: string; token: string } {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : null;
  if (!hostname || !token) throw new Error("Whop integration is not connected.");
  return { hostname, token };
}

async function whopRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { hostname, token } = connectorAuthorization();
  const response = await fetch(`https://${hostname}/api/v2/proxy${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Replit-Token": token,
      "Connector-Name": "whop",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json() as T & { error?: { message?: string } };
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Whop request failed (${response.status}).`);
  }
  return payload;
}

function queryString(input: { account_id: string; plan_id: string; first: number }): string {
  return new URLSearchParams({
    company_id: input.account_id,
    plan_id: input.plan_id,
    first: String(input.first),
  }).toString();
}

const client: WhopClient = {
  checkoutConfigurations: {
    create: (input) => whopRequest("/api/v1/checkout_configurations", {
      method: "POST",
      body: JSON.stringify({
        company_id: input.account_id,
        plan_id: input.plan_id,
        redirect_url: input.redirect_url,
      }),
    }),
  },
  payments: {
    list: (input) => whopRequest(`/api/v1/payments?${queryString(input)}`),
  },
  memberships: {
    list: (input) => whopRequest(`/api/v1/memberships?${queryString(input)}`),
  },
};

export async function getWhopClient(): Promise<WhopClient> {
  connectorAuthorization();
  return client;
}