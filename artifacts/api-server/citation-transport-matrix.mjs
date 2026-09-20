import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const replitConfigPath = fileURLToPath(new URL("../../.replit", import.meta.url));
const replitConfig = readFileSync(replitConfigPath, "utf8");
const supportedMajorsMatch = replitConfig.match(
  /^SUPPORTED_NODE_MAJORS\s*=\s*"([^"]+)"\s*$/m,
);
const deploymentNodeMatch = replitConfig.match(
  /^modules\s*=\s*\[[^\]]*"nodejs-(\d+)"[^\]]*\]\s*$/m,
);

if (!supportedMajorsMatch) {
  throw new Error(
    'Missing SUPPORTED_NODE_MAJORS in .replit; define it as a comma-separated list such as "20,22,24".',
  );
}
if (!deploymentNodeMatch) {
  throw new Error(
    "Unable to determine the deployment Node major from the .replit modules list.",
  );
}

const supportedNodeMajors = supportedMajorsMatch[1]
  .split(",")
  .map((value) => Number(value.trim()));

if (
  supportedNodeMajors.length === 0 ||
  supportedNodeMajors.some((major) => !Number.isSafeInteger(major) || major <= 0)
) {
  throw new Error(
    `Invalid SUPPORTED_NODE_MAJORS value "${supportedMajorsMatch[1]}" in .replit; expected comma-separated positive integers.`,
  );
}

const deploymentNodeMajor = Number(deploymentNodeMatch[1]);
if (!supportedNodeMajors.includes(deploymentNodeMajor)) {
  throw new Error(
    `Node runtime support mismatch: .replit deploys Node ${deploymentNodeMajor}, but SUPPORTED_NODE_MAJORS only lists ${supportedNodeMajors.join(", ")}. Update the source-of-truth list before changing deployment support.`,
  );
}

const testNamePattern = "uses Node's request lookup contract";

for (const major of supportedNodeMajors) {
  console.log(`\n== Citation transport compatibility: Node ${major} ==`);
  const result = spawnSync(
    "pnpm",
    [
      "--silent",
      "dlx",
      `node@${major}`,
      "./security-test.mjs",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: "production",
        TEST_NAME_PATTERN: testNamePattern,
      },
    },
  );

  if (result.error) {
    console.error(`Unable to run citation transport compatibility on Node ${major}:`, result.error);
    process.exitCode = 1;
    break;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}