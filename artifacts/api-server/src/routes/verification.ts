import { getAuth } from "@clerk/express";
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  createVerificationCheckout,
  getVerificationAccess,
  VerificationAlreadyPaidError,
  VerificationAccessRequiredError,
  VerificationComparisonNotFoundError,
} from "../lib/verificationAccess";

type AuthenticatedRequest = Request & { userId?: string };
const router: IRouter = Router();

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const userId = getAuth(req)?.userId;
  if (!userId) {
    res.status(401).json({ error: { code: "unauthorized", message: "Unauthorized" } });
    return;
  }
  req.userId = userId;
  next();
}

function readComparisonId(req: Request, res: Response): number | null {
  const comparisonId = Number(req.params.id);
  if (!Number.isSafeInteger(comparisonId) || comparisonId <= 0) {
    res.status(400).json({ error: { code: "invalid_id", message: "A valid saved decision ID is required." } });
    return null;
  }
  return comparisonId;
}

function isRequestLike(value: unknown): value is AuthenticatedRequest {
  return typeof value === "object" && value !== null && "userId" in value;
}

router.get("/comparisons/:id/verification-access", requireAuth, async (rawReq, res): Promise<void> => {
  if (!isRequestLike(rawReq)) return;
  const comparisonId = readComparisonId(rawReq, res);
  if (comparisonId === null) return;

  try {
    const access = await getVerificationAccess(rawReq.userId as string, comparisonId);
    res.json({
      access,
      ...(access === "not_configured"
        ? { message: "Premium verification requires a configured, non-recurring AUD $20 Whop plan. Checkout is unavailable until the configured plan matches." }
        : {}),
    });
  } catch (error) {
    if (error instanceof VerificationComparisonNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: error.message } });
      return;
    }
    rawReq.log.error({ comparisonId, error: error instanceof Error ? error.message : String(error) }, "Verification access could not be confirmed");
    res.status(503).json({
      access: "not_configured",
      message: "Payment access could not be confirmed with Whop. Please try again.",
    });
  }
});

router.post("/comparisons/:id/verification-checkout", requireAuth, async (rawReq, res): Promise<void> => {
  if (!isRequestLike(rawReq)) return;
  const comparisonId = readComparisonId(rawReq, res);
  if (comparisonId === null) return;

  try {
    const checkout = await createVerificationCheckout(rawReq.userId as string, comparisonId);
    res.status(201).json({ purchaseUrl: checkout.purchaseUrl });
  } catch (error) {
    if (error instanceof VerificationAlreadyPaidError) {
      res.status(409).json({
        error: { code: "already_paid", message: "This saved decision already has active verification access." },
      });
      return;
    }
    if (error instanceof VerificationComparisonNotFoundError) {
      res.status(404).json({ error: { code: "not_found", message: error.message } });
      return;
    }
    if (error instanceof VerificationAccessRequiredError && error.access === "not_configured") {
      res.status(409).json({
        error: { code: "not_configured", message: "Premium verification is not configured on this server." },
      });
      return;
    }
    rawReq.log.error({ comparisonId, error: error instanceof Error ? error.message : String(error) }, "Verification checkout could not be created");
    res.status(503).json({
      error: { code: "checkout_unavailable", message: "Whop checkout could not be created. Please try again." },
    });
  }
});

export default router;