import assert from "node:assert/strict";
import test from "node:test";
import { createFirecrawlSearcher, FirecrawlDiscoveryError } from "./firecrawlSearch";

test("Firecrawl search uses bounded per-option requests and returns HTTPS URLs only", async () => {
  const requests: Array<{ body: Record<string, unknown>; signal?: AbortSignal }> = [];
  const search = createFirecrawlSearcher(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ body, signal: init?.signal as AbortSignal | undefined });
    const index = requests.length;
    return new Response(JSON.stringify({
      success: true,
      data: {
        web: [
          { url: `https://vendor-${index}-one.example/product`, description: "discovery only" },
          { url: `http://vendor-${index}-two.example/product` },
          { url: "https://user:pass@vendor.example/product" },
        ],
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const urls = await search(
    ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta"],
    "software",
    "US",
    "United States",
    ["pricing", "security", "integrations"],
  );

  assert.equal(requests.length, 6);
  assert.ok(urls.length <= 8);
  assert.ok(urls.every((url) => url.startsWith("https://") && !url.includes("@")));
  for (const { body, signal } of requests) {
    assert.equal(body.limit, 3);
    assert.deepEqual(body.sources, ["web"]);
    assert.equal(body.country, "US");
    assert.equal(typeof body.query, "string");
    assert.ok(String(body.query).includes("pricing"));
    assert.ok(signal);
  }
});

test("Firecrawl 429 honors Retry-After, cools down, and never retries blindly", async () => {
  let clock = 1_000;
  let requests = 0;
  const search = createFirecrawlSearcher(async () => {
    requests += 1;
    if (requests > 1) {
      return new Response(JSON.stringify({
        data: { web: [{ url: "https://beta.example/product" }] },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "sensitive provider body" }), {
      status: 429,
      headers: { "Retry-After": "12" },
    });
  }, () => clock);

  await assert.rejects(
    () => search(["Alpha"], "software", "US", "United States", []),
    (error: unknown) => error instanceof Error
      && error.message === "Firecrawl discovery returned HTTP 429"
      && !error.message.includes("sensitive"),
  );
  await assert.rejects(
    () => search(["Beta"], "software", "US", "United States", []),
    /Firecrawl discovery returned HTTP 429/,
  );
  assert.equal(requests, 1);

  clock += 12_000;
  assert.deepEqual(
    await search(["Beta"], "software", "US", "United States", []),
    ["https://beta.example/product"],
  );
  assert.equal(requests, 2);
});

test("Firecrawl cooldown uses a conservative default when Retry-After is absent", async () => {
  let clock = 1_000;
  let requests = 0;
  const search = createFirecrawlSearcher(async () => {
    requests += 1;
    return new Response("", { status: 429 });
  }, () => clock);

  await assert.rejects(() => search(["Alpha"], "software", "", "", []), /HTTP 429/);
  clock += 5 * 60_000 - 1;
  await assert.rejects(() => search(["Beta"], "software", "", "", []), /HTTP 429/);
  assert.equal(requests, 1);
});

test("Firecrawl discovery passes cancellation to the request", async () => {
  const controller = new AbortController();
  let requests = 0;
  const search = createFirecrawlSearcher(async (_input, init) => {
    requests += 1;
    assert.equal(init?.signal, controller.signal);
    return new Response(JSON.stringify({ data: { web: [] } }), { status: 200 });
  });
  controller.abort();

  assert.deepEqual(
    await search(["Alpha"], "software", "", "", [], controller.signal),
    [],
  );
  assert.equal(requests, 0);
});

test("Firecrawl serializes requests across concurrent jobs in the process", async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const search = createFirecrawlSearcher(async (_input, init) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(init?.signal);
    activeRequests -= 1;
    return new Response(JSON.stringify({ data: { web: [] } }), { status: 200 });
  });

  await Promise.all([
    search(["Alpha"], "software", "", "", []),
    search(["Beta"], "software", "", "", []),
  ]);

  assert.equal(maxActiveRequests, 1);
});

test("a queued Firecrawl request observes a 429 cooldown before hitting the API", async () => {
  let requests = 0;
  const search = createFirecrawlSearcher(async () => {
    requests += 1;
    return new Response("", {
      status: 429,
      headers: { "Retry-After": "30" },
    });
  });

  const results = await Promise.allSettled([
    search(["Alpha"], "software", "", "", []),
    search(["Beta"], "software", "", "", []),
  ]);

  assert.equal(requests, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 2);
});

test("Firecrawl exposes safe HTTP status codes without response bodies", async () => {
  const search = createFirecrawlSearcher(async () => new Response("provider internal details", {
    status: 503,
  }));
  await assert.rejects(
    () => search(["Alpha"], "software", "GB", "United Kingdom", []),
    (error: unknown) => error instanceof Error
      && error.message === "Firecrawl discovery returned HTTP 503"
      && !error.message.includes("internal details"),
  );
});

test("Firecrawl interleaves each option's first novel URL before any extras", async () => {
  const search = createFirecrawlSearcher(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    const web = body.query.startsWith("Alpha")
      ? [
        { url: "https://shared.example/product" },
        { url: "https://alpha.example/product" },
      ]
      : [
        { url: "https://shared.example/product" },
        { url: "https://beta.example/product" },
      ];
    return new Response(JSON.stringify({ data: { web } }), { status: 200 });
  });

  assert.deepEqual(
    await search(["Alpha", "Beta"], "software", "", "", []),
    [
      "https://shared.example/product",
      "https://beta.example/product",
      "https://alpha.example/product",
    ],
  );
});

test("Firecrawl preserves earlier URLs when a later option receives HTTP 429", async () => {
  let requests = 0;
  const search = createFirecrawlSearcher(async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({
        data: {
          web: [
            { url: "https://alpha-one.example/product" },
            { url: "https://alpha-two.example/product" },
          ],
        },
      }), { status: 200 });
    }
    return new Response("", { status: 429, headers: { "Retry-After": "30" } });
  });

  await assert.rejects(
    () => search(["Alpha", "Beta"], "software", "", "", []),
    (error: unknown) => {
      assert.ok(error instanceof FirecrawlDiscoveryError);
      assert.equal(error.status, 429);
      assert.deepEqual(error.discoveredUrls, [
        "https://alpha-one.example/product",
        "https://alpha-two.example/product",
      ]);
      return true;
    },
  );
  await assert.rejects(() => search(["Beta"], "software", "", "", []), /HTTP 429/);
  assert.equal(requests, 2);
});