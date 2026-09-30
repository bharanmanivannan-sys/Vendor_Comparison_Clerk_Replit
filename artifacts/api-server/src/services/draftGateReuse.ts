import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Request, Response } from "express";
import {
  comparisonJobCheckpointsTable,
  comparisonDraftEnrichmentJobsTable,
  comparisonDraftsTable,
  db,
  relevanceGateCheckpointsTable,
  type RelevanceGateCheckpoint,
} from "@workspace/db";
import { getOrCreateVisitorSessionId } from "./visitorSessions";
import { assessMarketRelevance, type RelevanceEvidence } from "../lib/marketRelevance";
import {
  contextForDraft,
  draftCandidateForOption,
  draftGateIdentityForOption,
} from "./draftGateIdentity";
import {
  hashRelevanceContext,
  isCompatibleRelevanceCheckpoint,
  isRelevanceCheckpointFresh,
  recoverRelevanceGateCheckpoint,
  type RelevanceGateIdentity,
} from "./relevanceGateCheckpoints";

export function draftOwnerForComparison(req: Request, res: Response, userId?: string): string {
  if (userId) return `user:${userId}`;
  const sessionId = getOrCreateVisitorSessionId(req, res);
  return `guest:${createHash("sha256").update(`comparison-draft-owner:v1:${sessionId}`).digest("hex")}`;
}

type ConfirmedInput = {
  prompt: string;
  market?: string;
  draftId?: string;
  draftVersion?: number;
  criteria?: string[];
  demographicContext?: {
    country: string;
    city?: string;
    stateOrRegion?: string;
    postcode?: string;
    customerSegment?: string;
    useCase?: string;
    deliveryNeed?: string;
    currency?: string;
    ageGroup?: string;
    businessOrConsumer?: string;
    language?: string;
    regulatoryContext?: string[];
  };
  customerLocation?: string;
  customerSegment?: string;
  comparisonValues?: Array<{
    rawText: string;
    confirmedName: string;
    canonicalEntityId?: string;
    entityLevel?: string;
  }>;
};

export function draftMatchesConfirmedRequest(
  draft: { version: number; originalQuery: string; market: string; draft: Record<string, unknown> },
  input: ConfirmedInput,
): boolean {
  // The review can re-interpret a query with the user's confirmed priority
  // appended for parsing, while the report must still retain the original
  // prompt. Accept that exact, bounded suffix only when the same priority is
  // explicitly present in the confirmed criteria.
  const prioritySuffix = /\n\nPrimary decision priority: ([^\r\n]{1,120})\.$/.exec(draft.originalQuery);
  const sameQuery = draft.originalQuery === input.prompt
    || Boolean(prioritySuffix
      && draft.originalQuery.slice(0, prioritySuffix!.index) === input.prompt
      && input.criteria?.some((criterion) =>
        criterion.trim().toLocaleLowerCase() === prioritySuffix![1].trim().toLocaleLowerCase()));
  if (!input.draftVersion || !Number.isSafeInteger(input.draftVersion)
    || input.draftVersion < 1 || input.draftVersion !== draft.version
    || !sameQuery || draft.market !== input.market) return false;
  const saved = draft.draft;
  const options = saved.options;
  if (!Array.isArray(options) || !input.comparisonValues || options.length !== input.comparisonValues.length) return false;
  const { context, objective } = contextForDraft(saved);
  const edited = input.demographicContext;
  if ((input.customerLocation ?? "") !== (context.city ?? "")
    || (input.customerSegment ?? "") !== (context.customerSegment ?? "")
    || (edited && (
    edited.country !== draft.market
    || (edited.city ?? "") !== (context.city ?? "")
    || (edited.stateOrRegion ?? "") !== (context.region ?? "")
    || (edited.postcode ?? "") !== (context.postcode ?? "")
    || (edited.customerSegment ?? "") !== (context.customerSegment ?? "")
    || (edited.deliveryNeed && edited.deliveryNeed !== context.deliveryNeed)
    || (edited.currency && edited.currency !== context.currency)
    || (edited.useCase && edited.useCase !== objective)
    || Boolean(edited.ageGroup || edited.businessOrConsumer || edited.language || edited.regulatoryContext?.length)
  ))) return false;
  // Criteria may be edited on the confirmation page. This handoff reuses only
  // market-access proof, never an earlier draft's scores or criteria. The
  // objective, market, confirmed identities and demographic access context
  // above must still match exactly.
  if (!Array.isArray(input.criteria)) return false;
  return options.every((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const option = value as Record<string, unknown>;
    const confirmed = input.comparisonValues![index];
    const candidate = draftCandidateForOption(option, String(saved.category ?? ""));
    return confirmed.rawText === option.originalText
      && confirmed.confirmedName === String(option.comparisonValue || option.originalText)
      && (!confirmed.canonicalEntityId || confirmed.canonicalEntityId === candidate.canonicalEntityId);
  });
}

function proofEvidence(row: RelevanceGateCheckpoint, gate: string, ids: string[]): RelevanceEvidence[] {
  return row.evidence.filter((item): item is RelevanceEvidence => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const evidence = item as Partial<RelevanceEvidence>;
    return evidence.gate === gate && ids.includes(String(evidence.id))
      && evidence.currentMarketSpecific === true
      && (evidence.outcome === "PASS" || evidence.outcome === "FAIL")
      && typeof evidence.sourceUrl === "string" && /^https:\/\//i.test(evidence.sourceUrl)
      && typeof evidence.exactClaim === "string" && evidence.exactClaim.length > 0
      && typeof evidence.retrievedAt === "string" && Number.isFinite(Date.parse(evidence.retrievedAt));
  });
}

/** Only fresh, scoped publisher proof crosses from the draft worker into report research. */
export function reusableDraftGateEvidence(input: {
  draftId: string;
  jobId: string;
  jobDraftVersion: number;
  draft: Record<string, unknown>;
  values: NonNullable<ConfirmedInput["comparisonValues"]>;
  rows: RelevanceGateCheckpoint[];
  now?: Date;
}): Record<string, RelevanceEvidence[]> {
  const { context, objective, accessMode } = contextForDraft(input.draft);
  // Research can continue for two minutes after the handoff. Near-expiry proof
  // must be reassessed rather than becoming stale inside the confirmed job.
  const freshThrough = new Date((input.now ?? new Date()).getTime() + 130_000);
  const output: Record<string, RelevanceEvidence[]> = {};
  for (const [index, item] of (input.draft.options as Array<Record<string, unknown>>).entries()) {
    const candidate = draftCandidateForOption(item, String(input.draft.category ?? ""));
    const base = {
      jobId: input.jobId, draftId: input.draftId, draftVersion: input.jobDraftVersion,
      option: item, candidate, context, objective, accessMode,
    };
    const mandatory = assessMarketRelevance({
      optionId: candidate.canonicalEntityId, context, objective, evidence: [],
    }).mandatoryGateResults.filter((gate) => gate.mandatory);
    const sourceIdentity = draftGateIdentityForOption({
      ...base, gateType: "SOURCE_EVIDENCE",
      conditionSpecificGates: mandatory.map(({ gate, mandatory: required }) => ({ gate, mandatory: required })),
    });
    const source = input.rows.find((row) => isCompatibleRelevanceCheckpoint(row, sourceIdentity)
      && isRelevanceCheckpointFresh(row, freshThrough));
    const sourceResult = source?.result as { marketStatus?: string; evidence?: Array<{ id: string }> } | null;
    if (!sourceResult || !["VERIFIED_RELEVANT", "VERIFIED_NOT_RELEVANT", "VERIFIED_CONDITIONAL"].includes(sourceResult.marketStatus ?? "")
      || !Array.isArray(sourceResult.evidence) || sourceResult.evidence.length === 0) continue;
    const sourceIds = new Set(sourceResult.evidence.map((e) => e.id));
    const name = input.values[index].confirmedName;
    for (const gate of mandatory) {
      const identity = draftGateIdentityForOption({
        ...base, gateType: gate.gate,
        conditionSpecificGates: {
          gate: gate.gate, mandatory: gate.mandatory, accessMode,
          deliveryNeed: context.deliveryNeed, customerSegment: context.customerSegment ?? null,
          region: context.region ?? null, city: context.city ?? null,
          postcode: context.postcode ?? null, regulatoryContext: context.regulatoryContext ?? [],
        },
      });
      const row = input.rows.find((check) => isCompatibleRelevanceCheckpoint(check, identity)
        && isRelevanceCheckpointFresh(check, freshThrough));
      const saved = row?.result as { gateResult?: { gate?: string; status?: string; evidenceIds?: string[] } } | null;
      const result = saved?.gateResult;
      if (!row || result?.gate !== gate.gate || !["PASS", "FAIL"].includes(result.status ?? "")
        || !Array.isArray(result.evidenceIds) || result.evidenceIds.length === 0
        || !result.evidenceIds.every((id) => sourceIds.has(id))) continue;
      const proof = proofEvidence(row, gate.gate, result.evidenceIds);
      if (proof.length !== result.evidenceIds.length
        || proof.some((e) => e.outcome !== result.status
          || e.optionId !== candidate.canonicalEntityId)
        || (result.status === "PASS" && row.status !== "PASSED")
        || (result.status === "FAIL" && row.status !== "CONDITIONAL")) continue;
      output[name] ??= [];
      output[name].push(...proof.map((e) => ({ ...e, optionId: name })));
    }
  }
  return output;
}

export async function loadConfirmedDraftGateEvidence(
  input: ConfirmedInput,
  owner: string,
  comparisonJobId?: string,
): Promise<Record<string, RelevanceEvidence[]>> {
  if (!input.draftId || !input.draftVersion) return {};
  const [draft] = await db.select().from(comparisonDraftsTable).where(and(
    eq(comparisonDraftsTable.id, input.draftId),
    eq(comparisonDraftsTable.owner, owner),
  )).limit(1);
  if (!draft || !draftMatchesConfirmedRequest(draft, input)) return {};
  if (comparisonJobId) {
    await db.update(comparisonJobCheckpointsTable).set({
      draftId: draft.id,
      draftVersion: draft.version,
      draftContextHash: hashRelevanceContext({
        market: draft.market,
        prompt: input.prompt,
        context: input.demographicContext ?? null,
        objective: draft.draft.decisionObjective ?? null,
        options: input.comparisonValues,
        criteria: input.criteria,
      }),
    }).where(and(
      eq(comparisonJobCheckpointsTable.id, comparisonJobId),
    ));
  }
  const jobs = await db.select().from(comparisonDraftEnrichmentJobsTable).where(and(
    eq(comparisonDraftEnrichmentJobsTable.draftId, draft.id),
    eq(comparisonDraftEnrichmentJobsTable.owner, owner),
  )).orderBy(desc(comparisonDraftEnrichmentJobsTable.createdAt)).limit(5);
  for (const job of jobs) {
    const enrichmentAdvancedDraftVersion = job.draftVersion + 1 === input.draftVersion
      && (job.status === "complete" || job.status === "partial");
    if ((job.draftVersion !== input.draftVersion && !enrichmentAdvancedDraftVersion)
      || job.status === "stale" || job.status === "failed") continue;
    const rows = await db.select().from(relevanceGateCheckpointsTable).where(and(
      eq(relevanceGateCheckpointsTable.draftId, draft.id),
      eq(relevanceGateCheckpointsTable.jobId, job.id),
    ));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row.status === "RUNNING" && row.pendingResult && row.leaseExpiresAt
        && row.leaseExpiresAt <= new Date()) {
        const identity: RelevanceGateIdentity = {
          draftId: draft.id, jobId: job.id, optionId: row.optionId,
          gateType: row.gateType, marketContextHash: row.marketContextHash,
          objectiveHash: row.objectiveHash, confirmedIdentityVersion: row.confirmedIdentityVersion,
        };
        rows[i] = await recoverRelevanceGateCheckpoint(identity) ?? row;
      }
    }
    const evidence = reusableDraftGateEvidence({
      draftId: draft.id, jobId: job.id, jobDraftVersion: job.draftVersion,
      draft: draft.draft, values: input.comparisonValues!, rows,
    });
    if (Object.keys(evidence).length) return evidence;
  }
  return {};
}