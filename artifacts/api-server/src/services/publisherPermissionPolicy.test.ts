import test from "node:test";
import assert from "node:assert/strict";
import type { SourceRegistryEntry } from "@workspace/db";
import { currentRegistrySnapshot } from "./publisherPermissionPolicy";

test("an automated observation does not reactivate an expired reviewed licence", () => {
  const entry = {
    id: 1,
    domain: "publisher.example",
    decisionOrigin: "reviewed",
    pathScope: null,
    sourceType: "publisher",
    accessStatus: "LICENSED",
    accessMethod: "public_web",
    robotsResult: "allowed",
    licenceOrTermsNotes: "Human-reviewed licence terms.",
    owner: "Research governance",
    reviewedAt: new Date("2026-09-01T00:00:00.000Z"),
    reviewDueAt: new Date("2026-09-20T00:00:00.000Z"),
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
    automatedObservation: {
      accessStatus: "ALLOWED",
      robotsResult: "allowed",
      checkedAt: "2026-09-21T00:00:00.000Z",
      checkDueAt: "2026-09-21T06:00:00.000Z",
      allowedUses: ["automated_retrieval", "comparison_evidence"],
      restrictions: [],
      pathScope: "/public",
    },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-21T00:00:00.000Z"),
  } satisfies SourceRegistryEntry;

  const current = currentRegistrySnapshot(entry, new Date("2026-09-21T01:00:00.000Z"), "/public");
  assert.equal(current?.accessStatus, "ALLOWED");
  assert.equal(current?.accessMethod, "public_web");
  assert.equal(current?.licenceOrTermsNotes, undefined);
  assert.equal(current?.owner, undefined);
  assert.notEqual(current?.accessStatus, entry.accessStatus);
  assert.equal(
    currentRegistrySnapshot(entry, new Date("2026-09-21T07:00:00.000Z"), "/public"),
    null,
  );
  assert.equal(
    currentRegistrySnapshot(entry, new Date("2026-09-21T01:00:00.000Z"), "/private"),
    null,
  );
});

test("automated robots decisions are reusable only for the exact checked path", () => {
  const automatic = {
    id: 2,
    domain: "publisher.example",
    decisionOrigin: "automated",
    pathScope: "/private",
    sourceType: "publisher",
    accessStatus: "PROHIBITED",
    accessMethod: "public_web",
    robotsResult: "disallowed",
    licenceOrTermsNotes: null,
    owner: null,
    reviewedAt: new Date("2026-09-21T00:00:00.000Z"),
    reviewDueAt: new Date("2026-09-22T00:00:00.000Z"),
    allowedUses: [],
    restrictions: ["robots_disallowed"],
    automatedObservation: null,
    createdAt: new Date("2026-09-21T00:00:00.000Z"),
    updatedAt: new Date("2026-09-21T00:00:00.000Z"),
  } satisfies SourceRegistryEntry;
  const now = new Date("2026-09-21T01:00:00.000Z");

  assert.equal(currentRegistrySnapshot(automatic, now, "/private")?.accessStatus, "PROHIBITED");
  assert.equal(currentRegistrySnapshot(automatic, now, "/public"), null);

  const publicAllowed = {
    ...automatic,
    pathScope: "/public",
    accessStatus: "ALLOWED" as const,
    robotsResult: "allowed" as const,
    allowedUses: ["automated_retrieval", "comparison_evidence"],
    restrictions: [],
  } satisfies SourceRegistryEntry;
  assert.equal(currentRegistrySnapshot(publicAllowed, now, "/public")?.accessStatus, "ALLOWED");
  assert.equal(currentRegistrySnapshot(publicAllowed, now, "/private"), null);
});