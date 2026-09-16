# Vendor Compare

Vendor Compare is an evidence-backed product comparison application. Users describe a decision in plain language, optionally provide source URLs, and receive researched product scoring, trade-offs, and a recommendation.

The repository also includes a free-beta, tenant-scoped API with usage controls.

## Features

- Natural-language product and vendor comparison
- Brand-level product discovery, including recommendations across product catalogs
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

## API overview

The commercial API provides:

- Create and retrieve product comparisons
- Tenant-isolated API key authentication
- Idempotency keys for write requests
- Per-minute rate limits
- Prepaid comparison quotas
- Usage reporting

The API contract and generated clients are maintained from `lib/api-spec/openapi.yaml`.

## Beta access

API access is currently free and does not require payment. Tenant-scoped keys remain subject to monthly usage quotas and per-minute rate limits.

## Security notes

- Never grant access based only on a checkout redirect or client-supplied identifier.
- Never expose connector credentials in frontend code.
- API keys are stored as hashes and shown only when created.
- Commercial write requests require an idempotency key.

## License

MIT
