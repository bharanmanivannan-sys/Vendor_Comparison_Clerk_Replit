import test from "node:test";
import assert from "node:assert/strict";
import {
  contentLooksStale,
  contentMarketMismatch,
  explicitMarketMismatch,
  sourceLooksStale,
  sourceLooksUnrelated,
} from "./sourcePreflight";

test("classifies explicit market, freshness, and relevance conflicts deterministically", () => {
  assert.equal(explicitMarketMismatch("https://example.co.uk/rates", "AU"), true);
  assert.equal(explicitMarketMismatch("https://example.com/rates", "AU"), false);
  assert.equal(sourceLooksStale("https://example.com/reports/2023/pricing", 2026), true);
  assert.equal(sourceLooksStale("https://example.com/reports/2025/pricing", 2026), false);
  assert.equal(contentLooksStale("Updated March 2023. Price list.", 2026), true);
  assert.equal(contentLooksStale("Updated March 2025. Price list.", 2026), false);
  assert.equal(contentMarketMismatch("United Kingdom price £49,000 including VAT", "AU"), true);
  assert.equal(contentMarketMismatch("Australia price A$49,000 drive-away", "AU"), false);
  assert.equal(sourceLooksUnrelated("Tesla Model Y Australian pricing", "Compare Tesla vs BYD in Australia"), false);
  assert.equal(sourceLooksUnrelated("Cooking recipes and kitchen appliances", "Compare Tesla vs BYD in Australia"), true);
  assert.equal(sourceLooksUnrelated("Official BYD Australian range", "Compare BYD vs MG", ["BYD", "MG"]), false);
  assert.equal(sourceLooksUnrelated("Cooking recipes and kitchen appliances", "Compare BYD vs MG", ["BYD", "MG"]), true);
  assert.equal(sourceLooksUnrelated("A generic forecasting model for retail", "Compare Tesla Model Y vs BYD Seal", ["Tesla Model Y", "BYD Seal"]), true);
  assert.equal(sourceLooksUnrelated("Tesla electric vehicle range and servicing", "Compare Tesla Model Y vs BYD Seal", ["Tesla Model Y", "BYD Seal"]), false);
  assert.equal(sourceLooksUnrelated("Official BYD Seal specifications", "Compare Tesla Model Y vs BYD Seal", ["Tesla Model Y", "BYD Seal"]), false);
});