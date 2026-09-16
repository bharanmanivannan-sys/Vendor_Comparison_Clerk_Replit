import app from "./app";
import { logger } from "./lib/logger";
import { reconcileAllStripeTenants } from "./services/billing";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  if (process.env.STRIPE_PRICE_ID) {
    const reconcile = async () => {
      try {
        const result = await reconcileAllStripeTenants();
        logger.info(result, "Stripe billing reconciliation completed");
      } catch (cause) {
        logger.error({ err: cause }, "Stripe billing reconciliation failed");
      }
    };
    void reconcile();
    const interval = setInterval(reconcile, 15 * 60 * 1000);
    interval.unref();
    server.on("close", () => clearInterval(interval));
  } else {
    logger.warn("Stripe billing reconciliation is disabled until STRIPE_PRICE_ID is configured");
  }
});
