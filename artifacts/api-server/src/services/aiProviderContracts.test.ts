import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDER_CONTRACTS,
  aiProviderContractUrls,
  checkAiProviderEvidenceContracts,
} from "./aiProviderContracts";
import type { RetrievedEvidenceDocument } from "../lib/security";

function document(index: number, text: string): RetrievedEvidenceDocument {
  const contract = AI_PROVIDER_CONTRACTS[index]!;
  return {
    url: contract.url,
    finalUrl: contract.url,
    contentType: "text/html",
    text,
    sha256: String(index + 1).repeat(64),
    retrievedAt: "2026-09-23T00:00:00.000Z",
    truncated: false,
    retrievalMethod: "direct_http",
    parserVersion: "security-html-v1",
  };
}

test("checks representative provider pages through production fallback URLs", () => {
  assert.deepEqual(aiProviderContractUrls(), AI_PROVIDER_CONTRACTS.map((contract) => contract.url));
});

test("reports provenance-valid OpenAI and Anthropic provider contracts", async () => {
  const documents = [
    document(
      0,
      "GPT-5.6 Luna\nGPT-5.6 Luna is designed for cost-sensitive workloads and corresponds to the nano tier in earlier GPT-5 families.\n1,050,000 context window\nPricing\nText tokens\nPer 1M tokens\nInput\n$0.20\nCached input\n$0.02\nOutput\n$1.20\nBelow is a list of all available snapshots and aliases for GPT-5.6 Luna.",
    ),
    document(
      1,
      "Claude Sonnet 5 This model\nInput $2 / MTok Output $10 / MTok\nContext window 1M tokens\nModel IDs\nclaude-sonnet-5",
    ),
  ];
  const results = await checkAiProviderEvidenceContracts({
    retrieve: async () => documents.map((value) => ({ url: value.url, document: value })),
  });
  assert.deepEqual(results.map((result) => result.status), ["pass", "pass"]);
  assert.ok(results.every((result) => result.missingEvidence.length === 0));
});

test("identifies provider drift and keeps unavailable pages evidence-free", async () => {
  const results = await checkAiProviderEvidenceContracts({
    retrieve: async () => [
      {
        url: AI_PROVIDER_CONTRACTS[0]!.url,
        document: document(0, "GPT-5.6 Luna\nThe provider changed this page layout."),
      },
      {
        url: AI_PROVIDER_CONTRACTS[1]!.url,
        reason: "robots_disallowed",
      },
    ],
  });
  assert.equal(results[0]?.status, "contract_mismatch");
  assert.match(results[0]?.detail ?? "", /^OpenAI documentation contract changed/);
  assert.deepEqual(results[0]?.missingEvidence, [
    "model_availability",
    "input_token_price",
    "output_token_price",
    "context_window_tokens",
  ]);
  assert.equal(results[1]?.status, "retrieval_unavailable");
  assert.match(results[1]?.detail ?? "", /^Anthropic governed retrieval was unavailable \(robots_disallowed\); no evidence was admitted\.$/);
});