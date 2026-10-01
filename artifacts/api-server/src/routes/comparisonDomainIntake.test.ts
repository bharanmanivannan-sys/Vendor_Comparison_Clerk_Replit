import test from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "../lib/analysis";
import { discoverComparisonDomain } from "../lib/comparisonClassification";
import { validateComparisonInput, comparisonParseResult } from "./comparisons";

test("entity-discovered category is retained by review, job intake and parsed context", async () => {
  const prompt = "Compare Datadog vs New Relic in Australia; prioritize monitoring.";
  const vendors = ["Datadog", "New Relic"];
  const resolveDomain: typeof discoverComparisonDomain = (names, text, market) =>
    discoverComparisonDomain(names, text, market, async ({ names: options }) => ({
      decisionDomain: "Observability Platforms",
      options: options.map((name) => ({
        name, type: "platform", category: "Monitoring Platforms",
        subcategory: "Observability", decisionDomain: "Observability Platforms",
        confidence: 0.95,
      })),
    }));
  const preflight = await resolveDomain(vendors, prompt, "AU");
  const parsed = parsePrompt(prompt);
  const interpreted = {
    ...parsed, vendors,
    intent: { category: "General market", subject: "Comparison", useCase: "", options: vendors },
    comparisonIdentity: {} as never,
  };
  const response = comparisonParseResult(interpreted as never, prompt, "AU", preflight);
  assert.equal(response.context.decisionDomain, "Observability Platforms");
  assert.equal(response.intent.category, "Monitoring Platforms");
  assert.equal(response.context.segment, "Monitoring Platforms");

  const validated = await validateComparisonInput({
    prompt, market: "AU", vendors,
    criteria: ["Monitoring quality"],
    validatedComparisonType: "Software Platform Comparison",
    validatedDecisionDomain: "Observability Platforms",
    validatedCategory: "Monitoring Platforms",
  }, async (value) => ({
    ...parsePrompt(value), comparisonIdentity: {} as never, intent: {} as never,
  }), resolveDomain);
  assert.ok(!("error" in validated), "error" in validated ? validated.error : undefined);
  if ("error" in validated) return;
  assert.equal(validated.validatedContext.decisionDomain, "Observability Platforms");
  assert.equal(validated.input.validatedCategory, "Monitoring Platforms");
  assert.deepEqual(validated.vendors, vendors);
});