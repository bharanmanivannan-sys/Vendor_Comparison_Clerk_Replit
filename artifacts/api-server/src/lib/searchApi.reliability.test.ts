import assert from "node:assert/strict";
import test from "node:test";
import { discoverSearchApiSources, searchDuckDuckGoLight } from "./searchApi";

const okResponse = () => new Response(JSON.stringify({
  organic_results: [{ link: "https://vendor.example/product" }],
}), { status: 200, headers: { "Content-Type": "application/json" } });

const options = ["Alpha", "Beta"];

test("retries a transient 5xx once and preserves discovery-only URLs", async () => {
  let calls = 0;
  const urls = await discoverSearchApiSources(
    ["Alpha"], "Software", "US", "United States", [], "test-key",
    async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
      return ["https://vendor.example/product"];
    },
  );

  assert.equal(calls, 2);
  assert.deepEqual(urls, ["https://vendor.example/product"]);
});

test("a transient 5xx is attempted at most twice", async () => {
  let calls = 0;
  await assert.rejects(() => discoverSearchApiSources(
    ["Alpha"], "Software", "US", "United States", [], "test-key",
    async () => {
      calls += 1;
      throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    },
  ), /http_503/);
  assert.equal(calls, 2);
});

test("does not retry HTTP 429 or capacity errors", async () => {
  let calls = 0;
  await assert.rejects(() => discoverSearchApiSources(
    options, "Software", "US", "United States", [], "test-key",
    async () => {
      calls += 1;
      throw Object.assign(new Error("SearchAPI discovery returned HTTP 429"), { status: 429 });
    },
  ), /http_429/);

  // Two options are dispatched once each; the 429 is never retried.
  assert.equal(calls, 2);
});

test("does not retry non-transient client errors", async () => {
  for (const status of [400, 401, 403, 404]) {
    let calls = 0;
    await assert.rejects(() => discoverSearchApiSources(
      ["Alpha"], "Software", "US", "United States", [], "test-key",
      async () => {
        calls += 1;
        throw Object.assign(new Error("request rejected"), { status });
      },
    ), new RegExp(`http_${status}`));
    assert.equal(calls, 1);
  }
});

test("retries a network failure once only while the caller signal remains active", async () => {
  let calls = 0;
  const urls = await discoverSearchApiSources(
    ["Alpha"], "Software", "US", "United States", [], "test-key",
    async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return ["https://vendor.example/product"];
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(urls, ["https://vendor.example/product"]);

  const controller = new AbortController();
  calls = 0;
  await assert.rejects(() => discoverSearchApiSources(
    ["Alpha"], "Software", "US", "United States", [], "test-key",
    async () => {
      calls += 1;
      controller.abort();
      throw new TypeError("fetch failed");
    },
    controller.signal,
  ), /failed for every compared option/);
  assert.equal(calls, 1);
});

test("429 cooldown honors Retry-After, is process-wide, and bounds large values", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let calls = 0;
  const limitedFetch: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: "monthly credits unavailable", secret: "must not escape" }), {
      status: 429,
      headers: { "Retry-After": new Date(now + 2 * 60 * 60_000).toUTCString() },
    });
  };
  try {
    const firstError = await searchDuckDuckGoLight("Alpha", "US", "test-key", limitedFetch).catch((error) => error);
    assert.match(firstError.message, /HTTP 429/);
    assert.doesNotMatch(firstError.message, /monthly|secret|test-key/i);

    const secondError = await searchDuckDuckGoLight("Beta", "US", "test-key", (async () => {
      calls += 1;
      return okResponse();
    }) as typeof fetch).catch((error) => error);
    assert.match(secondError.message, /HTTP 429/);
    assert.equal(calls, 1);

    // Retry-After is capped to one hour even if the provider sends longer.
    now += 60 * 60_000 + 1;
    assert.deepEqual(
      await searchDuckDuckGoLight("Alpha", "US", "test-key", (async () => {
        calls += 1;
        return okResponse();
      }) as typeof fetch),
      ["https://vendor.example/product"],
    );
    assert.equal(calls, 2);

    const numericRetryAfter = (async () => {
      calls += 1;
      return new Response("{}", { status: 429, headers: { "Retry-After": "2" } });
    }) as typeof fetch;
    await assert.rejects(() => searchDuckDuckGoLight("Alpha", "US", "test-key", numericRetryAfter), /HTTP 429/);
    await assert.rejects(
      () => searchDuckDuckGoLight("Beta", "US", "test-key", (async () => okResponse()) as typeof fetch),
      /HTTP 429/,
    );
    assert.equal(calls, 3);
    now += 2_001;
    await searchDuckDuckGoLight("Beta", "US", "test-key", (async () => {
      calls += 1;
      return okResponse();
    }) as typeof fetch);
    assert.equal(calls, 4);
  } finally {
    Date.now = originalNow;
  }
});

test("uses a conservative default cooldown when Retry-After is absent", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let calls = 0;
  try {
    const error = await searchDuckDuckGoLight("Alpha", "US", "test-key", (async () => {
      calls += 1;
      return new Response("{}", { status: 429 });
    }) as typeof fetch).catch((reason) => reason);
    assert.match(error.message, /HTTP 429/);

    const blocked = await searchDuckDuckGoLight("Alpha", "US", "test-key", (async () => {
      calls += 1;
      return okResponse();
    }) as typeof fetch).catch((reason) => reason);
    assert.match(blocked.message, /HTTP 429/);
    assert.equal(calls, 1);

    now += 5 * 60_000 + 1;
    await searchDuckDuckGoLight("Alpha", "US", "test-key", (async () => {
      calls += 1;
      return okResponse();
    }) as typeof fetch);
    assert.equal(calls, 2);
  } finally {
    Date.now = originalNow;
  }
});