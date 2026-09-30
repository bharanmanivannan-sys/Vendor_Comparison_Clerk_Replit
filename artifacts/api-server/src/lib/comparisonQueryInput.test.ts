import assert from "node:assert/strict";
import test from "node:test";
import { normalizeComparisonQuery } from "./comparisonQueryInput";

test("comparison queries are bounded, normalized data, not executable commands", () => {
  assert.equal(normalizeComparisonQuery(null), null);
  assert.equal(normalizeComparisonQuery(" \t "), null);
  assert.equal(normalizeComparisonQuery("x".repeat(4_001)), null);
  assert.equal(normalizeComparisonQuery("Compare Cafe\u0301 and Tesla\u0007"), "Compare Café and Tesla");
  assert.equal(normalizeComparisonQuery("Compare SQL SELECT * FROM accounts vs NoSQL"), "Compare SQL SELECT * FROM accounts vs NoSQL");
  assert.equal(normalizeComparisonQuery("Compare <Brand> and Tesla"), "Compare <Brand> and Tesla");
});