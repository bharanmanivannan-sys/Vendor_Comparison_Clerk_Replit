import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(
  new URL("./citation-transport-matrix.mjs", import.meta.url),
);

function runWithConfig(config) {
  const directory = mkdtempSync(join(tmpdir(), "citation-node-matrix-"));
  const configPath = join(directory, ".replit");
  writeFileSync(configPath, config);

  try {
    return spawnSync(process.execPath, [runnerPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        REPLIT_CONFIG_PATH: configPath,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertConfigurationFailure(config, expectedMessage) {
  const result = runWithConfig(config);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(expectedMessage));
  assert.doesNotMatch(
    result.stdout,
    /Citation transport compatibility/,
    "compatibility checks must not run after invalid configuration",
  );
}

test("reports a missing supported-major setting", () => {
  assertConfigurationFailure(
    'modules = ["nodejs-24"]\n',
    'Missing SUPPORTED_NODE_MAJORS in \\.replit; define it as a comma-separated list such as "20,22,24"\\.',
  );
});

test("reports an invalid supported major", () => {
  assertConfigurationFailure(
    'modules = ["nodejs-24"]\nSUPPORTED_NODE_MAJORS = "20,next,24"\n',
    'Invalid SUPPORTED_NODE_MAJORS value "20,next,24" in \\.replit; expected comma-separated positive integers\\.',
  );
});

test("reports an empty supported major", () => {
  assertConfigurationFailure(
    'modules = ["nodejs-24"]\nSUPPORTED_NODE_MAJORS = "20,,24"\n',
    'Invalid SUPPORTED_NODE_MAJORS value "20,,24" in \\.replit; expected comma-separated positive integers\\.',
  );
});

test("reports a deployment major absent from the supported list", () => {
  assertConfigurationFailure(
    'modules = ["nodejs-24"]\nSUPPORTED_NODE_MAJORS = "20,22"\n',
    'Node runtime support mismatch: \\.replit deploys Node 24, but SUPPORTED_NODE_MAJORS only lists 20, 22\\. Update the source-of-truth list before changing deployment support\\.',
  );
});