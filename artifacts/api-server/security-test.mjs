import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = await mkdtemp(join(tmpdir(), "vendor-compare-security-tests-"));
try {
  await build({
    entryPoints: ["src/lib/security.test.ts"],
    outdir,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      ...(process.env.TEST_NAME_PATTERN
        ? ["--test-name-pattern", process.env.TEST_NAME_PATTERN]
        : []),
      join(outdir, "security.test.js"),
    ],
    { stdio: "inherit", env: { ...process.env, NODE_ENV: "production" } },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outdir, { recursive: true, force: true });
}