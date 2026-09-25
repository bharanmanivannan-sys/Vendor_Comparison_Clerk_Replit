import test from "node:test";
import assert from "node:assert/strict";
import app from "../app";

async function withServer(run: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("quote lifecycle endpoints deny unauthenticated callers before revealing ownership", async () => {
  await withServer(async (base) => {
    for (const request of [
      fetch(`${base}/api/comparisons/1/quotes`),
      fetch(`${base}/api/comparisons/1/quotes/Acme`, { method: "DELETE" }),
      fetch(`${base}/api/comparisons/1/quotes/Acme/document`),
    ]) {
      assert.equal((await request).status, 401);
    }
  });
});

test("quote upload is also denied before multipart/body processing", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/comparisons/1/quotes`, {
      method: "POST",
      body: new FormData(),
    });
    assert.equal(response.status, 401);
  });
});