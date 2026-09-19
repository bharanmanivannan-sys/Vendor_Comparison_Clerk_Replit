import test from "node:test";
import assert from "node:assert/strict";
import { parsePromptWithIntent } from "../lib/analysis";
import { comparisonWorkaroundPrompt, validateComparisonInput } from "./comparisons";

test("submission uses resolved comparison players instead of the subject as a heading", async () => {
  const prompt = "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    (value) => parsePromptWithIntent(value, async () => {
      throw new Error("Intent model unavailable");
    }),
  );

  assert.ok(!("error" in validated));
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["MG", "Mahindra"]);
  assert.ok(!validated.vendors.includes("BaaS"));
  assert.ok(validated.criteria.includes("Range and charging"));
  assert.equal(validated.context.segment, "Battery as a Service");
});

test("submission accepts the MG and Mahindra BaaS purchase when intent confidence is low", async () => {
  const prompt = "I want to purchase a Electric 4 wheeler with Battery as service option. Do a comparative analysis between MG and Mahindra. Aspects: Price, features , quality, complaints,warranty, etc..";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    (value) => parsePromptWithIntent(value, async () => ({
      options: ["MG", "Mahindra"],
      subject: "Electric 4 wheeler with Battery as a Service",
      decisionType: "choice",
      category: "Electric vehicles",
      useCase: "Purchase",
      confidence: 0.55,
      clarification: "What outcome or use case should decide between these options?",
    })),
  );

  assert.ok(!("error" in validated));
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["MG", "Mahindra"]);
  assert.equal(validated.context.valid, true);
});

test("offers an actionable workaround when a multi-brand EV request is mis-grouped", () => {
  const prompt = "Compare BYD vs Tesla and MG. Which of the cars match the ANCAP standards and fit the budget under $80,000. Why? Compare the features, pricing. Which of this cars would be value for money?";
  assert.equal(
    comparisonWorkaroundPrompt(prompt, ["BYD", "Tesla and MG"]),
    "Compare current electric vehicle models from BYD, Tesla, and MG available in Australia for $80,000 or less. Select the best-matching current model from each manufacturer. Compare official safety ratings, pricing, features, range, charging, warranty, and value for money.",
  );
});