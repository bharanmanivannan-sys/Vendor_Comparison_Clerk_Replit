import test from "node:test";
import assert from "node:assert/strict";
import { deleteQueuedQuotePdf } from "./quoteObjects";

test("private file deletion keeps the retry record when storage fails", async () => {
  const key = "/private/buyer-quotes/1/example.pdf";
  const acknowledged: string[] = [];
  await assert.rejects(
    () => deleteQueuedQuotePdf(key, async () => { throw new Error("storage unavailable"); },
      async (value) => { acknowledged.push(value); }),
    /storage unavailable/,
  );
  assert.equal(acknowledged.length, 0);
  await deleteQueuedQuotePdf(key, async (value) => assert.equal(value, key),
    async (value) => { acknowledged.push(value); });
  assert.deepEqual(acknowledged, [key]);
});

test("private file deletion retains the retry record if acknowledgement fails", async () => {
  let deletions = 0;
  await assert.rejects(() => deleteQueuedQuotePdf("key", async () => { deletions += 1; },
    async () => { throw new Error("database unavailable"); }), /database unavailable/);
  assert.equal(deletions, 1);
  await deleteQueuedQuotePdf("key", async () => { deletions += 1; }, async () => {});
  assert.equal(deletions, 2);
});