import assert from "node:assert/strict";
import test from "node:test";
import { scoreWithGeminiFallback } from "./decisionScoringProvider";
import { completeDecisionModeModelOutput, createDecisionModeAnalysis, DECISION_MODE_PRELIMINARY_TIMEOUT_MS } from "./analysis";
import { extractPriorities } from "./decisionPolicy";

const vendors = ["BYD Seal", "Tesla Model 3"];
const decisionInput = {
  prompt: "Compare BYD Seal vs Tesla Model 3 in Australia, budget matters most",
  vendors, criteria: ["Budget", "Features"], urls: [], market: "AU" as const,
};
const weights = extractPriorities(decisionInput.prompt, decisionInput.criteria).weights.slice(0, 10);
const ratings = {
  lenses: weights.map(({ lens }) => ({
    criterion: lens, scores: { "BYD Seal": 82, "Tesla Model 3": 72 },
  })),
  assumptions: ["Conditional scenario fit only"],
};
const validate = (raw: unknown) => completeDecisionModeModelOutput(raw, vendors, weights);
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const gemini = (text: string, finishReason = "STOP") => response({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
});
const options = (fetcher: typeof fetch, signal?: AbortSignal) => ({
  apiKey: "test-key", groqApiKey: "", fetcher, signal, deadlineAt: Date.now() + 1000, primaryBudgetMs: 100,
});
const unexpectedFetch = (() => { throw new Error("unexpected Gemini call"); }) as typeof fetch;

test("primary success does not invoke Gemini", async () => {
  const result = await scoreWithGeminiFallback(async () => ratings, validate, "system", "user", options(unexpectedFetch));
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.output.lenses.map(({ scores }) => scores), ratings.lenses.map(({ scores }) => scores));
});

test("nontransient primary rejection does not use Gemini", async () => {
  await assert.rejects(scoreWithGeminiFallback(async () => { throw { status: 400 }; }, validate, "s", "u",
    options(unexpectedFetch)));
});

test("slow primary cannot consume reserved Gemini window even if it ignores abort", async () => {
  const start = Date.now();
  const result = await scoreWithGeminiFallback(async () => new Promise(() => {}), validate, "s", "u",
    { ...options((async () => gemini(JSON.stringify(ratings))) as typeof fetch),
      deadlineAt: Date.now() + 5_300, primaryBudgetMs: 5_000 });
  assert.equal(result.provider, "gemini");
  assert.ok(Date.now() - start < 3_000);
});

test("credit exhaustion falls back directly with header key and exact validated ratings", async () => {
  let attempts = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash-lite:generateContent/);
    assert.doesNotMatch(String(url), /test-key/);
    assert.equal((init?.headers as Record<string, string>)["x-goog-api-key"], "test-key");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
    return gemini(JSON.stringify(ratings));
  }) as typeof fetch;
  const result = await scoreWithGeminiFallback(async () => { attempts++; throw { status: 429, code: "credit_balance_exhausted" }; },
    validate, "system", "user", options(fetcher));
  assert.equal(result.provider, "gemini");
  assert.equal(createDecisionModeAnalysis(decisionInput, result.output).recommendation, "BYD Seal");
  const next = await scoreWithGeminiFallback(async () => { attempts++; throw new Error("primary should be on cooldown"); },
    validate, "system", "user", options(fetcher));
  assert.equal(next.provider, "gemini");
  assert.equal(attempts, 1);
});

test("a slow but complete backup response has a bounded initial-analysis window beyond the old 5.5 seconds", async () => {
  const fetcher = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 5_650));
    return gemini(JSON.stringify(ratings));
  }) as typeof fetch;
  assert.ok(DECISION_MODE_PRELIMINARY_TIMEOUT_MS > 5_650);
  const result = await scoreWithGeminiFallback(
    async () => { throw { status: 429, code: "credit_balance_exhausted" }; },
    validate, "system", "user",
    { ...options(fetcher), deadlineAt: Date.now() + DECISION_MODE_PRELIMINARY_TIMEOUT_MS },
  );
  assert.equal(result.provider, "gemini");
  assert.equal(createDecisionModeAnalysis(decisionInput, result.output).recommendation, "BYD Seal");
});

test("malformed, blocked, empty and incomplete Gemini outputs do not invent ratings", async () => {
  for (const reply of [
    gemini("{bad"),
    gemini(JSON.stringify({ lenses: [] })),
    gemini("", "SAFETY"),
    response({ promptFeedback: { blockReason: "SAFETY" } }),
    response({ candidates: [] }),
  ]) {
    await assert.rejects(scoreWithGeminiFallback(async () => null, validate, "system", "user",
      options((async () => reply.clone()) as typeof fetch)), /MODEL_SCORING_GEMINI_/);
  }
});

test("incomplete Gemini ratings retry once within the same deadline and require full validated coverage", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return gemini(JSON.stringify(calls === 1 ? { ...ratings, lenses: [] } : ratings));
  }) as typeof fetch;
  const result = await scoreWithGeminiFallback(async () => null, validate, "s", "u",
    { ...options(fetcher), deadlineAt: Date.now() + 9_500 });
  assert.equal(calls, 2);
  assert.equal(result.provider, "gemini");
  assert.equal(result.output.lenses.length, weights.length);
});

test("both providers fail explicitly; absent Gemini key fails without fetch", async () => {
  await assert.rejects(scoreWithGeminiFallback(async () => { throw { status: 503 }; }, validate, "s", "u",
    options((async () => response({}, 503)) as typeof fetch)), /MODEL_SCORING_GEMINI_HTTP_503/);
  await assert.rejects(scoreWithGeminiFallback(async () => { throw { status: 429 }; }, validate, "s", "u",
    { ...options(unexpectedFetch), apiKey: undefined }), /MODEL_SCORING_GEMINI_NOT_CONFIGURED/);
});

test("Gemini HTTP rejection survives backup failure, while backup timeout and parent cancellation stay distinct", async () => {
  await assert.rejects(scoreWithGeminiFallback(async () => null, validate, "s", "u",
    options((async () => response({}, 403)) as typeof fetch)), /MODEL_SCORING_GEMINI_HTTP_403/);
  const timeoutFetcher = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  await assert.rejects(scoreWithGeminiFallback(async () => null, validate, "s", "u",
    { ...options(timeoutFetcher), deadlineAt: Date.now() + 25 }), /MODEL_SCORING_GEMINI_TIMEOUT/);
  const parent = new AbortController();
  const pending = scoreWithGeminiFallback(async () => null, validate, "s", "u", options(timeoutFetcher, parent.signal));
  parent.abort();
  await assert.rejects(pending, /MODEL_SCORING_CANCELLED/);
});

test("cancellation and deadline never attempt fallback", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scoreWithGeminiFallback(async () => ratings, validate, "s", "u",
    options(unexpectedFetch, controller.signal)), /MODEL_SCORING_CANCELLED/);
  await assert.rejects(scoreWithGeminiFallback(async () => ratings, validate, "s", "u",
    { ...options(unexpectedFetch), deadlineAt: Date.now() - 1 }), /MODEL_SCORING_DEADLINE_EXCEEDED/);
});

const groq = (body: unknown, finish_reason = "stop") => response({
  choices: [{ finish_reason, message: { content: JSON.stringify(body) } }],
});
const groqOptions = (geminiFetcher: typeof fetch, groqFetcher: typeof fetch) => ({
  ...options(geminiFetcher), groqApiKey: "fake-groq-key", groqModel: "openai/gpt-oss-20b", groqFetcher,
  deadlineAt: Date.now() + 1_000,
});

test("Gemini quota, timeout, and incomplete scores use Groq with the same complete-scores validator", async () => {
  for (const geminiFetcher of [
    (async () => response({}, 429)) as typeof fetch,
    (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })) as typeof fetch,
    (async () => gemini(JSON.stringify({ lenses: [] }))) as typeof fetch,
  ]) {
    let groqCalls = 0;
    const groqFetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      groqCalls++;
      assert.equal(String(url), "https://api.groq.com/openai/v1/chat/completions");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer fake-groq-key");
      assert.doesNotMatch(String(url), /fake-groq-key/);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "openai/gpt-oss-20b");
      assert.equal(body.response_format.type, "json_object");
      assert.equal(body.messages[0].content, "system");
      assert.equal(body.messages[1].content, "user");
      return groq(ratings);
    }) as typeof fetch;
    const result = await scoreWithGeminiFallback(async () => null, validate, "system", "user",
      groqOptions(geminiFetcher, groqFetcher));
    assert.equal(result.provider, "groq");
    assert.equal(result.output.lenses.length, weights.length);
    assert.equal(groqCalls, 1);
  }
});

test("Groq-only scoring works without Gemini and never accepts incomplete or truncated scores", async () => {
  const fetcher = (async () => groq(ratings)) as typeof fetch;
  const result = await scoreWithGeminiFallback(async () => null, validate, "s", "u",
    { ...groqOptions(unexpectedFetch, fetcher), apiKey: undefined });
  assert.equal(result.provider, "groq");
  for (const invalid of [groq({ lenses: [] }), groq(ratings, "length"), response({}, 503)]) {
    await assert.rejects(scoreWithGeminiFallback(async () => null, validate, "s", "u",
      groqOptions((async () => response({}, 429)) as typeof fetch,
        (async () => invalid.clone()) as typeof fetch)), /MODEL_SCORING_GROQ_/);
  }
});

test("Groq timeout and caller cancellation are bounded and distinct", async () => {
  const pendingFetcher = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  await assert.rejects(scoreWithGeminiFallback(async () => null, validate, "s", "u",
    { ...groqOptions((async () => response({}, 429)) as typeof fetch, pendingFetcher),
      deadlineAt: Date.now() + 35 }), /MODEL_SCORING_GROQ_TIMEOUT/);
  const parent = new AbortController();
  const pending = scoreWithGeminiFallback(async () => null, validate, "s", "u", {
    ...groqOptions((async () => response({}, 429)) as typeof fetch, pendingFetcher),
    signal: parent.signal,
  });
  parent.abort();
  await assert.rejects(pending, /MODEL_SCORING_CANCELLED/);
});
