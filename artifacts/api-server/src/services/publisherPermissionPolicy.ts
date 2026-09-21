import type { SourceRegistryEntry } from "@workspace/db";
import type { PublisherPermissionSnapshot } from "../lib/security";

export function reviewedRegistrySnapshot(entry: SourceRegistryEntry): PublisherPermissionSnapshot {
  return {
    domain: entry.domain,
    decisionOrigin: entry.decisionOrigin,
    pathScope: entry.pathScope ?? undefined,
    sourceType: entry.sourceType,
    accessStatus: entry.accessStatus,
    accessMethod: entry.accessMethod,
    robotsResult: entry.robotsResult,
    licenceOrTermsNotes: entry.licenceOrTermsNotes ?? undefined,
    owner: entry.owner ?? undefined,
    reviewedAt: entry.reviewedAt.toISOString(),
    reviewDueAt: entry.reviewDueAt.toISOString(),
    allowedUses: entry.allowedUses,
    restrictions: entry.restrictions,
  };
}

export function currentRegistrySnapshot(
  entry: SourceRegistryEntry,
  now: Date,
  pathname: string,
): PublisherPermissionSnapshot | null {
  if (
    entry.reviewDueAt > now
    && (entry.pathScope == null || entry.pathScope === "/" || entry.pathScope === pathname)
  ) return reviewedRegistrySnapshot(entry);
  const observation = entry.automatedObservation;
  if (
    !observation
    || observation.pathScope !== pathname
    || new Date(observation.checkDueAt) <= now
  ) return null;
  return {
    domain: entry.domain,
    decisionOrigin: "automated",
    pathScope: observation.pathScope,
    sourceType: "publisher",
    accessStatus: observation.accessStatus,
    accessMethod: "public_web",
    robotsResult: observation.robotsResult,
    reviewedAt: observation.checkedAt,
    reviewDueAt: observation.checkDueAt,
    allowedUses: observation.allowedUses,
    restrictions: observation.restrictions,
  };
}