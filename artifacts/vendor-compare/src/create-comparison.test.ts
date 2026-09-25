import assert from "node:assert/strict";
import test from "node:test";
import { createComparison } from "@workspace/api-client-react";

test("createComparison keeps request options in its second argument with async headers", async () => {
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
    await createComparison(
      { prompt: "Compare Alpha and Beta for reliability" },
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
    assert.equal(new Headers(request.init?.headers).get("authorization"), "Bearer legacy-client-token");
    assert.equal(new Headers(request.init?.headers).get("prefer"), "respond-async");
    assert.equal(new Headers(request.init?.headers).get("idempotency-key"), "retry-key-123");
    assert.equal(request.init?.signal, controller.signal);
  } finally {
    globalThis.fetch = originalFetch;
  }
});