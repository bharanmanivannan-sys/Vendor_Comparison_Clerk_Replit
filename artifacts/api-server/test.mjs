import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "vendor-compare-api-tests-"));
try {
  await build({
    entryPoints: [
      "src/lib/analysis.test.ts",
      "src/services/billing.test.ts",
      "src/services/idempotency.test.ts",
      "src/routes/commercial.test.ts",
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
    ["--test", join(outdir, "lib/analysis.test.js"), join(outdir, "services/billing.test.js"), join(outdir, "services/idempotency.test.js"), join(outdir, "routes/commercial.test.js")],
    { stdio: "inherit", env: process.env },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}