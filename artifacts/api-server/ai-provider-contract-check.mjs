import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "ai-provider-contract-check-"));
try {
  const outfile = join(outdir, "check.cjs");
  await build({
    entryPoints: ["src/aiProviderContractCheck.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: {
      "pg": "../../lib/db/node_modules/pg/lib/index.js",
    },
  });
  const result = spawnSync(process.execPath, [outfile], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}