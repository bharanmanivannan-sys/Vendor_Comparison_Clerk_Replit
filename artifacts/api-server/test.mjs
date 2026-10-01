import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "vendor-compare-api-tests-"));
try {
  await build({
    entryPoints: [
      "src/app.test.ts",
      "src/lib/analysis.test.ts",
      "src/lib/comparisonClassification.discovery.test.ts",
      "src/lib/comparisonDraftParser.criteria.test.ts",
      "src/lib/preliminaryScorecardCache.test.ts",
      "src/lib/decisionScoringProvider.test.ts",
      "src/lib/researchCapacityAlerts.test.ts",
      "src/lib/searchApi.reliability.test.ts",
      "src/lib/firecrawlSearch.test.ts",
      "src/lib/quotePricing.test.ts",
      "src/lib/quoteObjects.test.ts",
      "src/lib/evidenceReview.test.ts",
      "src/lib/security.test.ts",
      "src/lib/marketSuggestionVerification.test.ts",
      "src/lib/comparisonQueryInput.test.ts",
      "src/services/idempotency.test.ts",
      "src/services/comparisonPersistence.test.ts",
      "src/services/comparisonJobCheckpoints.test.ts",
      "src/services/relevanceGateCheckpoints.test.ts",
      "src/services/draftGateReuse.test.ts",
      "src/services/visitorSessions.test.ts",
      "src/services/publisherPermissionPolicy.test.ts",
      "src/services/sourcePreflight.test.ts",
      "src/routes/commercial.test.ts",
      "src/routes/quotes.test.ts",
      "src/routes/comparisons.test.ts",
      "src/routes/comparisonDomainIntake.test.ts",
      "src/routes/comparisonDrafts.test.ts",
      "src/routes/stripeIsolation.test.ts",
      "src/services/apiKeys.test.ts",
      "src/services/aiProviderContracts.test.ts",
    ],
    outdir,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: {
      "@workspace/db": "./src/test/db.ts",
      "pg": "../../lib/db/node_modules/pg/lib/index.js",
    },
  });
  const result = spawnSync(
    process.execPath,
    ["--test", join(outdir, "app.test.js"), join(outdir, "lib/analysis.test.js"), join(outdir, "lib/comparisonClassification.discovery.test.js"), join(outdir, "lib/comparisonDraftParser.criteria.test.js"), join(outdir, "lib/preliminaryScorecardCache.test.js"), join(outdir, "lib/decisionScoringProvider.test.js"), join(outdir, "lib/researchCapacityAlerts.test.js"), join(outdir, "lib/searchApi.reliability.test.js"), join(outdir, "lib/firecrawlSearch.test.js"), join(outdir, "lib/quotePricing.test.js"), join(outdir, "lib/quoteObjects.test.js"), join(outdir, "lib/evidenceReview.test.js"), join(outdir, "lib/security.test.js"), join(outdir, "lib/marketSuggestionVerification.test.js"), join(outdir, "lib/comparisonQueryInput.test.js"), join(outdir, "services/apiKeys.test.js"), join(outdir, "services/aiProviderContracts.test.js"), join(outdir, "services/idempotency.test.js"), join(outdir, "services/comparisonPersistence.test.js"), join(outdir, "services/comparisonJobCheckpoints.test.js"), join(outdir, "services/relevanceGateCheckpoints.test.js"), join(outdir, "services/draftGateReuse.test.js"), join(outdir, "services/visitorSessions.test.js"), join(outdir, "services/publisherPermissionPolicy.test.js"), join(outdir, "services/sourcePreflight.test.js"), join(outdir, "routes/commercial.test.js"), join(outdir, "routes/quotes.test.js"), join(outdir, "routes/comparisons.test.js"), join(outdir, "routes/comparisonDomainIntake.test.js"), join(outdir, "routes/comparisonDrafts.test.js"), join(outdir, "routes/stripeIsolation.test.js")],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}