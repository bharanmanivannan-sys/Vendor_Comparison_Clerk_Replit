import { and, desc, eq, ilike, lte, or, sql } from "drizzle-orm";
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

/**
 * Return a small set of fresh automated observations whose publisher identity
 * is apparent from the host, path, or registered owner. These are URL
 * candidates only; callers must re-check current policy before retrieval.
 */
export async function findCachedPublisherUrls(identity: string, now: Date, limit = 12): Promise<string[]> {
  const phrase = identity.trim().toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!phrase) return [];
  const compactIdentity = phrase.replace(/\s+/g, "");
  const patterns = [...new Set([
    `%${phrase.replace(/\s+/g, "%")}%`,
    `%${compactIdentity}%`,
  ])];
  const identityConditions = patterns.flatMap((pattern) => [
    ilike(sourceRegistryTable.domain, pattern),
    ilike(sourceRegistryTable.pathScope, pattern),
    ilike(sourceRegistryTable.owner, pattern),
    sql`${sourceRegistryTable.automatedObservation} ->> 'pathScope' ILIKE ${pattern}`,
  ]);
  const observation = sourceRegistryTable.automatedObservation;
  const freshAllowedObservation = and(
    sql`(${observation} ->> 'accessStatus') = 'ALLOWED'`,
    sql`(${observation} ->> 'robotsResult') = 'allowed'`,
    sql`(${observation} ->> 'checkDueAt') > ${now.toISOString()}`,
    sql`(${observation} -> 'allowedUses') ? 'automated_retrieval'`,
    sql`(${observation} -> 'allowedUses') ? 'comparison_evidence'`,
  );
  const currentAutomatedDecision = and(
    eq(sourceRegistryTable.decisionOrigin, "automated"),
    eq(sourceRegistryTable.accessStatus, "ALLOWED"),
    eq(sourceRegistryTable.accessMethod, "public_web"),
    eq(sourceRegistryTable.robotsResult, "allowed"),
    sql`${sourceRegistryTable.reviewDueAt} > ${now}`,
    sql`${sourceRegistryTable.allowedUses} ? 'automated_retrieval'`,
    sql`${sourceRegistryTable.allowedUses} ? 'comparison_evidence'`,
  );
  const expiredReviewObservation = and(
    eq(sourceRegistryTable.decisionOrigin, "reviewed"),
    lte(sourceRegistryTable.reviewDueAt, now),
    freshAllowedObservation,
  );

  const entries = await db
    .select()
    .from(sourceRegistryTable)
    .where(and(
      or(currentAutomatedDecision, expiredReviewObservation),
      or(...identityConditions),
    ))
    .orderBy(desc(sourceRegistryTable.updatedAt))
    .limit(100);
  const matches = (value: string | null | undefined) => {
    if (!value) return false;
    const normalized = value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return ` ${normalized} `.includes(` ${phrase} `)
      || normalized.split(" ").includes(compactIdentity);
  };
  const urls: string[] = [];
  for (const entry of entries) {
    const observation = entry.automatedObservation;
    const useObservation = entry.decisionOrigin === "reviewed" && entry.reviewDueAt <= now;
    if (useObservation) {
      if (!observation
        || observation.accessStatus !== "ALLOWED"
        || observation.robotsResult !== "allowed"
        || !observation.allowedUses.includes("automated_retrieval")
        || !observation.allowedUses.includes("comparison_evidence")
        || !Number.isFinite(Date.parse(observation.checkDueAt))
        || Date.parse(observation.checkDueAt) <= now.getTime()) continue;
    } else if (entry.decisionOrigin !== "automated"
      || entry.accessStatus !== "ALLOWED"
      || entry.accessMethod !== "public_web"
      || entry.robotsResult !== "allowed"
      || !entry.allowedUses.includes("automated_retrieval")
      || !entry.allowedUses.includes("comparison_evidence")
      || entry.reviewDueAt <= now) continue;
    const path = (useObservation ? observation?.pathScope : entry.pathScope) || "/";
    const url = `https://${entry.domain}${path.startsWith("/") ? path : `/${path}`}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || !(matches(parsed.hostname) || matches(parsed.pathname) || matches(entry.owner))) continue;
    urls.push(parsed.toString());
    if (urls.length >= Math.max(1, Math.min(12, limit))) break;
  }
  return [...new Set(urls)];
}

export function registrySnapshotForResult(
  result: EvidenceUrlResult,
): PublisherPermissionSnapshot | undefined {
  return result.registryDecision;
}