const promptInjectionPattern =
  /(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|system|developer)|(?:system|developer)\s*(?:message|prompt)|jailbreak|do\s+anything\s+now/i;
const sqlPattern =
  /\b(?:select|insert|update|delete|drop|alter|truncate|union)\b[\s\S]{0,80}\b(?:from|into|table|where|values|set)\b/i;
const xmlPattern = /<\s*\/?\s*[a-z][^>]*>/i;

export function isSafeUserInput(value: string): boolean {
  return !promptInjectionPattern.test(value) && !sqlPattern.test(value) && !xmlPattern.test(value);
}

export function validateHttpUrls(urls: string[]): boolean {
  return urls.every((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  });
}