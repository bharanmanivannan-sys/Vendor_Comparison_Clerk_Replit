import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, idempotencyKeysTable } from "@workspace/db";
import { beginIdempotency, completeIdempotency } from "./idempotency";

test("only one concurrent request acquires an idempotency key", async () => {
  const tenantId = `test_${randomUUID()}`;
  const key = randomUUID();
  try {
    const results = await Promise.all([
      beginIdempotency(tenantId, key, "same-hash"),
      beginIdempotency(tenantId, key, "same-hash"),
    ]);
    assert.equal(results.filter((result) => result.state === "new").length, 1);
    assert.equal(results.filter((result) => result.state === "in_progress").length, 1);
  } finally {
    await db.delete(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    ));
  }
});

test("expired leases are reclaimed atomically and stale owners cannot complete", async () => {
  const tenantId = `test_${randomUUID()}`;
  const key = randomUUID();
  try {
    const first = await beginIdempotency(tenantId, key, "same-hash");
    assert.equal(first.state, "new");
    await db.update(idempotencyKeysTable).set({
      leaseExpiresAt: new Date(Date.now() - 1000),
    }).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    ));
    const second = await beginIdempotency(tenantId, key, "same-hash");
    assert.equal(second.state, "new");
    await assert.rejects(
      completeIdempotency(db, tenantId, key, first.ownershipToken!, 201, { owner: "stale" }, {}),
      /ownership was lost/,
    );
    await completeIdempotency(db, tenantId, key, second.ownershipToken!, 201, { owner: "current" }, {});
    const replay = await beginIdempotency(tenantId, key, "same-hash");
    assert.equal(replay.state, "replay");
    if (replay.state === "replay") assert.deepEqual(replay.body, { owner: "current" });
  } finally {
    await db.delete(idempotencyKeysTable).where(and(
      eq(idempotencyKeysTable.tenantId, tenantId),
      eq(idempotencyKeysTable.key, key),
    ));
  }
});