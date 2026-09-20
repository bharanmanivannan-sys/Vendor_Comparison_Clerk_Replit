OneComparisonIdentityEntityCountMin = 2;
export const getGuestComparisonJobResponseResultOneOneComparisonIdentityEntityCountMax = 5;

export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemScoreMin = 0;
export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemScoreMax = 100;

export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin = 0;

export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin = 0;
export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax = 100;

export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin = 0;
export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax = 100;

export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin = 0;
export const getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax = 100;

export const getGuestComparisonJobResponseResultTwoComparisonIdentityEntitiesMin = 2;
export const getGuestComparisonJobResponseResultTwoComparisonIdentityEntitiesMax = 5;

export const getGuestComparisonJobResponseResultTwoComparisonIdentityEntityCountMin = 2;
export const getGuestComparisonJobResponseResultTwoComparisonIdentityEntityCountMax = 5;

export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemScoreMin = 0;
export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemScoreMax = 100;

export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin = 0;

export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin = 0;
export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax = 100;

export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin = 0;
export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax = 100;

export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin = 0;
export const getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax = 100;



export const GetGuestComparisonJobResponse = zod.object({
  "status": zod.enum(['processing', 'complete', 'failed']),
  "stage": zod.enum(['researching', 'validating', 'completed']),
  "result": zod.union([zod.object({
  "id": zod.number().int(),
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(getGuestComparisonJobResponseResultOneOneComparisonIdentityEntitiesMin).max(getGuestComparisonJobResponseResultOneOneComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(getGuestComparisonJobResponseResultOneOneComparisonIdentityEntityCountMin).max(getGuestComparisonJobResponseResultOneOneComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "createdAt": zod.coerce.date(),
  "status": zod.enum(['complete', 'processing', 'failed'])
}).and(zod.object({
  "urls": zod.array(zod.string()),
  "sourceAvailability": zod.array(zod.object({
  "url": zod.string().url(),
  "status": zod.enum(['reachable', 'restricted', 'timed_out', 'unavailable', 'superseded']),
  "reason": zod.string(),
  "replacementUrl": zod.string().url().optional()
})).describe('Availability information for every source checked while producing the report. Legacy reports may return reachable entries derived from urls.'),
  "criteria": zod.array(zod.string()),
  "executiveSummary": zod.string(),
  "recommendationReason": zod.string(),
  "vendorScores": zod.array(zod.object({
  "vendor": zod.string(),
  "score": zod.number().int(),
  "color": zod.string(),
  "verdict": zod.string(),
  "providerRole": zod.enum(['accelerator', 'leader', 'core_provider', 'expert']).optional().describe('Strategic market role of the product, service, or brand in this decision context.'),
  "providerRoleRationale": zod.string().optional().describe('Evidence-based explanation for the assigned strategic market role.'),
  "weightedScores": zod.array(zod.object({
  "criterion": zod.string(),
  "weight": zod.number().int(),
  "score": zod.number().int().min(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemScoreMin).max(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemScoreMax),
  "rationale": zod.string(),
  "evidence": zod.array(zod.object({
  "sourceUrl": zod.string().url().optional(),
  "sourceTitle": zod.string().optional(),
  "sourcePublisher": zod.string().optional(),
  "sourceDate": zod.coerce.date().optional(),
  "retrievalDate": zod.coerce.date(),
  "exactClaim": zod.string(),
  "rawMetricValue": zod.number().optional(),
  "rawMetricUnit": zod.string().optional(),
  "sampleSize": zod.number().int().min(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin).optional(),
  "evidenceKind": zod.enum(['quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified']),
  "supportDirection": zod.enum(['supports', 'contradicts', 'context', 'neutral']),
  "confidence": zod.number().int().min(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin).max(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax),
  "normalizedScore": zod.number().int().min(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin).max(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax),
  "criterionWeight": zod.number().int().min(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin).max(getGuestComparisonJobResponseResultOneTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax),
  "weightedContribution": zod.number(),
  "normalizationMethod": zod.string()
})).optional()
})).optional(),
  "switchConditions": zod.array(zod.string()).optional().describe('Conditions under which this option should be preferred over the overall recommendation.'),
  "vrio": zod.object({
  "value": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "rarity": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "imitability": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "organization": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "implication": zod.string()
}).optional(),
  "marketPosition": zod.object({
  "marketShare": zod.string().describe('Latest credible market-share figure or an explicit unavailable statement.'),
  "marketSharePeriod": zod.string(),
  "market": zod.string(),
  "shareValue": zod.string().describe('Public parent-company share price/value when applicable, otherwise Not applicable.'),
  "shareValueAsOf": zod.string(),
  "applicability": zod.string(),
  "evidence": zod.string()
}).optional(),
  "marketHistory": zod.object({
  "lookbackYears": zod.literal(5),
  "trendSummary": zod.string(),
  "yearlyTrends": zod.array(zod.object({
  "year": zod.number().int(),
  "productPerformance": zod.string(),
  "marketPosition": zod.string(),
  "trendDirection": zod.enum(['improving', 'stable', 'declining', 'mixed', 'unavailable']),
  "notableEvent": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "ownership": zod.object({
  "status": zod.enum(['public', 'private', 'subsidiary', 'government', 'mutual', 'unknown']),
  "ultimateParent": zod.string(),
  "majorShareholders": zod.array(zod.string()),
  "asOf": zod.string(),
  "evidenceUrl": zod.string().url().optional()
}),
  "transactions": zod.array(zod.object({
  "date": zod.string(),
  "type": zod.enum(['merger', 'acquisition', 'divestiture', 'investment', 'restructure', 'none_found']),
  "counterparty": zod.string(),
  "summary": zod.string(),
  "impact": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "stock": zod.object({
  "applicability": zod.enum(['listed', 'listed_parent', 'private', 'not_applicable', 'unverified']),
  "ticker": zod.string(),
  "exchange": zod.string(),
  "currency": zod.string(),
  "latestPrice": zod.number().nullable(),
  "latestPriceAsOf": zod.string(),
  "fiveYearChangePercent": zod.number().nullable(),
  "yearlyCloses": zod.array(zod.object({
  "year": zod.number().int(),
  "price": zod.number().nullable()
})),
  "evidenceUrl": zod.string().url().optional()
})
}).optional().describe('Evidence-backed five-year performance, ownership, corporate-action, and listed-stock context for one compared option.')
})),
  "pricing": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "features": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "swot": zod.record(zod.string(), zod.array(zod.string())),
  "opportunities": zod.array(zod.string()),
  "insights": zod.array(zod.string()),
  "nextSteps": zod.array(zod.string()),
  "contextAssumptions": zod.array(zod.string()).describe('Explicit assumptions made where business, regulatory, security, commercial, operating, integration, data, or maturity context was missing.'),
  "productEquivalency": zod.array(zod.object({
  "capability": zod.string(),
  "currentArrangement": zod.string(),
  "targetArrangement": zod.string(),
  "equivalency": zod.string().describe('Full'),
  "gap": zod.string()
})).describe('Like-for-like mapping of current and target products or services, including partial equivalence and uncovered scope.'),
  "functionalGaps": zod.array(zod.object({
  "capability": zod.string(),
  "currentState": zod.string(),
  "targetState": zod.string(),
  "gap": zod.string(),
  "mitigation": zod.string(),
  "severity": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Required capabilities that are absent, partial, changed, or unverified in the target arrangement.'),
  "serviceProductMap": zod.array(zod.object({
  "businessService": zod.string(),
  "currentProduct": zod.string(),
  "targetProduct": zod.string(),
  "dependencies": zod.string(),
  "owner": zod.string()
})).describe('Mapping between business services and the products, dependencies, and owners that enable them.'),
  "migrationSequence": zod.array(zod.object({
  "phase": zod.string(),
  "objective": zod.string(),
  "dependencies": zod.string(),
  "exitCriteria": zod.string(),
  "risk": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Ordered migration phases with dependencies, exit criteria, and risk.'),
  "decisionGovernance": zod.array(zod.object({
  "decision": zod.string(),
  "owner": zod.string(),
  "approvers": zod.string(),
  "evidenceRequired": zod.string(),
  "decisionGate": zod.string()
})).describe('Decision rights, evidence requirements, approvers, and approval gates.')
})),zod.object({
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(getGuestComparisonJobResponseResultTwoComparisonIdentityEntitiesMin).max(getGuestComparisonJobResponseResultTwoComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(getGuestComparisonJobResponseResultTwoComparisonIdentityEntityCountMin).max(getGuestComparisonJobResponseResultTwoComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "status": zod.enum(['complete', 'processing', 'failed']),
  "createdAt": zod.coerce.date(),
  "urls": zod.array(zod.string()),
  "sourceAvailability": zod.array(zod.object({
  "url": zod.string().url(),
  "status": zod.enum(['reachable', 'restricted', 'timed_out', 'unavailable', 'superseded']),
  "reason": zod.string(),
  "replacementUrl": zod.string().url().optional()
})),
  "criteria": zod.array(zod.string()),
  "executiveSummary": zod.string(),
  "recommendationReason": zod.string(),
  "vendorScores": zod.array(zod.object({
  "vendor": zod.string(),
  "score": zod.number().int(),
  "color": zod.string(),
  "verdict": zod.string(),
  "providerRole": zod.enum(['accelerator', 'leader', 'core_provider', 'expert']).optional().describe('Strategic market role of the product, service, or brand in this decision context.'),
  "providerRoleRationale": zod.string().optional().describe('Evidence-based explanation for the assigned strategic market role.'),
  "weightedScores": zod.array(zod.object({
  "criterion": zod.string(),
  "weight": zod.number().int(),
  "score": zod.number().int().min(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemScoreMin).max(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemScoreMax),
  "rationale": zod.string(),
  "evidence": zod.array(zod.object({
  "sourceUrl": zod.string().url().optional(),
  "sourceTitle": zod.string().optional(),
  "sourcePublisher": zod.string().optional(),
  "sourceDate": zod.coerce.date().optional(),
  "retrievalDate": zod.coerce.date(),
  "exactClaim": zod.string(),
  "rawMetricValue": zod.number().optional(),
  "rawMetricUnit": zod.string().optional(),
  "sampleSize": zod.number().int().min(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin).optional(),
  "evidenceKind": zod.enum(['quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified']),
  "supportDirection": zod.enum(['supports', 'contradicts', 'context', 'neutral']),
  "confidence": zod.number().int().min(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin).max(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax),
  "normalizedScore": zod.number().int().min(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin).max(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax),
  "criterionWeight": zod.number().int().min(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin).max(getGuestComparisonJobResponseResultTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax),
  "weightedContribution": zod.number(),
  "normalizationMethod": zod.string()
})).optional()
})).optional(),
  "switchConditions": zod.array(zod.string()).optional().describe('Conditions under which this option should be preferred over the overall recommendation.'),
  "vrio": zod.object({
  "value": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "rarity": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "imitability": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "organization": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "implication": zod.string()
}).optional(),
  "marketPosition": zod.object({
  "marketShare": zod.string().describe('Latest credible market-share figure or an explicit unavailable statement.'),
  "marketSharePeriod": zod.string(),
  "market": zod.string(),
  "shareValue": zod.string().describe('Public parent-company share price/value when applicable, otherwise Not applicable.'),
  "shareValueAsOf": zod.string(),
  "applicability": zod.string(),
  "evidence": zod.string()
}).optional(),
  "marketHistory": zod.object({
  "lookbackYears": zod.literal(5),
  "trendSummary": zod.string(),
  "yearlyTrends": zod.array(zod.object({
  "year": zod.number().int(),
  "productPerformance": zod.string(),
  "marketPosition": zod.string(),
  "trendDirection": zod.enum(['improving', 'stable', 'declining', 'mixed', 'unavailable']),
  "notableEvent": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "ownership": zod.object({
  "status": zod.enum(['public', 'private', 'subsidiary', 'government', 'mutual', 'unknown']),
  "ultimateParent": zod.string(),
  "majorShareholders": zod.array(zod.string()),
  "asOf": zod.string(),
  "evidenceUrl": zod.string().url().optional()
}),
  "transactions": zod.array(zod.object({
  "date": zod.string(),
  "type": zod.enum(['merger', 'acquisition', 'divestiture', 'investment', 'restructure', 'none_found']),
  "counterparty": zod.string(),
  "summary": zod.string(),
  "impact": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "stock": zod.object({
  "applicability": zod.enum(['listed', 'listed_parent', 'private', 'not_applicable', 'unverified']),
  "ticker": zod.string(),
  "exchange": zod.string(),
  "currency": zod.string(),
  "latestPrice": zod.number().nullable(),
  "latestPriceAsOf": zod.string(),
  "fiveYearChangePercent": zod.number().nullable(),
  "yearlyCloses": zod.array(zod.object({
  "year": zod.number().int(),
  "price": zod.number().nullable()
})),
  "evidenceUrl": zod.string().url().optional()
})
}).optional().describe('Evidence-backed five-year performance, ownership, corporate-action, and listed-stock context for one compared option.')
})),
  "pricing": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "features": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "swot": zod.record(zod.string(), zod.array(zod.string())),
  "opportunities": zod.array(zod.string()),
  "insights": zod.array(zod.string()),
  "nextSteps": zod.array(zod.string()),
  "contextAssumptions": zod.array(zod.string()),
  "productEquivalency": zod.array(zod.object({
  "capability": zod.string(),
  "currentArrangement": zod.string(),
  "targetArrangement": zod.string(),
  "equivalency": zod.string().describe('Full'),
  "gap": zod.string()
})),
  "functionalGaps": zod.array(zod.object({
  "capability": zod.string(),
  "currentState": zod.string(),
  "targetState": zod.string(),
  "gap": zod.string(),
  "mitigation": zod.string(),
  "severity": zod.enum(['low', 'medium', 'high', 'critical'])
})),
  "serviceProductMap": zod.array(zod.object({
  "businessService": zod.string(),
  "currentProduct": zod.string(),
  "targetProduct": zod.string(),
  "dependencies": zod.string(),
  "owner": zod.string()
})),
  "migrationSequence": zod.array(zod.object({
  "phase": zod.string(),
  "objective": zod.string(),
  "dependencies": zod.string(),
  "exitCriteria": zod.string(),
  "risk": zod.enum(['low', 'medium', 'high', 'critical'])
})),
  "decisionGovernance": zod.array(zod.object({
  "decision": zod.string(),
  "owner": zod.string(),
  "approvers": zod.string(),
  "evidenceRequired": zod.string(),
  "decisionGate": zod.string()
}))
})]).optional(),
  "message": zod.string().optional(),
  "errorCode": zod.enum(['research_failed', 'validation_failed']).optional()
}).describe('Pollable state for asynchronous comparison research.')


/**
 * @summary Get a comparison analysis
 */
export const GetComparisonParams = zod.object({
  "id": zod.coerce.number().int()
})

export const getComparisonResponseOneComparisonIdentityEntitiesMin = 2;
export const getComparisonResponseOneComparisonIdentityEntitiesMax = 5;

export const getComparisonResponseOneComparisonIdentityEntityCountMin = 2;
export const getComparisonResponseOneComparisonIdentityEntityCountMax = 5;

export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin = 0;
export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax = 100;

export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin = 0;

export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin = 0;
export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax = 100;

export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin = 0;
export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax = 100;

export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin = 0;
export const getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax = 100;



export const GetComparisonResponse = zod.object({
  "id": zod.number().int(),
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(getComparisonResponseOneComparisonIdentityEntitiesMin).max(getComparisonResponseOneComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(getComparisonResponseOneComparisonIdentityEntityCountMin).max(getComparisonResponseOneComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "createdAt": zod.coerce.date(),
  "status": zod.enum(['complete', 'processing', 'failed'])
}).and(zod.object({
  "urls": zod.array(zod.string()),
  "sourceAvailability": zod.array(zod.object({
  "url": zod.string().url(),
  "status": zod.enum(['reachable', 'restricted', 'timed_out', 'unavailable', 'superseded']),
  "reason": zod.string(),
  "replacementUrl": zod.string().url().optional()
})).describe('Availability information for every source checked while producing the report. Legacy reports may return reachable entries derived from urls.'),
  "criteria": zod.array(zod.string()),
  "executiveSummary": zod.string(),
  "recommendationReason": zod.string(),
  "vendorScores": zod.array(zod.object({
  "vendor": zod.string(),
  "score": zod.number().int(),
  "color": zod.string(),
  "verdict": zod.string(),
  "providerRole": zod.enum(['accelerator', 'leader', 'core_provider', 'expert']).optional().describe('Strategic market role of the product, service, or brand in this decision context.'),
  "providerRoleRationale": zod.string().optional().describe('Evidence-based explanation for the assigned strategic market role.'),
  "weightedScores": zod.array(zod.object({
  "criterion": zod.string(),
  "weight": zod.number().int(),
  "score": zod.number().int().min(getComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin).max(getComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax),
  "rationale": zod.string(),
  "evidence": zod.array(zod.object({
  "sourceUrl": zod.string().url().optional(),
  "sourceTitle": zod.string().optional(),
  "sourcePublisher": zod.string().optional(),
  "sourceDate": zod.coerce.date().optional(),
  "retrievalDate": zod.coerce.date(),
  "exactClaim": zod.string(),
  "rawMetricValue": zod.number().optional(),
  "rawMetricUnit": zod.string().optional(),
  "sampleSize": zod.number().int().min(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin).optional(),
  "evidenceKind": zod.enum(['quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified']),
  "supportDirection": zod.enum(['supports', 'contradicts', 'context', 'neutral']),
  "confidence": zod.number().int().min(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin).max(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax),
  "normalizedScore": zod.number().int().min(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin).max(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax),
  "criterionWeight": zod.number().int().min(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin).max(getComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax),
  "weightedContribution": zod.number(),
  "normalizationMethod": zod.string()
})).optional()
})).optional(),
  "switchConditions": zod.array(zod.string()).optional().describe('Conditions under which this option should be preferred over the overall recommendation.'),
  "vrio": zod.object({
  "value": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "rarity": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "imitability": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "organization": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "implication": zod.string()
}).optional(),
  "marketPosition": zod.object({
  "marketShare": zod.string().describe('Latest credible market-share figure or an explicit unavailable statement.'),
  "marketSharePeriod": zod.string(),
  "market": zod.string(),
  "shareValue": zod.string().describe('Public parent-company share price/value when applicable, otherwise Not applicable.'),
  "shareValueAsOf": zod.string(),
  "applicability": zod.string(),
  "evidence": zod.string()
}).optional(),
  "marketHistory": zod.object({
  "lookbackYears": zod.literal(5),
  "trendSummary": zod.string(),
  "yearlyTrends": zod.array(zod.object({
  "year": zod.number().int(),
  "productPerformance": zod.string(),
  "marketPosition": zod.string(),
  "trendDirection": zod.enum(['improving', 'stable', 'declining', 'mixed', 'unavailable']),
  "notableEvent": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "ownership": zod.object({
  "status": zod.enum(['public', 'private', 'subsidiary', 'government', 'mutual', 'unknown']),
  "ultimateParent": zod.string(),
  "majorShareholders": zod.array(zod.string()),
  "asOf": zod.string(),
  "evidenceUrl": zod.string().url().optional()
}),
  "transactions": zod.array(zod.object({
  "date": zod.string(),
  "type": zod.enum(['merger', 'acquisition', 'divestiture', 'investment', 'restructure', 'none_found']),
  "counterparty": zod.string(),
  "summary": zod.string(),
  "impact": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "stock": zod.object({
  "applicability": zod.enum(['listed', 'listed_parent', 'private', 'not_applicable', 'unverified']),
  "ticker": zod.string(),
  "exchange": zod.string(),
  "currency": zod.string(),
  "latestPrice": zod.number().nullable(),
  "latestPriceAsOf": zod.string(),
  "fiveYearChangePercent": zod.number().nullable(),
  "yearlyCloses": zod.array(zod.object({
  "year": zod.number().int(),
  "price": zod.number().nullable()
})),
  "evidenceUrl": zod.string().url().optional()
})
}).optional().describe('Evidence-backed five-year performance, ownership, corporate-action, and listed-stock context for one compared option.')
})),
  "pricing": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "features": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "swot": zod.record(zod.string(), zod.array(zod.string())),
  "opportunities": zod.array(zod.string()),
  "insights": zod.array(zod.string()),
  "nextSteps": zod.array(zod.string()),
  "contextAssumptions": zod.array(zod.string()).describe('Explicit assumptions made where business, regulatory, security, commercial, operating, integration, data, or maturity context was missing.'),
  "productEquivalency": zod.array(zod.object({
  "capability": zod.string(),
  "currentArrangement": zod.string(),
  "targetArrangement": zod.string(),
  "equivalency": zod.string().describe('Full'),
  "gap": zod.string()
})).describe('Like-for-like mapping of current and target products or services, including partial equivalence and uncovered scope.'),
  "functionalGaps": zod.array(zod.object({
  "capability": zod.string(),
  "currentState": zod.string(),
  "targetState": zod.string(),
  "gap": zod.string(),
  "mitigation": zod.string(),
  "severity": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Required capabilities that are absent, partial, changed, or unverified in the target arrangement.'),
  "serviceProductMap": zod.array(zod.object({
  "businessService": zod.string(),
  "currentProduct": zod.string(),
  "targetProduct": zod.string(),
  "dependencies": zod.string(),
  "owner": zod.string()
})).describe('Mapping between business services and the products, dependencies, and owners that enable them.'),
  "migrationSequence": zod.array(zod.object({
  "phase": zod.string(),
  "objective": zod.string(),
  "dependencies": zod.string(),
  "exitCriteria": zod.string(),
  "risk": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Ordered migration phases with dependencies, exit criteria, and risk.'),
  "decisionGovernance": zod.array(zod.object({
  "decision": zod.string(),
  "owner": zod.string(),
  "approvers": zod.string(),
  "evidenceRequired": zod.string(),
  "decisionGate": zod.string()
})).describe('Decision rights, evidence requirements, approvers, and approval gates.')
}))


/**
 * @summary Delete a comparison from history
 */
export const DeleteComparisonParams = zod.object({
  "id": zod.coerce.number().int()
})

export const DeleteComparisonResponse = zod.void()


/**
 * Requires an API key with the comparisons:read scope.
 * @summary List tenant comparisons
 */
export const externalListComparisonsQueryLimitDefault = 50;
export const externalListComparisonsQueryLimitMax = 100;



export const ExternalListComparisonsQueryParams = zod.object({
  "limit": zod.coerce.number().int().min(1).max(externalListComparisonsQueryLimitMax).default(externalListComparisonsQueryLimitDefault),
  "cursor": zod.coerce.string().optional()
})

export const externalListComparisonsResponseComparisonIdentityEntitiesMin = 2;
export const externalListComparisonsResponseComparisonIdentityEntitiesMax = 5;

export const externalListComparisonsResponseComparisonIdentityEntityCountMin = 2;
export const externalListComparisonsResponseComparisonIdentityEntityCountMax = 5;



export const ExternalListComparisonsResponseItem = zod.object({
  "id": zod.number().int(),
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(externalListComparisonsResponseComparisonIdentityEntitiesMin).max(externalListComparisonsResponseComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(externalListComparisonsResponseComparisonIdentityEntityCountMin).max(externalListComparisonsResponseComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "createdAt": zod.coerce.date(),
  "status": zod.enum(['complete', 'processing', 'failed'])
})
export const ExternalListComparisonsResponse = zod.array(ExternalListComparisonsResponseItem)


/**
 * Requires an API key with the comparisons:write scope and an Idempotency-Key. Only successful completed comparisons consume usage; retries with the same request are replayed.
 * @summary Create a metered tenant comparison
 */
export const externalCreateComparisonHeaderIdempotencyKeyMin = 8;
export const externalCreateComparisonHeaderIdempotencyKeyMax = 255;



export const ExternalCreateComparisonHeader = zod.object({
  "Idempotency-Key": zod.string().min(externalCreateComparisonHeaderIdempotencyKeyMin).max(externalCreateComparisonHeaderIdempotencyKeyMax).describe('Unique key for this request; reusing it with a changed body returns 409.')
})

export const externalCreateComparisonBodyPromptMin = 8;
export const externalCreateComparisonBodyPromptMax = 2000;

export const externalCreateComparisonBodyVendorsItemMax = 120;

export const externalCreateComparisonBodyVendorsMin = 2;
export const externalCreateComparisonBodyVendorsMax = 5;

export const externalCreateComparisonBodyCriteriaItemMax = 100;

export const externalCreateComparisonBodyCriteriaMax = 8;



export const ExternalCreateComparisonBody = zod.object({
  "prompt": zod.string().min(externalCreateComparisonBodyPromptMin).max(externalCreateComparisonBodyPromptMax),
  "vendors": zod.array(zod.string().min(1).max(externalCreateComparisonBodyVendorsItemMax)).min(externalCreateComparisonBodyVendorsMin).max(externalCreateComparisonBodyVendorsMax).optional(),
  "urls": zod.array(zod.string().url()).optional(),
  "criteria": zod.array(zod.string().min(1).max(externalCreateComparisonBodyCriteriaItemMax)).max(externalCreateComparisonBodyCriteriaMax).optional()
})

export const externalCreateComparisonResponseOneComparisonIdentityEntitiesMin = 2;
export const externalCreateComparisonResponseOneComparisonIdentityEntitiesMax = 5;

export const externalCreateComparisonResponseOneComparisonIdentityEntityCountMin = 2;
export const externalCreateComparisonResponseOneComparisonIdentityEntityCountMax = 5;

export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin = 0;
export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax = 100;

export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin = 0;

export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin = 0;
export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax = 100;

export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin = 0;
export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax = 100;

export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin = 0;
export const externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax = 100;



export const ExternalCreateComparisonResponse = zod.object({
  "id": zod.number().int(),
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(externalCreateComparisonResponseOneComparisonIdentityEntitiesMin).max(externalCreateComparisonResponseOneComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(externalCreateComparisonResponseOneComparisonIdentityEntityCountMin).max(externalCreateComparisonResponseOneComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "createdAt": zod.coerce.date(),
  "status": zod.enum(['complete', 'processing', 'failed'])
}).and(zod.object({
  "urls": zod.array(zod.string()),
  "sourceAvailability": zod.array(zod.object({
  "url": zod.string().url(),
  "status": zod.enum(['reachable', 'restricted', 'timed_out', 'unavailable', 'superseded']),
  "reason": zod.string(),
  "replacementUrl": zod.string().url().optional()
})).describe('Availability information for every source checked while producing the report. Legacy reports may return reachable entries derived from urls.'),
  "criteria": zod.array(zod.string()),
  "executiveSummary": zod.string(),
  "recommendationReason": zod.string(),
  "vendorScores": zod.array(zod.object({
  "vendor": zod.string(),
  "score": zod.number().int(),
  "color": zod.string(),
  "verdict": zod.string(),
  "providerRole": zod.enum(['accelerator', 'leader', 'core_provider', 'expert']).optional().describe('Strategic market role of the product, service, or brand in this decision context.'),
  "providerRoleRationale": zod.string().optional().describe('Evidence-based explanation for the assigned strategic market role.'),
  "weightedScores": zod.array(zod.object({
  "criterion": zod.string(),
  "weight": zod.number().int(),
  "score": zod.number().int().min(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin).max(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax),
  "rationale": zod.string(),
  "evidence": zod.array(zod.object({
  "sourceUrl": zod.string().url().optional(),
  "sourceTitle": zod.string().optional(),
  "sourcePublisher": zod.string().optional(),
  "sourceDate": zod.coerce.date().optional(),
  "retrievalDate": zod.coerce.date(),
  "exactClaim": zod.string(),
  "rawMetricValue": zod.number().optional(),
  "rawMetricUnit": zod.string().optional(),
  "sampleSize": zod.number().int().min(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin).optional(),
  "evidenceKind": zod.enum(['quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified']),
  "supportDirection": zod.enum(['supports', 'contradicts', 'context', 'neutral']),
  "confidence": zod.number().int().min(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin).max(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax),
  "normalizedScore": zod.number().int().min(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin).max(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax),
  "criterionWeight": zod.number().int().min(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin).max(externalCreateComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax),
  "weightedContribution": zod.number(),
  "normalizationMethod": zod.string()
})).optional()
})).optional(),
  "switchConditions": zod.array(zod.string()).optional().describe('Conditions under which this option should be preferred over the overall recommendation.'),
  "vrio": zod.object({
  "value": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "rarity": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "imitability": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "organization": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "implication": zod.string()
}).optional(),
  "marketPosition": zod.object({
  "marketShare": zod.string().describe('Latest credible market-share figure or an explicit unavailable statement.'),
  "marketSharePeriod": zod.string(),
  "market": zod.string(),
  "shareValue": zod.string().describe('Public parent-company share price/value when applicable, otherwise Not applicable.'),
  "shareValueAsOf": zod.string(),
  "applicability": zod.string(),
  "evidence": zod.string()
}).optional(),
  "marketHistory": zod.object({
  "lookbackYears": zod.literal(5),
  "trendSummary": zod.string(),
  "yearlyTrends": zod.array(zod.object({
  "year": zod.number().int(),
  "productPerformance": zod.string(),
  "marketPosition": zod.string(),
  "trendDirection": zod.enum(['improving', 'stable', 'declining', 'mixed', 'unavailable']),
  "notableEvent": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "ownership": zod.object({
  "status": zod.enum(['public', 'private', 'subsidiary', 'government', 'mutual', 'unknown']),
  "ultimateParent": zod.string(),
  "majorShareholders": zod.array(zod.string()),
  "asOf": zod.string(),
  "evidenceUrl": zod.string().url().optional()
}),
  "transactions": zod.array(zod.object({
  "date": zod.string(),
  "type": zod.enum(['merger', 'acquisition', 'divestiture', 'investment', 'restructure', 'none_found']),
  "counterparty": zod.string(),
  "summary": zod.string(),
  "impact": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "stock": zod.object({
  "applicability": zod.enum(['listed', 'listed_parent', 'private', 'not_applicable', 'unverified']),
  "ticker": zod.string(),
  "exchange": zod.string(),
  "currency": zod.string(),
  "latestPrice": zod.number().nullable(),
  "latestPriceAsOf": zod.string(),
  "fiveYearChangePercent": zod.number().nullable(),
  "yearlyCloses": zod.array(zod.object({
  "year": zod.number().int(),
  "price": zod.number().nullable()
})),
  "evidenceUrl": zod.string().url().optional()
})
}).optional().describe('Evidence-backed five-year performance, ownership, corporate-action, and listed-stock context for one compared option.')
})),
  "pricing": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "features": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "swot": zod.record(zod.string(), zod.array(zod.string())),
  "opportunities": zod.array(zod.string()),
  "insights": zod.array(zod.string()),
  "nextSteps": zod.array(zod.string()),
  "contextAssumptions": zod.array(zod.string()).describe('Explicit assumptions made where business, regulatory, security, commercial, operating, integration, data, or maturity context was missing.'),
  "productEquivalency": zod.array(zod.object({
  "capability": zod.string(),
  "currentArrangement": zod.string(),
  "targetArrangement": zod.string(),
  "equivalency": zod.string().describe('Full'),
  "gap": zod.string()
})).describe('Like-for-like mapping of current and target products or services, including partial equivalence and uncovered scope.'),
  "functionalGaps": zod.array(zod.object({
  "capability": zod.string(),
  "currentState": zod.string(),
  "targetState": zod.string(),
  "gap": zod.string(),
  "mitigation": zod.string(),
  "severity": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Required capabilities that are absent, partial, changed, or unverified in the target arrangement.'),
  "serviceProductMap": zod.array(zod.object({
  "businessService": zod.string(),
  "currentProduct": zod.string(),
  "targetProduct": zod.string(),
  "dependencies": zod.string(),
  "owner": zod.string()
})).describe('Mapping between business services and the products, dependencies, and owners that enable them.'),
  "migrationSequence": zod.array(zod.object({
  "phase": zod.string(),
  "objective": zod.string(),
  "dependencies": zod.string(),
  "exitCriteria": zod.string(),
  "risk": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Ordered migration phases with dependencies, exit criteria, and risk.'),
  "decisionGovernance": zod.array(zod.object({
  "decision": zod.string(),
  "owner": zod.string(),
  "approvers": zod.string(),
  "evidenceRequired": zod.string(),
  "decisionGate": zod.string()
})).describe('Decision rights, evidence requirements, approvers, and approval gates.')
}))


/**
 * Requires an API key with the comparisons:read scope.
 * @summary Get a tenant comparison
 */
export const ExternalGetComparisonParams = zod.object({
  "id": zod.coerce.number().int()
})

export const externalGetComparisonResponseOneComparisonIdentityEntitiesMin = 2;
export const externalGetComparisonResponseOneComparisonIdentityEntitiesMax = 5;

export const externalGetComparisonResponseOneComparisonIdentityEntityCountMin = 2;
export const externalGetComparisonResponseOneComparisonIdentityEntityCountMax = 5;

export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin = 0;
export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax = 100;

export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin = 0;

export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin = 0;
export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax = 100;

export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin = 0;
export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax = 100;

export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin = 0;
export const externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax = 100;



export const ExternalGetComparisonResponse = zod.object({
  "id": zod.number().int(),
  "prompt": zod.string(),
  "vendors": zod.array(zod.string()),
  "comparisonIdentity": zod.object({
  "originalQuery": zod.string(),
  "category": zod.string(),
  "entities": zod.array(zod.object({
  "id": zod.string(),
  "name": zod.string()
})).min(externalGetComparisonResponseOneComparisonIdentityEntitiesMin).max(externalGetComparisonResponseOneComparisonIdentityEntitiesMax),
  "entityCount": zod.number().int().min(externalGetComparisonResponseOneComparisonIdentityEntityCountMin).max(externalGetComparisonResponseOneComparisonIdentityEntityCountMax),
  "comparisonType": zod.enum(['pair', 'multi_entity']),
  "displayName": zod.string(),
  "headline": zod.string()
}).describe('Canonical comparison set used by every downstream label and recommendation.'),
  "category": zod.string(),
  "recommendation": zod.string(),
  "score": zod.number().int(),
  "createdAt": zod.coerce.date(),
  "status": zod.enum(['complete', 'processing', 'failed'])
}).and(zod.object({
  "urls": zod.array(zod.string()),
  "sourceAvailability": zod.array(zod.object({
  "url": zod.string().url(),
  "status": zod.enum(['reachable', 'restricted', 'timed_out', 'unavailable', 'superseded']),
  "reason": zod.string(),
  "replacementUrl": zod.string().url().optional()
})).describe('Availability information for every source checked while producing the report. Legacy reports may return reachable entries derived from urls.'),
  "criteria": zod.array(zod.string()),
  "executiveSummary": zod.string(),
  "recommendationReason": zod.string(),
  "vendorScores": zod.array(zod.object({
  "vendor": zod.string(),
  "score": zod.number().int(),
  "color": zod.string(),
  "verdict": zod.string(),
  "providerRole": zod.enum(['accelerator', 'leader', 'core_provider', 'expert']).optional().describe('Strategic market role of the product, service, or brand in this decision context.'),
  "providerRoleRationale": zod.string().optional().describe('Evidence-based explanation for the assigned strategic market role.'),
  "weightedScores": zod.array(zod.object({
  "criterion": zod.string(),
  "weight": zod.number().int(),
  "score": zod.number().int().min(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMin).max(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemScoreMax),
  "rationale": zod.string(),
  "evidence": zod.array(zod.object({
  "sourceUrl": zod.string().url().optional(),
  "sourceTitle": zod.string().optional(),
  "sourcePublisher": zod.string().optional(),
  "sourceDate": zod.coerce.date().optional(),
  "retrievalDate": zod.coerce.date(),
  "exactClaim": zod.string(),
  "rawMetricValue": zod.number().optional(),
  "rawMetricUnit": zod.string().optional(),
  "sampleSize": zod.number().int().min(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemSampleSizeMin).optional(),
  "evidenceKind": zod.enum(['quantitative', 'percentage', 'qualitative', 'analyst_judgment', 'unverified']),
  "supportDirection": zod.enum(['supports', 'contradicts', 'context', 'neutral']),
  "confidence": zod.number().int().min(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMin).max(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemConfidenceMax),
  "normalizedScore": zod.number().int().min(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMin).max(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemNormalizedScoreMax),
  "criterionWeight": zod.number().int().min(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMin).max(externalGetComparisonResponseTwoVendorScoresItemWeightedScoresItemEvidenceItemCriterionWeightMax),
  "weightedContribution": zod.number(),
  "normalizationMethod": zod.string()
})).optional()
})).optional(),
  "switchConditions": zod.array(zod.string()).optional().describe('Conditions under which this option should be preferred over the overall recommendation.'),
  "vrio": zod.object({
  "value": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "rarity": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "imitability": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "organization": zod.object({
  "status": zod.enum(['strong', 'partial', 'weak', 'not_applicable']),
  "rationale": zod.string()
}),
  "implication": zod.string()
}).optional(),
  "marketPosition": zod.object({
  "marketShare": zod.string().describe('Latest credible market-share figure or an explicit unavailable statement.'),
  "marketSharePeriod": zod.string(),
  "market": zod.string(),
  "shareValue": zod.string().describe('Public parent-company share price/value when applicable, otherwise Not applicable.'),
  "shareValueAsOf": zod.string(),
  "applicability": zod.string(),
  "evidence": zod.string()
}).optional(),
  "marketHistory": zod.object({
  "lookbackYears": zod.literal(5),
  "trendSummary": zod.string(),
  "yearlyTrends": zod.array(zod.object({
  "year": zod.number().int(),
  "productPerformance": zod.string(),
  "marketPosition": zod.string(),
  "trendDirection": zod.enum(['improving', 'stable', 'declining', 'mixed', 'unavailable']),
  "notableEvent": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "ownership": zod.object({
  "status": zod.enum(['public', 'private', 'subsidiary', 'government', 'mutual', 'unknown']),
  "ultimateParent": zod.string(),
  "majorShareholders": zod.array(zod.string()),
  "asOf": zod.string(),
  "evidenceUrl": zod.string().url().optional()
}),
  "transactions": zod.array(zod.object({
  "date": zod.string(),
  "type": zod.enum(['merger', 'acquisition', 'divestiture', 'investment', 'restructure', 'none_found']),
  "counterparty": zod.string(),
  "summary": zod.string(),
  "impact": zod.string(),
  "evidenceUrl": zod.string().url().optional()
})),
  "stock": zod.object({
  "applicability": zod.enum(['listed', 'listed_parent', 'private', 'not_applicable', 'unverified']),
  "ticker": zod.string(),
  "exchange": zod.string(),
  "currency": zod.string(),
  "latestPrice": zod.number().nullable(),
  "latestPriceAsOf": zod.string(),
  "fiveYearChangePercent": zod.number().nullable(),
  "yearlyCloses": zod.array(zod.object({
  "year": zod.number().int(),
  "price": zod.number().nullable()
})),
  "evidenceUrl": zod.string().url().optional()
})
}).optional().describe('Evidence-backed five-year performance, ownership, corporate-action, and listed-stock context for one compared option.')
})),
  "pricing": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "features": zod.array(zod.object({
  "dimension": zod.string(),
  "values": zod.record(zod.string(), zod.string()),
  "winner": zod.string()
})),
  "swot": zod.record(zod.string(), zod.array(zod.string())),
  "opportunities": zod.array(zod.string()),
  "insights": zod.array(zod.string()),
  "nextSteps": zod.array(zod.string()),
  "contextAssumptions": zod.array(zod.string()).describe('Explicit assumptions made where business, regulatory, security, commercial, operating, integration, data, or maturity context was missing.'),
  "productEquivalency": zod.array(zod.object({
  "capability": zod.string(),
  "currentArrangement": zod.string(),
  "targetArrangement": zod.string(),
  "equivalency": zod.string().describe('Full'),
  "gap": zod.string()
})).describe('Like-for-like mapping of current and target products or services, including partial equivalence and uncovered scope.'),
  "functionalGaps": zod.array(zod.object({
  "capability": zod.string(),
  "currentState": zod.string(),
  "targetState": zod.string(),
  "gap": zod.string(),
  "mitigation": zod.string(),
  "severity": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Required capabilities that are absent, partial, changed, or unverified in the target arrangement.'),
  "serviceProductMap": zod.array(zod.object({
  "businessService": zod.string(),
  "currentProduct": zod.string(),
  "targetProduct": zod.string(),
  "dependencies": zod.string(),
  "owner": zod.string()
})).describe('Mapping between business services and the products, dependencies, and owners that enable them.'),
  "migrationSequence": zod.array(zod.object({
  "phase": zod.string(),
  "objective": zod.string(),
  "dependencies": zod.string(),
  "exitCriteria": zod.string(),
  "risk": zod.enum(['low', 'medium', 'high', 'critical'])
})).describe('Ordered migration phases with dependencies, exit criteria, and risk.'),
  "decisionGovernance": zod.array(zod.object({
  "decision": zod.string(),
  "owner": zod.string(),
  "approvers": zod.string(),
  "evidenceRequired": zod.string(),
  "decisionGate": zod.string()
})).describe('Decision rights, evidence requirements, approvers, and approval gates.')
}))


/**
 * Requires an API key with the usage:read scope.
 * @summary Get monthly usage and quota
 */
export const GetExternalUsageResponse = zod.object({
  "month": zod.string().describe('Provider period label; inactive/bootstrap tenants use YYYY-MM.'),
  "periodStart": zod.coerce.date(),
  "periodEnd": zod.coerce.date(),
  "included": zod.number().int(),
  "used": zod.number().int(),
  "remaining": zod.number().int().describe('Comparisons remaining before the prepaid hard cap is reached.'),
  "exhausted": zod.boolean()
})


/**
 * @summary Ensure a personal tenant for the signed-in Clerk user
 */
export const BootstrapTenantResponse = zod.object({
  "id": zod.string(),
  "name": zod.string(),
  "plan": zod.string(),
  "billingStatus": zod.enum(['inactive', 'active', 'past_due']),
  "includedComparisons": zod.number().int(),
  "requestsPerMinute": zod.number().int()
})


/**
 * @summary View tenant usage
 */
export const getTenantUsageHeaderXTenantIdMax = 200;



export const GetTenantUsageHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(getTenantUsageHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const GetTenantUsageResponse = zod.object({
  "month": zod.string().describe('Provider period label; inactive/bootstrap tenants use YYYY-MM.'),
  "periodStart": zod.coerce.date(),
  "periodEnd": zod.coerce.date(),
  "included": zod.number().int(),
  "used": zod.number().int(),
  "remaining": zod.number().int().describe('Comparisons remaining before the prepaid hard cap is reached.'),
  "exhausted": zod.boolean()
})


/**
 * @summary List tenant audit events
 */
export const listTenantAuditQueryLimitDefault = 50;
export const listTenantAuditQueryLimitMax = 100;



export const ListTenantAuditQueryParams = zod.object({
  "limit": zod.coerce.number().int().min(1).max(listTenantAuditQueryLimitMax).default(listTenantAuditQueryLimitDefault)
})

export const listTenantAuditHeaderXTenantIdMax = 200;



export const ListTenantAuditHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(listTenantAuditHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const ListTenantAuditResponseItem = zod.object({
  "id": zod.number().int(),
  "actorId": zod.string(),
  "action": zod.string(),
  "metadata": zod.record(zod.string(), zod.unknown()),
  "createdAt": zod.coerce.date()
})
export const ListTenantAuditResponse = zod.array(ListTenantAuditResponseItem)


/**
 * @summary List API key metadata
 */
export const listTenantApiKeysHeaderXTenantIdMax = 200;



export const ListTenantApiKeysHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(listTenantApiKeysHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const ListTenantApiKeysResponseItem = zod.object({
  "id": zod.number().int(),
  "name": zod.string(),
  "prefix": zod.string(),
  "scopes": zod.array(zod.string()),
  "expiresAt": zod.coerce.date().nullish(),
  "revokedAt": zod.coerce.date().nullish(),
  "lastUsedAt": zod.coerce.date().nullish(),
  "createdAt": zod.coerce.date()
})
export const ListTenantApiKeysResponse = zod.array(ListTenantApiKeysResponseItem)


/**
 * @summary Create an API key (plaintext is returned once)
 */
export const createTenantApiKeyHeaderXTenantIdMax = 200;



export const CreateTenantApiKeyHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(createTenantApiKeyHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const createTenantApiKeyBodyNameMax = 100;



export const CreateTenantApiKeyBody = zod.object({
  "name": zod.string().min(1).max(createTenantApiKeyBodyNameMax),
  "scopes": zod.array(zod.enum(['comparisons:read', 'comparisons:write', 'usage:read'])).optional(),
  "expiresAt": zod.coerce.date().optional()
})

export const CreateTenantApiKeyResponse = zod.object({
  "id": zod.number().int(),
  "name": zod.string(),
  "prefix": zod.string(),
  "scopes": zod.array(zod.string()),
  "expiresAt": zod.coerce.date().nullish(),
  "revokedAt": zod.coerce.date().nullish(),
  "lastUsedAt": zod.coerce.date().nullish(),
  "createdAt": zod.coerce.date()
}).and(zod.object({
  "key": zod.string().describe('Plaintext key; returned only once.')
}))


/**
 * @summary Revoke an API key and issue a replacement
 */
export const RotateTenantApiKeyParams = zod.object({
  "id": zod.coerce.number().int()
})

export const rotateTenantApiKeyHeaderXTenantIdMax = 200;



export const RotateTenantApiKeyHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(rotateTenantApiKeyHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const RotateTenantApiKeyResponse = zod.object({
  "id": zod.number().int(),
  "name": zod.string(),
  "prefix": zod.string(),
  "scopes": zod.array(zod.string()),
  "expiresAt": zod.coerce.date().nullish(),
  "revokedAt": zod.coerce.date().nullish(),
  "lastUsedAt": zod.coerce.date().nullish(),
  "createdAt": zod.coerce.date()
}).and(zod.object({
  "key": zod.string().describe('Plaintext key; returned only once.')
}))


/**
 * @summary Revoke an API key
 */
export const RevokeTenantApiKeyParams = zod.object({
  "id": zod.coerce.number().int()
})

export const revokeTenantApiKeyHeaderXTenantIdMax = 200;



export const RevokeTenantApiKeyHeader = zod.object({
  "X-Tenant-Id": zod.string().min(1).max(revokeTenantApiKeyHeaderXTenantIdMax).describe('Exact tenant being managed; the Clerk user must be an owner or admin member.')
})

export const RevokeTenantApiKeyResponse = zod.void()


