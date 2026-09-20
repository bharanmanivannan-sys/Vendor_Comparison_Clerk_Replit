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
      "src/lib/security.test.ts",
      "src/services/idempotency.test.ts",
      "src/services/visitorSessions.test.ts",
      "src/routes/commercial.test.ts",
      "src/routes/comparisons.test.ts",
      "src/routes/stripeIsolation.test.ts",
      "src/services/apiKeys.test.ts",
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
    ["--test", join(outdir, "app.test.js"), join(outdir, "lib/analysis.test.js"), join(outdir, "lib/security.test.js"), join(outdir, "services/apiKeys.test.js"), join(outdir, "services/idempotency.test.js"), join(outdir, "services/visitorSessions.test.js"), join(outdir, "routes/commercial.test.js"), join(outdir, "routes/comparisons.test.js"), join(outdir, "routes/stripeIsolation.test.js")],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}