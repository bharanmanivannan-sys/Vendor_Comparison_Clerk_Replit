import assert from "node:assert/strict";
import test from "node:test";
import { createComparison } from "@workspace/api-client-react";

test("createComparison sends a confirmed draft with required correlation and request options", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return new Response(JSON.stringify({ id: 123 }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const requestId = "123e4567-e89b-42d3-a456-426614174000";
    const input = {
      draftId: "draft-confirmed-123",
      draftVersion: 7,
      prompt: "Compare Alpha and Beta for reliability",
      market: "AU" as const,
      comparisonValues: [
        { rawText: "Alpha", confirmedName: "Alpha", entityLevel: "BRAND" as const },
        { rawText: "Beta", confirmedName: "Beta", entityLevel: "BRAND" as const },
      ],
    };
    await createComparison(
      input,
      { "X-Request-Id": requestId },
      {
        headers: {
          Authorization: "Bearer legacy-client-token",
          Prefer: "respond-async",
          "Idempotency-Key": "retry-key-123",
        },
        signal: controller.signal,
      },
    );

    assert.ok(request);
    assert.equal(String(request.input), "/api/comparisons");
    assert.deepEqual(JSON.parse(String(request.init?.body)), input);
    assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer legacy-client-token");
    assert.equal(new Headers(request.init?.headers).get("prefer"), "respond-async");
    assert.equal(new Headers(request.init?.headers).get("idempotency-key"), "retry-key-123");
    assert.equal(new Headers(request.init?.headers).get("x-request-id"), requestId);
    assert.equal(request.init?.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});