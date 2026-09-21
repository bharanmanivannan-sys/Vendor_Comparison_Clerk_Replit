import { and, eq } from "drizzle-orm";
import {
  db,
  sourceRegistryTable,
  type SourceRegistryEntry,
} from "@workspace/db";
import type {
  EvidenceUrlResult,
  PublisherPermissionRegistry,
  PublisherPermissionSnapshot,
} from "../lib/security";
import {
  currentRegistrySnapshot,
  reviewedRegistrySnapshot,
} from "./publisherPermissionPolicy";

const ALLOWED_REVIEW_MS = 6 * 60 * 60_000;
const PROHIBITED_REVIEW_MS = 24 * 60 * 60_000;
const TRANSIENT_REVIEW_MS = 5 * 60_000;

function registryDomain(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
}

function registryPath(value: string): string {
  return new URL(value).pathname || "/";
}

function snapshot(entry: SourceRegistryEntry): PublisherPermissionSnapshot {
  return reviewedRegistrySnapshot(entry);
}

function observationSnapshot(
  domain: string,
  pathScope: string,
  result: EvidenceUrlResult,
  checkedAt: Date,
): PublisherPermissionSnapshot {
  const accessStatus = result.reason === "robots_disallowed" || result.reason === "blocked_destination"
    ? "PROHIBITED" as const
    : result.available
      ? "ALLOWED" as const
      : "ACCESS_UNAVAILABLE" as const;
  const reviewMs = accessStatus === "PROHIBITED"
    ? PROHIBITED_REVIEW_MS
    : accessStatus === "ALLOWED"
      ? ALLOWED_REVIEW_MS
      : TRANSIENT_REVIEW_MS;
  return {
    domain,
    decisionOrigin: "automated",
    pathScope,
    sourceType: "publisher",
    accessStatus,
    accessMethod: "public_web",
    robotsResult: result.reason === "robots_disallowed"
      ? "disallowed"
      : result.available ? "allowed" : "unavailable",
    reviewedAt: checkedAt.toISOString(),
    reviewDueAt: new Date(checkedAt.getTime() + reviewMs).toISOString(),
    allowedUses: accessStatus === "ALLOWED" ? ["automated_retrieval", "comparison_evidence"] : [],
    restrictions: result.reason ? [result.reason] : [],
  };
}

function automatedObservationValue(snapshot: PublisherPermissionSnapshot) {
  return {
    accessStatus: snapshot.accessStatus as "ALLOWED" | "ACCESS_UNAVAILABLE" | "PROHIBITED",
    robotsResult: snapshot.robotsResult as "allowed" | "disallowed" | "unavailable",
    checkedAt: snapshot.reviewedAt,
    checkDueAt: snapshot.reviewDueAt,
    allowedUses: snapshot.allowedUses,
    restrictions: snapshot.restrictions,
    pathScope: snapshot.pathScope ?? "/",
  };
}

async function findRegistryEntry(domain: string, pathScope: string): Promise<SourceRegistryEntry | null> {
  const [exact] = await db
    .select()
    .from(sourceRegistryTable)
    .where(and(
      eq(sourceRegistryTable.domain, domain),
      eq(sourceRegistryTable.pathScope, pathScope),
    ))
    .limit(1);
  if (exact) return exact;
  const entries = await db
    .select()
    .from(sourceRegistryTable)
    .where(eq(sourceRegistryTable.domain, domain));
  return entries.find((entry) => entry.pathScope == null || entry.pathScope === "/") ?? null;
}

export const publisherPermissionRegistry: PublisherPermissionRegistry = {
  async lookup(url, now) {
    let domain: string;
    try {
      domain = registryDomain(url);
    } catch {
      return null;
    }
    const entry = await findRegistryEntry(domain, registryPath(url));
    if (!entry) return null;
    return currentRegistrySnapshot(entry, now, registryPath(url));
  },

  async record(url, result, checkedAt) {
    let domain: string;
    try {
      domain = registryDomain(result.finalUrl ?? url);
    } catch {
      return null;
    }
    const pathScope = registryPath(result.finalUrl ?? url);
    const existing = await findRegistryEntry(domain, pathScope);
    // Automated public-web observations never rewrite reviewed licence or
    // customer-supplied policy. Expiry stops that decision authorising a
    // request, but a human must review and replace its terms and ownership.
    if (existing?.decisionOrigin === "reviewed") {
      if (existing.reviewDueAt > checkedAt) return snapshot(existing);
      const observation = observationSnapshot(domain, pathScope, result, checkedAt);
      await db
        .update(sourceRegistryTable)
        .set({
          automatedObservation: automatedObservationValue(observation),
          updatedAt: checkedAt,
        })
        .where(eq(sourceRegistryTable.id, existing.id));
      return observation;
    }

    const observation = observationSnapshot(domain, pathScope, result, checkedAt);
    const values = {
      domain,
      decisionOrigin: "automated" as const,
      pathScope,
      sourceType: existing?.sourceType ?? "publisher" as const,
      accessStatus: observation.accessStatus,
      accessMethod: "public_web" as const,
      robotsResult: observation.robotsResult,
      licenceOrTermsNotes: existing?.licenceOrTermsNotes ?? null,
      owner: existing?.owner ?? null,
      reviewedAt: checkedAt,
      reviewDueAt: new Date(observation.reviewDueAt),
      allowedUses: observation.allowedUses,
      restrictions: observation.restrictions,
      automatedObservation: null,
      updatedAt: checkedAt,
    };
    const [stored] = await db
      .insert(sourceRegistryTable)
      .values(values)
      .onConflictDoUpdate({
        target: [sourceRegistryTable.domain, sourceRegistryTable.pathScope],
        set: values,
        setWhere: eq(sourceRegistryTable.decisionOrigin, "automated"),
      })
      .returning();
    if (stored) return snapshot(stored);
    await db
      .update(sourceRegistryTable)
      .set({
        automatedObservation: automatedObservationValue(observation),
        updatedAt: checkedAt,
      })
      .where(and(
          eq(sourceRegistryTable.domain, domain),
          eq(sourceRegistryTable.pathScope, pathScope),
      ));
    return observation;
  },
};

export function registrySnapshotForResult(
  result: EvidenceUrlResult,
): PublisherPermissionSnapshot | undefined {
  return result.registryDecision;
}