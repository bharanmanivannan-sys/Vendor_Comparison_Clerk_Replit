import test from "node:test";
import assert from "node:assert/strict";
import { validateComparisonInput } from "./comparisons";

test("submission uses resolved comparison players instead of the subject as a heading", async () => {
  const prompt = "Can you help me compare BaaS with MG & Mahindra. What exactly this means? Who are the players?";
  const validated = await validateComparisonInput(
    { prompt, urls: [] },
    async () => ({
      prompt,
      vendors: ["MG", "Mahindra"],
      urls: [],
      criteria: ["Range and charging"],
      intent: {
        options: ["MG", "Mahindra"],
        subject: "BaaS",
        decisionType: "comparison" as const,
        category: "Battery as a Service",
        useCase: "Vehicle ownership",
        confidence: 0.96,
        clarification: "",
      },
      context: {
        valid: true,
        segment: "Battery as a Service",
        industry: "Vehicle ownership",
        message: "Comparing options in Battery as a Service for Vehicle ownership.",
      },
    }),
  );

  assert.ok(!("error" in validated));
  if ("error" in validated) return;
  assert.deepEqual(validated.vendors, ["MG", "Mahindra"]);
  assert.ok(!validated.vendors.includes("BaaS"));
  assert.deepEqual(validated.criteria, ["Range and charging"]);
  assert.equal(validated.context.segment, "Battery as a Service");
});