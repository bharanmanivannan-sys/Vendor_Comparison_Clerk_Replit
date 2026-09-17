import assert from "node:assert/strict";
import {
  extractIntentWithOpenAI,
  parsePromptWithIntent,
  type ComparisonIntent,
} from "./analysis";

type DecisionType = ComparisonIntent["decisionType"];

type EvaluationCase = {
  name: string;
  prompt: string;
  options: string[];
  decisionType: DecisionType;
  expectedValid: boolean;
  clarification?: boolean;
  safety?: "placeholder" | "cross_domain";
};

const corpus: EvaluationCase[] = [
  {
    name: "consumer choice",
    prompt: "Help me decide whether the Breville Barista Touch or De'Longhi La Specialista suits a small apartment.",
    options: ["Breville Barista Touch", "De'Longhi La Specialista"],
    decisionType: "choice",
    expectedValid: true,
  },
  {
    name: "developer comparison",
    prompt: "For our TypeScript SDK, weigh Kysely against Drizzle ORM under edge-runtime constraints.",
    options: ["Kysely", "Drizzle ORM"],
    decisionType: "comparison",
    expectedValid: true,
  },
  {
    name: "product manager choice",
    prompt: "Our product team is torn between Productboard and airfocus for quarterly discovery planning.",
    options: ["Productboard", "airfocus"],
    decisionType: "choice",
    expectedValid: true,
  },
  {
    name: "executive migration",
    prompt: "The board needs a view on retiring Workday in favour of Rippling across global people operations.",
    options: ["Workday", "Rippling"],
    decisionType: "migration",
    expectedValid: true,
  },
  {
    name: "retailer purchase channel",
    prompt: "Should I order the Framework Laptop 13 from Umart or buy it direct from Framework?",
    options: ["Umart", "Framework"],
    decisionType: "purchase_channel",
    expectedValid: true,
  },
  {
    name: "financing decision",
    prompt: "Model salary packaging through Smartleasing against paying cash for the Polestar 4.",
    options: ["Smartleasing", "paying cash"],
    decisionType: "financing",
    expectedValid: true,
  },
  {
    name: "platform migration",
    prompt: "We are sunsetting Heroku and moving the service to Fly.io before the next renewal.",
    options: ["Heroku", "Fly.io"],
    decisionType: "migration",
    expectedValid: true,
  },
  {
    name: "missing shortlist clarification",
    prompt: "We need a better inventory platform for our regional stores.",
    options: [],
    decisionType: "choice",
    expectedValid: false,
    clarification: true,
  },
  {
    name: "placeholder safety",
    prompt: "Compare Vendor A with Vendor B for payroll.",
    options: ["Vendor A", "Vendor B"],
    decisionType: "comparison",
    expectedValid: false,
    safety: "placeholder",
  },
  {
    name: "cross-domain safety",
    prompt: "Weigh Apple against Westpac for a credit card product.",
    options: ["Apple", "Westpac"],
    decisionType: "comparison",
    expectedValid: false,
    safety: "cross_domain",
  },
];

const normalize = (value: string) =>
  value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function sameOptions(actual: unknown, expected: string[]) {
  if (!Array.isArray(actual) || !actual.every((item) => typeof item === "string")) return false;
  const actualSet = new Set(actual.map(normalize));
  const expectedSet = new Set(expected.map(normalize));
  return actualSet.size === expectedSet.size
    && [...expectedSet].every((option) => actualSet.has(option));
}

function isRawIntent(value: unknown): value is ComparisonIntent {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return Array.isArray(raw.options)
    && typeof raw.decisionType === "string"
    && typeof raw.confidence === "number"
    && typeof raw.clarification === "string";
}

async function main() {
  assert.ok(
    process.env.OPENAI_API_KEY,
    "OPENAI_API_KEY is required for the opt-in intent evaluation",
  );

  let optionMatches = 0;
  let decisionMatches = 0;
  let clarificationMatches = 0;
  let clarificationCases = 0;
  let confidenceTotal = 0;
  const failures: string[] = [];

  for (const item of corpus) {
    const raw = await extractIntentWithOpenAI(item.prompt);
    if (!isRawIntent(raw)) {
      failures.push(`${item.name}: model did not return a valid intent payload`);
      continue;
    }

    const optionMatch = sameOptions(raw.options, item.options);
    const decisionMatch = raw.decisionType === item.decisionType;
    optionMatches += Number(optionMatch);
    decisionMatches += Number(decisionMatch);
    confidenceTotal += raw.confidence;

    const parsed = await parsePromptWithIntent(item.prompt, async () => raw, {
      timeoutMs: 10_000,
    });
    const clarificationGood = item.clarification
      ? !parsed.context.valid
        && raw.confidence < 0.7
        && raw.clarification.trim().endsWith("?")
        && raw.clarification.trim().split(/\s+/).length >= 4
      : true;
    if (item.clarification) {
      clarificationCases += 1;
      clarificationMatches += Number(clarificationGood);
    }

    const invented = raw.options.some((option) =>
      typeof option !== "string"
      || !(` ${normalize(item.prompt)} `).includes(` ${normalize(option)} `));
    if (invented) failures.push(`${item.name}: hard failure: model invented an option`);
    if (item.safety && parsed.context.valid) {
      failures.push(`${item.name}: hard failure: ${item.safety} input passed safety validation`);
    }
    if (!item.safety && parsed.context.valid !== item.expectedValid) {
      failures.push(`${item.name}: expected valid=${item.expectedValid}, got ${parsed.context.valid}`);
    }
    if (!optionMatch) failures.push(`${item.name}: option mismatch (${JSON.stringify(raw.options)})`);
    if (!decisionMatch) failures.push(`${item.name}: decision type was ${raw.decisionType}`);
    if (!clarificationGood) failures.push(`${item.name}: clarification was not focused and low-confidence`);

    process.stdout.write(
      `${item.name}: options=${optionMatch ? "pass" : "fail"} `
      + `decision=${decisionMatch ? "pass" : "fail"} confidence=${raw.confidence.toFixed(2)} `
      + `clarification=${item.clarification ? (clarificationGood ? "pass" : "fail") : "n/a"}\n`,
    );
  }

  const evaluated = corpus.length;
  process.stdout.write("\nIntent evaluation summary\n");
  process.stdout.write(`Option accuracy: ${optionMatches}/${evaluated} (${(100 * optionMatches / evaluated).toFixed(1)}%)\n`);
  process.stdout.write(`Decision-type accuracy: ${decisionMatches}/${evaluated} (${(100 * decisionMatches / evaluated).toFixed(1)}%)\n`);
  process.stdout.write(`Average confidence: ${(confidenceTotal / evaluated).toFixed(3)}\n`);
  process.stdout.write(`Clarification quality: ${clarificationMatches}/${clarificationCases}\n`);

  if (failures.length) {
    process.stderr.write(`\nFailures:\n- ${failures.join("\n- ")}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});