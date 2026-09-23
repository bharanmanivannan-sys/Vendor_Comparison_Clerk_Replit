import {
  aiProviderContractUrls,
  checkAiProviderEvidenceContracts,
} from "./services/aiProviderContracts";

async function main(): Promise<void> {
  const expectedUrls = new Set(aiProviderContractUrls());
  if (expectedUrls.size !== 2) {
    console.error("AI provider contract URLs no longer match the production fallback source list.");
    process.exitCode = 1;
    return;
  }
  const results = await checkAiProviderEvidenceContracts();
  for (const result of results) {
    console.log(JSON.stringify(result));
  }
  if (results.some((result) => result.status !== "pass")) process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});