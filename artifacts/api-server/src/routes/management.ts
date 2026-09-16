import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq } from "drizzle-orm";
import {
  BootstrapTenantResponse, ReconcileStripeBillingBody, CreateTenantApiKeyBody, CreateTenantApiKeyResponse,
  CreateStripeCheckoutBody, CreateStripeCheckoutResponse, GetTenantUsageResponse,
  ListTenantApiKeysResponse, RevokeTenantApiKeyParams, RotateTenantApiKeyParams,
  RotateTenantApiKeyResponse,
} from "@workspace/api-zod";
import { apiKeysTable, auditEventsTable, db, stripeSubscriptionsTable } from "@workspace/db";
import { createApiKey, createApiKeyInTransaction, revokeApiKey, revokeApiKeyInTransaction } from "../services/apiKeys";
import { ensurePersonalTenant, getAdminTenant } from "../services/tenant";
import { getUsage } from "../services/usage";
import { createStripeCheckout } from "../lib/stripeClient";
import { reconcileStripeTenant } from "../services/billing";

type ClerkRequest = Request & { clerkUserId?: string; tenantId?: string };
const router: IRouter = Router();

function structuredError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ code, message });
}

function requireClerk(req: ClerkRequest, res: Response, next: NextFunction): void {
  const userId = getAuth(req).userId;
  if (!userId) {
    structuredError(res, 401, "unauthorized", "A signed-in Clerk session is required.");
    return;
  }
  req.clerkUserId = userId;
  next();
}

async function requireAdmin(req: ClerkRequest, res: Response): Promise<{ tenantId: string; actorId: string } | null> {
  const actorId = req.clerkUserId!;
  const tenantId = req.header("X-Tenant-Id");
  if (!tenantId) {
    structuredError(res, 400, "tenant_id_required", "X-Tenant-Id is required for tenant management.");
    return null;
  }
  const tenant = await getAdminTenant(actorId, tenantId);
  if (!tenant) {
    structuredError(res, 403, "tenant_admin_required", "Tenant owner or admin access is required.");
    return null;
  }
  req.tenantId = tenantId;
  return { tenantId, actorId };
}

function keyMetadata(row: typeof apiKeysTable.$inferSelect) {
  return {
    id: row.id, name: row.name, prefix: row.keyPrefix, scopes: row.scopes,
    expiresAt: row.expiresAt, revokedAt: row.revokedAt, lastUsedAt: row.lastUsedAt, createdAt: row.createdAt,
  };
}

router.post("/tenant/bootstrap", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const tenant = await ensurePersonalTenant(req.clerkUserId!);
  res.json(BootstrapTenantResponse.parse(tenant));
});

router.get("/tenant/usage", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  res.json(GetTenantUsageResponse.parse(await getUsage(admin.tenantId)));
});

router.get("/tenant/audit", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
  const events = await db.select().from(auditEventsTable)
    .where(eq(auditEventsTable.tenantId, admin.tenantId))
    .orderBy(desc(auditEventsTable.createdAt)).limit(limit);
  res.json(events);
});

router.get("/tenant/api-keys", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const keys = await db.select().from(apiKeysTable).where(eq(apiKeysTable.tenantId, admin.tenantId));
  res.json(ListTenantApiKeysResponse.parse(keys.map(keyMetadata)));
});

router.post("/tenant/api-keys", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = CreateTenantApiKeyBody.safeParse(req.body);
  if (!parsed.success) {
    structuredError(res, 400, "invalid_request", parsed.error.message);
    return;
  }
  try {
    const created = await createApiKey({ ...admin, ...parsed.data });
    res.status(201).json(CreateTenantApiKeyResponse.parse({ ...keyMetadata(created.record), key: created.key }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not create API key.";
    structuredError(res, message.includes("billing is inactive") ? 403 : 400, message.includes("billing is inactive") ? "billing_inactive" : "invalid_scope", message);
  }
});

router.post("/tenant/api-keys/:id/rotate", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = RotateTenantApiKeyParams.safeParse(req.params);
  if (!parsed.success) {
    structuredError(res, 400, "invalid_id", "API key id must be an integer.");
    return;
  }
  let created: Awaited<ReturnType<typeof createApiKey>>;
  try {
    created = await db.transaction(async (tx) => {
      const [old] = await tx.select().from(apiKeysTable).where(and(eq(apiKeysTable.id, parsed.data.id), eq(apiKeysTable.tenantId, admin.tenantId)));
      if (!old || old.revokedAt) throw new Error("API_KEY_NOT_FOUND");
      if (!(await revokeApiKeyInTransaction(tx, admin.tenantId, admin.actorId, old.id))) {
        throw new Error("API_KEY_NOT_FOUND");
      }
      return createApiKeyInTransaction(tx, {
        tenantId: admin.tenantId, actorId: admin.actorId, name: old.name, scopes: old.scopes, expiresAt: old.expiresAt,
      });
    });
  } catch (cause) {
    if (cause instanceof Error && cause.message === "API_KEY_NOT_FOUND") {
      structuredError(res, 404, "not_found", "API key not found.");
      return;
    }
    if (cause instanceof Error && cause.message.includes("billing is inactive")) {
      structuredError(res, 403, "billing_inactive", cause.message);
      return;
    }
    throw cause;
  }
  res.status(201).json(RotateTenantApiKeyResponse.parse({ ...keyMetadata(created.record), key: created.key }));
});

router.post("/tenant/api-keys/:id/revoke", requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = RevokeTenantApiKeyParams.safeParse(req.params);
  if (!parsed.success || !(await revokeApiKey(admin.tenantId, admin.actorId, parsed.data.id))) {
    structuredError(res, 404, "not_found", "API key not found.");
    return;
  }
  res.sendStatus(204);
});

router.post(["/stripe/checkout", "/whop/checkout"], requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  if (process.env.BILLING_ENABLED !== "true") {
    structuredError(res, 503, "billing_disabled", "Paid subscriptions are not currently available.");
    return;
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = CreateStripeCheckoutBody.safeParse(req.body);
  if (!parsed.success) {
    structuredError(res, 400, "invalid_request", parsed.error.message);
    return;
  }
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!priceId) {
    structuredError(res, 503, "billing_not_configured", "Stripe checkout requires verified STRIPE_PRICE_ID configuration.");
    return;
  }
  try {
    const checkout = await createStripeCheckout({
      tenantId: admin.tenantId,
      clerkUserId: admin.actorId,
      priceId,
      redirectUrl: parsed.data.redirectUrl,
    });
    const purchaseUrl = checkout.url;
    if (!purchaseUrl || !checkout.id) throw new Error("Stripe did not return a hosted checkout.");
    await db.transaction(async (tx) => {
      await tx.insert(stripeSubscriptionsTable).values({
        tenantId: admin.tenantId,
        clerkUserId: admin.actorId,
        checkoutSessionId: checkout.id,
        priceId,
        status: "pending",
      });
      await tx.insert(auditEventsTable).values({
        tenantId: admin.tenantId,
        actorId: admin.actorId,
        action: "billing.checkout_created",
        metadata: { checkoutSessionId: checkout.id, priceId, provider: "stripe" },
      });
    });
    res.status(201).json(CreateStripeCheckoutResponse.parse({ purchaseUrl }));
  } catch (cause) {
    structuredError(res, 503, "billing_unavailable", cause instanceof Error ? cause.message : "Stripe checkout is unavailable.");
  }
});

router.post(["/tenant/stripe/reconcile", "/tenant/whop/reconcile"], requireClerk, async (req: ClerkRequest, res): Promise<void> => {
  if (process.env.BILLING_ENABLED !== "true") {
    structuredError(res, 503, "billing_disabled", "Paid subscriptions are not currently available.");
    return;
  }
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  if (!process.env.STRIPE_PRICE_ID) {
    structuredError(res, 503, "billing_not_configured", "Stripe billing reconciliation requires verified configuration.");
    return;
  }
  try {
    const parsed = ReconcileStripeBillingBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      structuredError(res, 400, "invalid_request", parsed.error.message);
      return;
    }
    const result = await reconcileStripeTenant(admin.tenantId, parsed.data.checkoutSessionId);
    res.json(result);
  } catch (cause) {
    structuredError(res, 503, "billing_unavailable", cause instanceof Error ? cause.message : "Stripe reconciliation is unavailable.");
  }
});

export default router;