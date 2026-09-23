import {
  addVerifiedAiModelEvidence,
  officialAiModelSourcesFor,
} from "../lib/analysis";
import {
  retrieveEvidenceDocuments,
  type EvidenceDocumentResult,
} from "../lib/security";
import { publisherPermissionRegistry } from "./publisherPermissionRegistry";

export type AiProviderContractStatus = "pass" | "retrieval_unavailable" | "contract_mismatch";

export type AiProviderContractResult = {
  provider: "OpenAI" | "Anthropic";
  model: string;
  url: string;
  status: AiProviderContractStatus;
  missingEvidence: string[];
  detail: string;
};

type AiProviderContract = {
  provider: AiProviderContractResult["provider"];
  model: string;
  url: string;
};

export const AI_PROVIDER_CONTRACTS: AiProviderContract[] = [
  {
    provider: "OpenAI",
    model: "GPT 5.6 Luna",
    url: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
  },
  {
    provider: "Anthropic",
    model: "Claude Sonnet 5",
    url: "https://platform.claude.com/docs/en/models/sonnet-5/overview",
  },
];

const REQUIRED_METRICS = [
  "model_availability",
  "input_token_price",
  "output_token_price",
  "context_window_tokens",
] as const;

export async function checkAiProviderEvidenceContracts(options: {
  retrieve?: (urls: string[]) => Promise<EvidenceDocumentResult[]>;
} = {}): Promise<AiProviderContractResult[]> {
  const retrieve = options.retrieve ?? ((urls: string[]) => retrieveEvidenceDocuments(urls, {
    permissionRegistry: publisherPermissionRegistry,
    concurrency: 2,
    cacheMs: 0,
  }));
  const urls = AI_PROVIDER_CONTRACTS.map((contract) => contract.url);
  const retrieved = await retrieve(urls);

  return AI_PROVIDER_CONTRACTS.map((contract, index) => {
    const result = retrieved[index];
    if (!result?.document) {
      const reason = result?.reason ?? "no_result";
      return {
        ...contract,
        status: "retrieval_unavailable",
        missingEvidence: [...REQUIRED_METRICS],
        detail: `${contract.provider} governed retrieval was unavailable (${reason}); no evidence was admitted.`,
      };
    }

    const parsed: Record<string, unknown> = {
      vendorScores: [{ vendor: contract.model, weightedScores: [] }],
    };
    addVerifiedAiModelEvidence(parsed, [result.document]);
    const vendorScores = parsed.vendorScores as Array<Record<string, unknown>>;
    const weightedScores = vendorScores[0]?.weightedScores as Array<Record<string, unknown>> | undefined;
    const evidence = (weightedScores ?? []).flatMap((criterion) => (
      Array.isArray(criterion.evidence) ? criterion.evidence as Array<Record<string, unknown>> : []
    ));
    const validMetricKeys = new Set(evidence.filter((entry) => (
      entry.documentSha256 === result.document?.sha256
      && entry.sourceUrl === result.document?.finalUrl
      && Number.isInteger(entry.sourceTextStart)
      && Number.isInteger(entry.sourceTextEnd)
      && Number(entry.sourceTextEnd) > Number(entry.sourceTextStart)
      && Number(entry.sourceTextEnd) <= result.document!.text.length
    )).map((entry) => String(entry.metricKey)));
    const missingEvidence = REQUIRED_METRICS.filter((metric) => !validMetricKeys.has(metric));

    return {
      ...contract,
      status: missingEvidence.length ? "contract_mismatch" : "pass",
      missingEvidence,
      detail: missingEvidence.length
        ? `${contract.provider} documentation contract changed or no longer exposes provenance-valid ${missingEvidence.join(", ")} evidence.`
        : `${contract.provider} documentation produced provenance-valid availability, pricing, and context evidence.`,
    };
  });
}

export function aiProviderContractUrls(): string[] {
  return AI_PROVIDER_CONTRACTS.flatMap((contract) => (
    officialAiModelSourcesFor([contract.model]).filter((url) => url === contract.url)
  ));
}