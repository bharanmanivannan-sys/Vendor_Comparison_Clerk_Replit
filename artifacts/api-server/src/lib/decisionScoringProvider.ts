/** Direct Google AI Studio generateContent fallback (not a proxy). */
export const GEMINI_SCORING_MODEL = "gemini-2.5-flash-lite";
export const OPENAI_SCORING_MODEL = () => process.env.DECISION_MODEL || "gpt-4.1-mini";
/** Available via Groq's authenticated models endpoint; JSON-object chat completions. */
export const GROQ_SCORING_MODEL = () => process.env.GROQ_SCORING_MODEL || "openai/gpt-oss-20b";
const CREDIT_COOLDOWN_MS = 15 * 60_000;
const MIN_FALLBACK_WINDOW_MS = 5_000;
const GROQ_RESERVED_WINDOW_MS = 2_500;
const exhaustedUntil = new Map<string, number>();

export type ScoringProvider = "openai" | "gemini" | "groq";
export type ScoringResult<T> = { output: T; provider: ScoringProvider; model: string };

export function eligibleScoringFallback(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, name, code } = error as { status?: unknown; name?: unknown; code?: unknown };
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600)
    || (typeof name === "string" && ["APIConnectionError", "APIConnectionTimeoutError", "TimeoutError"].includes(name))
    || (typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code));
}

/** Keep the same total stage deadline across all providers. No fallback on caller cancellation. */
export async function scoreWithGeminiFallback<T>(
  primary: (signal: AbortSignal, timeoutMs: number) => Promise<unknown>,
  validate: (value: unknown) => T | null,
  system: string,
  user: string,
  options: {
    signal?: AbortSignal;
    deadlineAt: number;
    primaryBudgetMs: number;
    apiKey?: string;
    fetcher?: typeof fetch;
    model?: string;
    groqApiKey?: string;
    groqFetcher?: typeof fetch;
    groqModel?: string;
  },
): Promise<ScoringResult<T>> {
  const remaining = () => Math.max(0, options.deadlineAt - Date.now());
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const assertActive = () => {
    if (options.signal?.aborted) throw new Error("MODEL_SCORING_CANCELLED");
    if (!remaining()) throw new Error("MODEL_SCORING_DEADLINE_EXCEEDED");
  };
  const groqKey = options.groqApiKey ?? process.env.GROQ_API_KEY;
  const groqConfigured = !!groqKey?.trim();
  try {
    assertActive();
    const primaryModel = OPENAI_SCORING_MODEL();
    if ((exhaustedUntil.get(primaryModel) ?? 0) <= Date.now()) {
      // Do not let a slow primary consume the backup's entire stage window,
      // even when a caller's primary implementation ignores its timeout.
      const budget = Math.min(options.primaryBudgetMs,
        options.apiKey || groqConfigured
          ? Math.max(0, remaining() - Math.min(MIN_FALLBACK_WINDOW_MS, Math.floor(remaining() / 2)))
          : remaining());
      if (budget > 0) {
        const primaryController = new AbortController();
        const abortPrimary = () => primaryController.abort();
        controller.signal.addEventListener("abort", abortPrimary, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let rejectAbort: ((error: Error) => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const onPrimaryAbort = () => rejectAbort?.(new Error("MODEL_SCORING_CANCELLED"));
        controller.signal.addEventListener("abort", onPrimaryAbort, { once: true });
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              primaryController.abort();
              reject(Object.assign(new Error("Primary scoring timed out"), { name: "TimeoutError" }));
            }, budget);
          });
          const raw = await Promise.race([primary(primaryController.signal, budget), timeout, cancelled]);
          assertActive();
          const valid = validate(raw);
          if (valid !== null) return { output: valid, provider: "openai", model: primaryModel };
        } catch (error) {
          assertActive();
          if (!eligibleScoringFallback(error)) throw error;
          const failure = error as { status?: unknown; code?: unknown };
          if (failure.status === 429 && failure.code === "credit_balance_exhausted") {
            exhaustedUntil.set(primaryModel, Date.now() + CREDIT_COOLDOWN_MS);
            console.info("decision_mode_primary_scoring_cooldown", { model: primaryModel, reason: "credits_exhausted", durationMs: CREDIT_COOLDOWN_MS });
          }
        } finally {
          if (timer) clearTimeout(timer);
          controller.signal.removeEventListener("abort", abortPrimary);
          controller.signal.removeEventListener("abort", onPrimaryAbort);
        }
      }
    } else {
      console.info("decision_mode_primary_scoring_skipped", { model: primaryModel, reason: "credits_exhausted_cooldown" });
    }
    let geminiFailure: Error = new Error("MODEL_SCORING_GEMINI_NOT_CONFIGURED");
    if (options.apiKey) {
      assertActive();
      const model = options.model ?? GEMINI_SCORING_MODEL;
      const geminiController = new AbortController();
      const abortGemini = () => geminiController.abort();
      controller.signal.addEventListener("abort", abortGemini, { once: true });
      let timedOut = false;
      const geminiBudget = groqConfigured
        ? Math.max(0, remaining() - Math.min(GROQ_RESERVED_WINDOW_MS, Math.floor(remaining() / 2)))
        : remaining();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let rejectAbort: ((error: Error) => void) | undefined;
      const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const onGeminiAbort = () => rejectAbort?.(new Error("MODEL_SCORING_GEMINI_UNAVAILABLE"));
      geminiController.signal.addEventListener("abort", onGeminiAbort, { once: true });
      timeout = setTimeout(() => { timedOut = true; geminiController.abort(); }, geminiBudget);
      try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await Promise.race([(options.fetcher ?? fetch)(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey },
              body: JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: "user", parts: [{ text: user }] }],
                generationConfig: {
                  responseMimeType: "application/json", maxOutputTokens: 1800,
                  ...(model === "gemini-2.5-flash-lite" ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
                },
              }),
               signal: geminiController.signal,
            },
          ), abortPromise]);
          if (!response.ok) throw new Error(`MODEL_SCORING_GEMINI_HTTP_${response.status}`);
          if (options.signal?.aborted) throw new Error("MODEL_SCORING_CANCELLED");
          if (timedOut) throw new Error("MODEL_SCORING_GEMINI_TIMEOUT");
          assertActive();
          const body = await Promise.race([response.json(), abortPromise]) as {
            promptFeedback?: { blockReason?: string };
            candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
          };
          assertActive();
          const candidate = body.candidates?.[0];
          if (body.promptFeedback?.blockReason || candidate?.finishReason !== "STOP") {
            throw new Error("MODEL_SCORING_GEMINI_BLOCKED_OR_INCOMPLETE");
          }
          const text = candidate.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw new Error("MODEL_SCORING_GEMINI_INVALID_RESPONSE"); }
          const valid = validate(parsed);
          if (valid === null) throw new Error("MODEL_SCORING_GEMINI_INVALID_RESPONSE");
          return { output: valid, provider: "gemini", model };
        } catch (error) {
          // A valid HTTP response can still omit an exact option/lens. Retry
          // once only while enough of this same stage deadline remains.
          if (attempt === 0 && error instanceof Error
            && error.message === "MODEL_SCORING_GEMINI_INVALID_RESPONSE"
            && (!groqConfigured || remaining() - GROQ_RESERVED_WINDOW_MS >= MIN_FALLBACK_WINDOW_MS)
            && !options.signal?.aborted) {
            console.info("decision_mode_gemini_scoring_retry", { reason: "invalid_response" });
            continue;
          }
          throw error;
        }
      }
      throw new Error("MODEL_SCORING_GEMINI_INVALID_RESPONSE");
      } catch (error) {
        if (options.signal?.aborted) throw new Error("MODEL_SCORING_CANCELLED");
        geminiFailure = timedOut ? new Error("MODEL_SCORING_GEMINI_TIMEOUT")
          : error instanceof Error && error.message.startsWith("MODEL_SCORING_GEMINI_") ? error
          : new Error("MODEL_SCORING_GEMINI_UNAVAILABLE");
      } finally {
        if (timeout) clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abortGemini);
        geminiController.signal.removeEventListener("abort", onGeminiAbort);
      }
    }
    if (!groqConfigured) throw geminiFailure;
    assertActive();
    const model = options.groqModel ?? GROQ_SCORING_MODEL();
    const groqController = new AbortController();
    const abortGroq = () => groqController.abort();
    controller.signal.addEventListener("abort", abortGroq, { once: true });
    let timedOut = false;
    let rejectAbort: ((error: Error) => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onGroqAbort = () => rejectAbort?.(new Error("MODEL_SCORING_GROQ_UNAVAILABLE"));
    groqController.signal.addEventListener("abort", onGroqAbort, { once: true });
    const timeout = setTimeout(() => { timedOut = true; groqController.abort(); }, remaining());
    try {
      const response = await Promise.race([(options.groqFetcher ?? options.fetcher ?? fetch)(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
          body: JSON.stringify({
            model, response_format: { type: "json_object" }, max_tokens: 1800,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: groqController.signal,
        },
      ), abortPromise]);
      if (!response.ok) throw new Error(`MODEL_SCORING_GROQ_HTTP_${response.status}`);
      if (options.signal?.aborted) throw new Error("MODEL_SCORING_CANCELLED");
      if (timedOut) throw new Error("MODEL_SCORING_GROQ_TIMEOUT");
      assertActive();
      const body = await Promise.race([response.json(), abortPromise]) as {
        choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
      };
      assertActive();
      const choice = body.choices?.[0];
      if (choice?.finish_reason !== "stop" || !choice.message?.content)
        throw new Error("MODEL_SCORING_GROQ_BLOCKED_OR_INCOMPLETE");
      let parsed: unknown;
      try { parsed = JSON.parse(choice.message.content); }
      catch { throw new Error("MODEL_SCORING_GROQ_INVALID_RESPONSE"); }
      const valid = validate(parsed);
      if (valid === null) throw new Error("MODEL_SCORING_GROQ_INVALID_RESPONSE");
      return { output: valid, provider: "groq", model };
    } catch (error) {
      if (options.signal?.aborted) throw new Error("MODEL_SCORING_CANCELLED");
      if (timedOut) throw new Error("MODEL_SCORING_GROQ_TIMEOUT");
      // Never log or forward response bodies, request headers, or raw transport exceptions.
      if (error instanceof Error && error.message.startsWith("MODEL_SCORING_GROQ_")) throw error;
      if (error instanceof Error && error.message === "MODEL_SCORING_DEADLINE_EXCEEDED") throw error;
      throw new Error("MODEL_SCORING_GROQ_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", abortGroq);
      groqController.signal.removeEventListener("abort", onGroqAbort);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}