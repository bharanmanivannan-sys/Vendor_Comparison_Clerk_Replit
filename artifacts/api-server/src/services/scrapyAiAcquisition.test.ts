import test from "node:test";
import assert from "node:assert/strict";
import {
  isScrapyAiAcquisitionConfigured,
  retrieveEvidenceDocumentsWithScrapyAi,
} from "./scrapyAiAcquisition";

test("keeps Scrapy AI acquisition disabled unless explicitly enabled with a key", async () => {
  let fetchCalls = 0;
  assert.equal(isScrapyAiAcquisitionConfigured({}), false);
  const [result] = await retrieveEvidenceDocumentsWithScrapyAi(
    ["https://permitted.example/product"],
    {
      env: { ZYTE_API_KEY: "test-key" },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result?.document, undefined);
  assert.equal(result?.reason, "access_restricted");
  assert.equal(fetchCalls, 0);
});

test("does not send a prohibited source to the browser-rendered provider", async () => {
  let fetchCalls = 0;
  const [result] = await retrieveEvidenceDocumentsWithScrapyAi(
    ["https://blocked.example/product"],
    {
      env: { SCRAPY_AI_ENABLED: "true", ZYTE_API_KEY: "test-key" },
      preflight: async () => [{
        url: "https://blocked.example/product",
        available: false,
        reason: "robots_disallowed",
      }],
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result?.document, undefined);
  assert.equal(result?.reason, "robots_disallowed");
  assert.equal(fetchCalls, 0);
});

test("records rendered HTML provenance after a permitted browser extraction", async () => {
  const records: Array<{ url: string; result: { available: boolean; finalUrl?: string } }> = [];
  const [result] = await retrieveEvidenceDocumentsWithScrapyAi(
    ["https://permitted.example/product"],
    {
      env: { SCRAPY_AI_ENABLED: "true", ZYTE_API_KEY: "test-key" },
      preflight: async () => [{
        url: "https://permitted.example/product",
        available: true,
      }],
      fetchImpl: async () => new Response(JSON.stringify({
        url: "https://permitted.example/product",
        browserHtml: "<html><body><h1>Product</h1><p>Rendered evidence.</p></body></html>",
      }), { status: 200, headers: { "content-type": "application/json" } }),
      permissionRegistry: {
        lookup: async () => null,
        record: async (url, evidence) => {
          records.push({ url, result: evidence });
          return null;
        },
      },
    },
  );
  assert.equal(result?.reason, undefined);
  assert.equal(result?.document?.retrievalMethod, "scrapy_zyte_browser_html");
  assert.equal(result?.document?.parserVersion, "scrapy-ai-browser-html-v1");
  assert.match(result?.document?.text ?? "", /Rendered evidence/);
  assert.deepEqual(records, [{
    url: "https://permitted.example/product",
    result: {
      available: true,
      finalUrl: "https://permitted.example/product",
    },
  }]);
});