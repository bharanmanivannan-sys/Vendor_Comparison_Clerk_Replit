import test from "node:test";
import assert from "node:assert/strict";
import type { ComparisonQuote } from "@workspace/db";
import { assessBuyerQuotes, quotedTotalAud } from "./quotePricing";

const sample = (vendor: string, overrides: Partial<ComparisonQuote> = {}) => ({
  vendor, currency: "AUD", termMonths: 24, licenseAnnual: "1200.00",
  implementationOnce: "300.00", serviceAnnual: "240.00",
  audPerUnit: "1", documentDate: "2026-09-01", validUntil: "2026-12-31",
  exchangeRateDate: null, exchangeRateSource: null,
  scope: "100 seats, onboarding and managed support", taxBasis: "ex_gst",
  exclusions: "None", ...overrides,
}) as ComparisonQuote;

const options = ["Alpha", "Beta"];
const today = "2026-09-24";

test("written quotes on the same basis yield separate AUD totals and relative price scores", () => {
  const a = sample("Alpha");
  const b = sample("Beta", { licenseAnnual: "1800.00" });
  const result = assessBuyerQuotes(options, [a, b], today);
  assert.equal(quotedTotalAud(a), "3180.00");
  assert.equal(quotedTotalAud(b), "4380.00");
  assert.equal(result.status, "ready");
  assert.equal(result.winner, "Alpha");
  assert.deepEqual(result.scores, { Alpha: 100, Beta: 73 });
  assert.match(result.rows[3]!.values.Alpha, /\$3,180\.00.*buyer-entered/);
});

test("incomplete coverage, mismatched scope, tax, term or exclusions never names a winner", () => {
  const a = sample("Alpha");
  const variants = [
    [a],
    [a, sample("Beta", { termMonths: 12 })],
    [a, sample("Beta", { scope: "200 seats, onboarding and managed support" })],
    [a, sample("Beta", { taxBasis: "inc_gst" })],
    [a, sample("Beta", { exclusions: "Extra data hosting" })],
  ];
  for (const quotes of variants) {
    const result = assessBuyerQuotes(options, quotes, today);
    assert.equal(result.status, "incomplete");
    assert.equal(result.winner, null);
    assert.deepEqual(result.scores, {});
    assert.ok(result.flags.length);
  }
});

test("expired documents and undated foreign exchange are disqualified", () => {
  const expired = sample("Alpha", { validUntil: "2026-09-23" });
  const foreign = sample("Beta", { currency: "USD", audPerUnit: "1.500000" });
  const result = assessBuyerQuotes(options, [expired, foreign], today);
  assert.equal(result.status, "incomplete");
  assert.equal(result.winner, null);
  assert.match(result.flags.join(" "), /expired.*dated, sourced AUD conversion/);
  const converted = sample("Beta", {
    currency: "USD", audPerUnit: "1.500000", exchangeRateDate: "2026-09-23",
    exchangeRateSource: "https://example.org/fx/2026-09-23",
  });
  assert.equal(quotedTotalAud(converted), "4770.00");
  assert.equal(assessBuyerQuotes(options, [sample("Alpha"), converted], today).status, "ready");
});

test("same-price ties receive equal scores but no singular winner", () => {
  const result = assessBuyerQuotes(options, [sample("Alpha"), sample("Beta")], today);
  assert.equal(result.status, "ready");
  assert.equal(result.winner, null);
  assert.deepEqual(result.scores, { Alpha: 100, Beta: 100 });
});