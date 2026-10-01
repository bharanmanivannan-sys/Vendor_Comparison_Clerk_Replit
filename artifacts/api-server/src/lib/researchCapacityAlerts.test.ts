import assert from "node:assert/strict";
import test from "node:test";
import { createResearchCapacityAlerts } from "./researchCapacityAlerts";

type Captured = { level: string; event: string; fields: Record<string, unknown> };

test("three observations in five minutes alert; window expiry and suppression bound repeats", () => {
  let clock = 1_000;
  const events: Captured[] = [];
  const alerts = createResearchCapacityAlerts(() => clock,
    (level, event, fields) => { events.push({ level, event, fields }); });
  alerts.failure("searchapi", "rate_limited");
  clock += 5 * 60_000;
  alerts.failure("searchapi", "rate_limited");
  alerts.failure("searchapi", "rate_limited");
  assert.equal(events.length, 0); // first failure aged out
  alerts.failure("searchapi", "rate_limited");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    level: "warn", event: "research_capacity_alert",
    fields: { provider: "searchapi", reason: "rate_limited", observationCount: 3,
      windowMs: 300_000, suppressionMs: 900_000 },
  });
  for (let i = 0; i < 50; i++) alerts.failure("searchapi", "rate_limited");
  assert.equal(events.length, 1);
  clock += 15 * 60_000;
  for (let i = 0; i < 3; i++) alerts.failure("searchapi", "rate_limited");
  assert.equal(events.length, 2);
});

test("reasons and known providers are isolated; only a genuine HTTP success recovers an alerted provider", () => {
  let clock = 1_000;
  const events: Captured[] = [];
  const alerts = createResearchCapacityAlerts(() => clock,
    (level, event, fields) => { events.push({ level, event, fields }); });
  for (let i = 0; i < 2; i++) alerts.failure("firecrawl", "capacity_exhausted");
  alerts.failure("firecrawl", "rate_limited");
  assert.equal(events.length, 0);
  alerts.failure("firecrawl", "capacity_exhausted");
  alerts.httpSuccess("searchapi"); // a fallback succeeding does not recover Firecrawl
  clock += 60 * 60_000; // cooldown expiry alone cannot recover
  assert.equal(events.length, 1);
  alerts.httpSuccess("firecrawl");
  assert.deepEqual(events[1], {
    level: "info", event: "research_capacity_recovered",
    fields: { provider: "firecrawl", reason: "capacity_exhausted" },
  });
  alerts.httpSuccess("firecrawl");
  assert.equal(events.length, 2);
  for (const provider of ["openai", "gemini", "groq"] as const) {
    for (let i = 0; i < 3; i++) alerts.failure(provider, "rate_limited");
  }
  assert.deepEqual(events.slice(2).map((event) => event.fields.provider), ["openai", "gemini", "groq"]);
});

test("terminal blockage is a distinct warning, not a fourth observation; output is bounded and private", () => {
  const events: Captured[] = [];
  const alerts = createResearchCapacityAlerts(() => 1_000,
    (level, event, fields) => { events.push({ level, event, fields }); });
  alerts.failure("gemini", "rate_limited");
  alerts.failure("gemini", "rate_limited");
  alerts.comparisonBlocked("gemini", "rate_limited");
  assert.equal(events.length, 1);
  alerts.failure("gemini", "rate_limited");
  assert.equal(events.length, 2);
  alerts.failure("unknown" as "gemini", "rate_limited");
  alerts.failure("gemini", "unknown" as "rate_limited");
  alerts.comparisonBlocked("unknown" as "gemini", "rate_limited");
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    level: "warn", event: "research_comparison_blocked",
    fields: { provider: "gemini", reason: "rate_limited" },
  });
  assert.ok(!JSON.stringify(events).includes("unknown"));
  assert.ok(events.every(({ fields }) => Object.keys(fields)
    .every((key) => ["provider", "reason", "observationCount", "windowMs", "suppressionMs"].includes(key))));
});

test("broken clocks and emitters cannot fail a comparison", () => {
  const brokenEmitter = createResearchCapacityAlerts(() => 1, () => { throw new Error("logging failed"); });
  assert.doesNotThrow(() => {
    for (let i = 0; i < 3; i++) brokenEmitter.failure("searchapi", "capacity_exhausted");
    brokenEmitter.comparisonBlocked("searchapi", "capacity_exhausted");
    brokenEmitter.httpSuccess("searchapi");
  });
  const brokenClock = createResearchCapacityAlerts(() => { throw new Error("clock failed"); });
  assert.doesNotThrow(() => brokenClock.failure("searchapi", "rate_limited"));
});