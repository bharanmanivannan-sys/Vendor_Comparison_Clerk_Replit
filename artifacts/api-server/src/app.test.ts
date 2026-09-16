import test from "node:test";
import assert from "node:assert/strict";
import app from "./app";

async function withApiServer(run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port.");
  }

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((cause) => cause ? reject(cause) : resolve());
    });
  }
}

test("conditional API requests return a fresh JSON body instead of 304", async () => {
  await withApiServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/healthz`, {
      headers: {
        "if-none-match": 'W/"previous-response"',
      },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("etag"), null);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});