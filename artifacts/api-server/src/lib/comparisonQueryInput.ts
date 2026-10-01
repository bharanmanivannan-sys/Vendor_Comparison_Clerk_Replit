/**
 * Comparison requests are data, not commands. Validate their shape and size,
 * rather than rejecting words that happen to resemble SQL, HTML or prompts.
 */
export function normalizeComparisonQuery(value: unknown, maxLength = 4_000): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  return normalized.length >= 8 && normalized.length <= maxLength ? normalized : null;
}