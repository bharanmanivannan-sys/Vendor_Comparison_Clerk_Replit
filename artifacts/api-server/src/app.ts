import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { quoteDeletionOutboxReady, retryQuotePdfDeletions } from "./lib/quoteObjects";
import { recoverComparisonJobs, sweepStaleComparisonJobs } from "./routes/comparisons";
import comparisonDraftsRouter, { recoverComparisonDraftEnrichmentJobs } from "./routes/comparisonDrafts";

const app: Express = express();

const runQuoteDeletionRetry = async () => {
  if (!await quoteDeletionOutboxReady()) {
    logger.warn("Private quote deletion outbox schema is not ready; retry deferred");
    return;
  }
  await retryQuotePdfDeletions((message, error) => logger.error({ message, error }, message));
};
void runQuoteDeletionRetry().catch((error) => logger.error({ error }, "Private quote deletion retry unavailable"));
const quoteDeletionRetryTimer = setInterval(() => {
  void runQuoteDeletionRetry().catch((error) => logger.error({ error }, "Private quote deletion retry unavailable"));
}, 60_000);
quoteDeletionRetryTimer.unref();

const runComparisonJobRecovery = async () => {
  await recoverComparisonJobs();
};
void runComparisonJobRecovery().catch((error) => {
  logger.error({ error }, "Comparison job recovery unavailable");
});
void recoverComparisonDraftEnrichmentJobs().catch((error) => {
  logger.error({ error }, "Comparison draft enrichment recovery unavailable");
});
const comparisonDraftEnrichmentRecoveryTimer = setInterval(() => {
  void recoverComparisonDraftEnrichmentJobs().catch((error) => {
    logger.error({ error }, "Comparison draft enrichment recovery unavailable");
  });
}, 15_000);
comparisonDraftEnrichmentRecoveryTimer.unref();
const comparisonJobLeaseSweepTimer = setInterval(() => {
  void sweepStaleComparisonJobs().catch((error) => {
    logger.error({ error }, "Comparison job lease sweep unavailable");
  });
}, 15_000);
comparisonJobLeaseSweepTimer.unref();

// API responses are dynamic and frequently authenticated. Express ETags can
// turn a fresh React Query request into a bodyless 304 after reload or tab
// inactivity, leaving the client with no data to render.
app.disable("etag");

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
}, comparisonDraftsRouter);

app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
}, router);

export default app;
