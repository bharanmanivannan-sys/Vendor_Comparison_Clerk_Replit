# Vendor Compare

Vendor Compare is an evidence-backed product comparison application. Users describe a decision in plain language, optionally provide source URLs, and receive researched product scoring, trade-offs, and a recommendation.

The repository also includes a free-beta, tenant-scoped API with usage controls.

## Features

- Natural-language product and vendor comparison
- Hybrid input parsing: model-assisted intent extraction plus deterministic entity-boundary validation
- Brand-level product discovery, including recommendations across product catalogs
- Portfolio-first model selection with comparability and evidence-readiness guardrails
- Current web research with cited sources
- Weighted scoring, pricing, features, SWOT, PESTLE, SOAR, and VRIO analysis
- Guest comparison flow
- Clerk authentication for saved workspaces
- Comparison history and dashboard
- Tenant-scoped beta API keys
- Idempotent API requests, rate limits, and monthly usage quotas

## Repository structure

```text
artifacts/
  vendor-compare/   React and Vite web application
  api-server/       Express API server
  mockup-sandbox/   Component and design preview
lib/
  api-client-react/ Generated React Query API client
  api-zod/          Generated request and response schemas
  db/               Drizzle ORM schema and PostgreSQL client
lib/api-spec/       API specifications
```

## Technology

- React 19 and Vite
- TypeScript
- Express
- PostgreSQL and Drizzle ORM
- TanStack Query
- Clerk authentication
- OpenAI product research
- pnpm workspaces

## Requirements

- Node.js 20 or newer
- pnpm
- PostgreSQL
- A Replit project with the required integrations and configuration

## Configuration

The application expects these server-side values:

| Name | Type | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Secret/runtime value | PostgreSQL connection |
| `OPENAI_API_KEY` | Secret | Product research |
| `CLERK_PUBLISHABLE_KEY` | Secret | Clerk server configuration |
| `CLERK_SECRET_KEY` | Secret | Clerk server authentication |
| `VITE_CLERK_PUBLISHABLE_KEY` | Secret | Clerk web client |
| `SESSION_SECRET` | Secret | Server session protection |
Do not commit secret values.

## Install

```bash
pnpm install
```

## Run on Replit

The project uses separate managed workflows:

```text
Vendor Compare: pnpm --filter @workspace/vendor-compare run dev
API Server:     pnpm --filter @workspace/api-server run dev
Canvas:         pnpm --filter @workspace/mockup-sandbox run dev
```

The API server binds to the `PORT` environment variable. The web application also receives its `PORT` and `BASE_PATH` from the managed artifact workflow.

## Validation

Run the workspace checks:

```bash
pnpm run typecheck
pnpm run build
```

Run API tests:

```bash
pnpm --filter @workspace/api-server test
```

Some API tests require the development PostgreSQL schema to be up to date.

Repository engineering and decision-quality rules are maintained in
[`.github/DECISIONINTEL_RULES.md`](.github/DECISIONINTEL_RULES.md). The current
as-built design is documented in
[`docs/architecture-and-design.md`](docs/architecture-and-design.md).

## API overview

The commercial API provides:

- Create and retrieve product comparisons
- Tenant-isolated API key authentication
- Idempotency keys for write requests
- Per-minute rate limits
- Prepaid comparison quotas
- Usage reporting

The API contract and generated clients are maintained from `lib/api-spec/openapi.yaml`.

Browser comparison jobs expose a `targetCompletionSeconds` service objective
and server-measured `elapsedMs` while polling. The current target is 120
seconds. It is not an estimated progress percentage or a reason to weaken
source validation.

### Input parsing contract

Both `POST /api/comparisons/parse` and `POST /api/guest/comparisons/parse` run the
same one-shot parsing pipeline before research:

1. Extract comparison intent, subjects, qualifiers, the decision criterion, and
   freshness requirements.
2. Resolve entity boundaries deterministically. Recognized options joined by
   `/`, `&`, commas, `and`, `or`, `vs`, `versus`, or `against` are independent
   entities unless an exact protected entity or product name takes precedence.
3. Preserve user order, canonicalize and deduplicate options, then validate each
   option's sources independently.
4. Use user-provided URLs first during research and use open-web sources only
   where needed. Recommendation-driving facts must come from an official source
   or be corroborated by independent sources.

The parsed response includes `intent.qualifiers`, `intent.decisionCriterion`,
and `intent.freshness`. For example, `MG/Tata & Mahindra` resolves to `MG`,
`Tata`, and `Mahindra`; source validation never receives `MG or Tata` as a
single manufacturer.

After editing the OpenAPI contract, regenerate the server schemas and React
client:

```bash
pnpm --filter @workspace/api-spec run codegen
```

## Beta access

API access is currently free and does not require payment. Tenant-scoped keys remain subject to monthly usage quotas and per-minute rate limits.

## Security notes

- Never grant access based only on a checkout redirect or client-supplied identifier.
- Never expose connector credentials in frontend code.
- API keys are stored as hashes and shown only when created.
- Commercial write requests require an idempotency key.

## License

MIT
