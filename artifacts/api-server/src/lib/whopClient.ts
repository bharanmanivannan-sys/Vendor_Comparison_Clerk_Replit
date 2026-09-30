import { WhopClient } from "@whop/sdk";

let clientPromise: Promise<WhopClient> | null = null;

async function initializeWhopClient(): Promise<WhopClient> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const identityToken = process.env.REPL_IDENTITY
    ? `repl ${process.env.REPL_IDENTITY}`
    : process.env.WEB_REPL_RENEWAL
      ? `depl ${process.env.WEB_REPL_RENEWAL}`
      : undefined;

  if (!hostname || !identityToken) {
    throw new Error("The Whop integration is not available in this server environment.");
  }

  const response = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=whop`,
    {
      headers: { Accept: "application/json", X_REPLIT_TOKEN: identityToken },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    throw new Error(`The Whop connection could not be loaded (${response.status}).`);
  }

  const payload = await response.json() as {
    items?: Array<{ settings?: { api_key?: string } }>;
  };
  const token = payload.items?.[0]?.settings?.api_key;
  if (!token) {
    throw new Error("The connected Whop integration does not contain an API credential.");
  }

  return new WhopClient({ token });
}

/** Fetches Whop credentials through the connected Replit integration; credentials never reach the client. */
export function getWhopClient(): Promise<WhopClient> {
  if (!clientPromise) {
    clientPromise = initializeWhopClient().catch((error: unknown) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}