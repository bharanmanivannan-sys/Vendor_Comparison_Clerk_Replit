import { createHash } from "node:crypto";
import {
  checkEvidenceUrls,
  normalizeRetrievedText,
  type EvidenceDocumentResult,
  type EvidenceUrlResult,
  type PublisherPermissionRegistry,
  type RetrievedEvidenceDocument,
} from "../lib/security";

const ZYTE_EXTRACT_URL = "https://api.zyte.com/v1/extract";
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BROWSER_HTML_BYTES = 512 * 1024;
const SCRAPY_RETRIEVAL_METHOD = "scrapy_zyte_browser_html" as const;
const SCRAPY_PARSER_VERSION = "scrapy-ai-browser-html-v1";

type ScrapyEnvironment = NodeJS.ProcessEnv;

export type ScrapyAiAcquisitionOptions = {
  timeoutMs?: number;
  concurrency?: number;
  permissionRegistry?: PublisherPermissionRegistry;
  preflight?: typeof checkEvidenceUrls;
  fetchImpl?: typeof fetch;
  env?: ScrapyEnvironment;
};

function configuredApiKey(env: ScrapyEnvironment): string | undefined {
  const key = env.ZYTE_API_KEY?.trim();
  return key || undefined;
}

export function isScrapyAiAcquisitionConfigured(env: ScrapyEnvironment = process.env): boolean {
  return env.SCRAPY_AI_ENABLED === "true" && Boolean(configuredApiKey(env));
}

function failureReason(status: number): EvidenceUrlResult["reason"] {
  if (status === 401 || status === 403 || status === 429) return "access_restricted";
  if (status >= 500) return "unreachable";
  return "unreachable";
}

function permitsRenderedEvidence(result: EvidenceUrlResult): boolean {
  const decision = result.registryDecision;
  return Boolean(
    result.available
    && decision
    && ["ALLOWED", "LICENSED", "CUSTOMER_SUPPLIED"].includes(decision.accessStatus)
    && decision.accessMethod === "public_web"
    && decision.robotsResult === "allowed"
    && decision.allowedUses.includes("automated_retrieval")
    && decision.allowedUses.includes("comparison_evidence"),
  );
}

async function extractRenderedHtml(
  url: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ document?: RetrievedEvidenceDocument; reason?: EvidenceDocumentResult["reason"] }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ZYTE_EXTRACT_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "content-type": "application/json",
        "user-agent": "DecisionIntelResearchBot/1.0 (+https://vendor-comparison-workspace.replit.app)",
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
      }),
      signal: controller.signal,
    });
    if (!response.ok) return { reason: failureReason(response.status) };

    const payload = await response.json() as {
      browserHtml?: unknown;
      url?: unknown;
    };
    if (typeof payload.browserHtml !== "string") return { reason: "empty_document" };
    const renderedHtml = payload.browserHtml.slice(0, MAX_BROWSER_HTML_BYTES);
    const text = normalizeRetrievedText(renderedHtml, "text/html");
    if (!text) return { reason: "empty_document" };
    const finalUrl = typeof payload.url === "string" && /^https?:\/\//i.test(payload.url)
      ? payload.url
      : url;
    const document: RetrievedEvidenceDocument = {
      url,
      finalUrl,
      contentType: "text/html",
      text,
      sha256: createHash("sha256").update(text).digest("hex"),
      retrievedAt: new Date().toISOString(),
      truncated: renderedHtml.length < String(payload.browserHtml).length,
      retrievalMethod: SCRAPY_RETRIEVAL_METHOD,
      parserVersion: SCRAPY_PARSER_VERSION,
    };
    return { document };
  } catch (error) {
    return {
      reason: error instanceof Error && /abort|timeout/i.test(error.message)
        ? "timeout"
        : "unreachable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Optional browser-rendered acquisition for pages that are permitted but do
 * not expose useful content to a normal HTTP client. The preflight is
 * deliberately performed through the existing permission and robots boundary;
 * this adapter is never a bypass for a blocked source.
 */
export async function retrieveEvidenceDocumentsWithScrapyAi(
  urls: string[],
  options: ScrapyAiAcquisitionOptions = {},
): Promise<EvidenceDocumentResult[]> {
  const env = options.env ?? process.env;
  const apiKey = configuredApiKey(env);
  if (env.SCRAPY_AI_ENABLED !== "true" || !apiKey) {
    return urls.map((url) => ({ url, reason: "access_restricted" as const }));
  }

  const preflight = options.preflight ?? checkEvidenceUrls;
  const permissionRegistry = options.permissionRegistry;
  const preflightResults = await preflight(urls, { permissionRegistry });
  const results = new Array<EvidenceDocumentResult>(urls.length);
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 4));
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const preflightResult = preflightResults[index]!;
      if (!permitsRenderedEvidence(preflightResult)) {
        results[index] = {
          url: urls[index]!,
          reason: preflightResult.reason ?? "access_restricted",
        };
        continue;
      }
      const extracted = await extractRenderedHtml(
        urls[index]!,
        apiKey,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        options.fetchImpl ?? fetch,
      );
      if (extracted.document) {
        await permissionRegistry?.record(urls[index]!, {
          url: urls[index]!,
          available: true,
          finalUrl: extracted.document.finalUrl,
        }, new Date(extracted.document.retrievedAt));
      } else {
        await permissionRegistry?.record(urls[index]!, {
          url: urls[index]!,
          available: false,
          reason: extracted.reason === "access_restricted" ? "access_restricted" : extracted.reason === "timeout" ? "timeout" : "unreachable",
        }, new Date());
      }
      results[index] = {
        url: urls[index]!,
        document: extracted.document,
        reason: extracted.reason,
      };
    }
  }));
  return results;
}