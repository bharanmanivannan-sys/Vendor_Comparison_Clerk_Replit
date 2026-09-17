import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "vendor-compare-intent-eval-"));
try {
  const outfile = join(outdir, "intent.eval.mjs");
  await build({
    entryPoints: ["src/lib/intent.eval.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const result = spawnSync(process.execPath, [outfile], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}