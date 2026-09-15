# Vendor Compare

Vendor Compare helps teams turn open-ended buying questions into structured, evidence-aware vendor decisions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/vendor-compare/src/App.tsx` — public landing page, Clerk auth routes, signed-in workspace, analysis detail, and history UI.
- `artifacts/vendor-compare/src/index.css` — product theme and shared visual utilities.
- `lib/api-spec/openapi.yaml` — source of truth for comparison and dashboard API contracts.
- `artifacts/api-server/src/routes/comparisons/` — authenticated comparison endpoints.
- `artifacts/api-server/src/lib/analysis.ts` — prompt parsing and AI-backed/fallback analysis generation.
- `lib/db/src/schema/comparisons.ts` — persisted, user-scoped comparison history.

## Architecture decisions

- Clerk owns sign-up, sign-in, password reset, Google SSO, password policy, email verification, and bot protection; the app does not implement local credential storage.
- Guest comparisons use separate public, rate-limited endpoints and are returned without a database ID; only signed-in comparisons enter the user's 30-day history.
- Browser API requests use Clerk session cookies; protected server routes derive the user ID from Clerk and scope every comparison query to that identity.
- Comparison creation stores structured analysis JSON in PostgreSQL so the result and the 30-day history remain available after reloads.
- User-entered comparison text is validated server-side against XML-like markup, SQL-shaped input, and prompt-injection phrases before parsing or sending to the model.
- Comparison prompts must contain actual vendor names plus one recognizable product/service segment and target industry before analysis runs.
- Analysis performs live web research for current product, pricing, warranty, maintenance, and local-market information; user-supplied URLs are optional source hints.
- The primary comparison journey is one NLP-first form: prompt required, source URLs optional. New results include an eight-criterion weighted scorecard and comparison charts.
- Result pages can download a self-contained PDF report. Research may also surface credible alternatives outside the named shortlist, with rationale and explicit trade-offs.
- NLP shortlists support wording such as “across,” “among,” and “against.” While research runs, the form shows a spinner, process explanation, keep-page-open guidance, and “While you wait” notes.
- Results include an interactive recommendation-vs-shortlist selector, switch conditions, SWOT, VRIO, PESTLE, SOAR, and sourced market-share/share-value context. Public API documentation is available at `/api-docs`.
- Authenticated API requests obtain a current Clerk bearer token and refresh cached workspace data when an inactive tab becomes visible or reconnects.
- AI analysis uses the configured OpenAI key when available and a deterministic, safe fallback when the model is unavailable.

## Product

Vendor Compare has a public landing page, branded Clerk sign-up/sign-in, a free-text comparison intake flow, URL validation, vendor/criteria review, structured pricing and feature comparisons, SWOT analysis, opportunities, insights, next steps, and a rolling 30-day history.

## User preferences

No project-specific preferences recorded yet.

## Gotchas

- The app must run through its managed workflows so `PORT` and `BASE_PATH` are present; direct Vite builds from a shell need those environment values.
- After changing `lib/api-spec/openapi.yaml`, regenerate the client and Zod schemas before changing route consumers.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
