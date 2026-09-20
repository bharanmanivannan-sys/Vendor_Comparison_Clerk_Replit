# DecisionIntel Architecture and Design

**Document status:** As-built reference  
**Last updated:** 20 September 2026  
**System:** DecisionIntel vendor and product comparison platform

## 1. Purpose

DecisionIntel turns a natural-language decision request into an evidence-backed comparison. A user names products, vendors, providers, or an objective; the system identifies the comparison set, researches current evidence, validates the result, calculates weighted scores, and produces a report.

This document describes the current implementation, its runtime boundaries, major data flows, security model, design decisions, and known limitations. It is intended for engineering, product, operations, and future architecture work.

## 2. Architecture Goals

The implementation is designed around these goals:

1. **Ground recommendations in public evidence.** Material claims and scores should be traceable to exact source URLs.
2. **Preserve comparison identity.** The entities accepted from the request remain the canonical ranked set throughout research, scoring, tables, and recommendations.
3. **Keep long AI work off the browser request.** Browser comparison requests use submit-and-poll jobs rather than one long HTTP connection.
4. **Report measured progress.** Progress comes from backend pipeline boundaries, not elapsed-time estimates.
5. **Separate verified facts from assumptions.** Missing or inaccessible evidence is represented as unavailable or low-confidence rather than invented.
6. **Use contract-first API development.** OpenAPI is the source of truth for generated runtime schemas and frontend clients.
7. **Enforce ownership at every boundary.** Authenticated data is scoped by Clerk user identity; commercial API data is scoped by tenant and API key.
8. **Keep scoring reproducible.** Weighted evidence contributions are normalized and reconciled with persisted totals.

## 3. System Context

```mermaid
flowchart LR
    Guest[Guest user]
    User[Authenticated user]
    Customer[API customer]
    Web[DecisionIntel web app]
    API[DecisionIntel API]
    Clerk[Clerk identity]
    OpenAI[OpenAI Responses API]
    WebSources[Public web and official sources]
    Postgres[(PostgreSQL)]

    Guest --> Web
    User --> Web
    Customer -->|Bearer API key| API
    Web -->|REST and job polling| API
    Web --> Clerk
    API --> Clerk
    API --> OpenAI
    OpenAI --> WebSources
    API -->|source validation| WebSources
    API --> Postgres
```

### External dependencies

| Dependency | Responsibility |
|---|---|
| Clerk | Browser authentication, session validation, and user identity |
| OpenAI | Intent extraction, web-assisted product research, structured analysis, and repair passes |
| Public web sources | Official product pages, regulators, standards bodies, filings, and reputable local evidence |
| PostgreSQL | Persistent comparisons, evidence, users, tenants, API keys, usage, idempotency records, and visitor sessions |
| Replit workflows and artifact routing | Development runtime, path-based preview routing, and deployment execution |

## 4. Repository and Runtime Topology

The repository is a pnpm workspace with separate web and API artifacts plus shared libraries.

```text
artifacts/
  api-server/          Express API and background comparison work
  vendor-compare/      React/Vite DecisionIntel web application
  mockup-sandbox/      Isolated design and component preview artifact
lib/
  api-spec/            OpenAPI source and Orval configuration
  api-client-react/    Generated React Query client and custom fetch layer
  api-zod/             Generated Zod request/response schemas
  db/                  Drizzle schema, database client, and migrations
docs/                  Engineering and operational reference documents
```

### Runtime containers

```mermaid
flowchart TB
    subgraph Browser
      React[React/Vite web app]
      Query[React Query cache]
      ClerkBrowser[Clerk browser SDK]
    end

    subgraph APIRuntime[API server process]
      Express[Express routes and middleware]
      Jobs[In-memory comparison job registry]
      Analysis[Research and analysis pipeline]
      Services[Auth, quota, visitor, and persistence services]
    end

    subgraph SharedLibraries
      Spec[OpenAPI specification]
      Client[Generated React client]
      Zod[Generated Zod schemas]
      DB[Drizzle schema and client]
    end

    React --> Query
    React --> ClerkBrowser
    Query --> Client
    Client --> Express
    Express --> Zod
    Express --> Jobs
    Jobs --> Analysis
    Express --> Services
    Services --> DB
    Spec -.generates.-> Client
    Spec -.generates.-> Zod
```

## 5. Frontend Design

### 5.1 Technology and responsibilities

The web application uses React, Vite, TypeScript, React Query, wouter, Clerk, and generated API hooks. Its entry point is `artifacts/vendor-compare/src/main.tsx`; the main product surface is currently consolidated in `artifacts/vendor-compare/src/App.tsx`.

The frontend is responsible for:

- Guest and authenticated navigation.
- Prompt and optional source URL collection.
- Asynchronous comparison job submission and polling.
- Rendering measured backend progress.
- Dashboard, history, and comparison detail views.
- PDF and JSON export.
- Clerk sign-in and sign-up flows.
- Session-scoped guest result and draft handling.

### 5.2 State model

| State type | Mechanism | Examples |
|---|---|---|
| Server state | React Query | Dashboard summary, history, comparison details |
| Authentication | Clerk React SDK | Session state and bearer token acquisition |
| Job progress | Local React state updated by polling | Current backend stage, identified entities, subject |
| Form state | Local React state | Prompt, optional URLs, validation feedback |
| Short-lived browser state | `sessionStorage` | Draft prompts and guest comparison handoff |

The API client obtains a fresh Clerk bearer token through the custom fetch layer. Query retries exclude unauthorized responses, and server-state refresh behavior is configured centrally.

### 5.3 Comparison submission flow

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web app
    participant A as API
    participant J as Background job

    U->>W: Submit prompt and optional URLs
    W->>A: POST /comparison-jobs
    A->>A: Validate and parse request
    A->>J: Register job and start work
    A-->>W: 202 jobId, entities, subject, initial stage
    loop Until complete or failed
      W->>A: GET /comparison-jobs/:id
      A-->>W: Status, measured stage, progress
    end
    A-->>W: Completed comparison result
    W->>W: Navigate to result
```

The browser does not calculate progress from elapsed time. It displays:

- Request understood.
- Identified canonical entities.
- Identified subject.
- The current backend research stage.
- Completed stages inferred only from forward backend state transitions.

## 6. API Design

### 6.1 Middleware and route boundaries

The Express application is assembled in `artifacts/api-server/src/app.ts`. It provides:

- Structured request logging.
- CORS and credential handling.
- JSON and form parsing.
- Clerk middleware.
- Cache prevention for API responses.
- API route composition.
- Production Clerk frontend proxy support.

Primary route groups include:

| Route group | Purpose |
|---|---|
| Health | Runtime health checks |
| Guest comparison routes | Rate-limited prompt parsing, job creation, polling, and guest results |
| Authenticated comparison routes | Dashboard, history, persistent comparisons, jobs, and deletion |
| Commercial `/v1` routes | Tenant-scoped API-key access, quota, usage, and idempotent comparison requests |
| Management routes | Tenant and commercial account operations |

### 6.2 Contract-first development

`lib/api-spec/openapi.yaml` is the API contract source of truth. Orval generates:

- React Query hooks and TypeScript models in `lib/api-client-react`.
- Zod schemas and TypeScript models in `lib/api-zod`.

Route handlers validate outgoing and incoming structures with generated schemas. After changing OpenAPI, code generation must run before application code uses the new contract.

## 7. Asynchronous Comparison Job Architecture

### 7.1 Job lifecycle

Browser comparison jobs are maintained in an in-process map keyed by UUID. Every job includes:

- Owner identifier.
- `processing`, `complete`, or `failed` status.
- Current measured stage.
- Identified entities and subject.
- Result or stable failure information.
- Creation timestamp.

Jobs are owner-bound. An authenticated user cannot poll another user’s job, and guest ownership is tied to the server-derived guest request owner. Expired jobs are pruned after the configured retention window.

### 7.2 State machine

```mermaid
stateDiagram-v2
    [*] --> FindingOfficialSources
    FindingOfficialSources --> BuildingEvidence
    BuildingEvidence --> AnalysingEvidence
    AnalysingEvidence --> ValidatingComparison
    ValidatingComparison --> PreparingResult
    PreparingResult --> Completed

    FindingOfficialSources --> Failed
    BuildingEvidence --> Failed
    AnalysingEvidence --> Failed
    ValidatingComparison --> Failed
    PreparingResult --> Failed
    Completed --> [*]
    Failed --> [*]
```

Stages have the following meaning:

| Stage | Measured boundary |
|---|---|
| `finding_official_sources` | Request parsing has completed and deterministic official-source discovery begins |
| `building_evidence` | Web-assisted research is collecting and structuring evidence |
| `analysing_evidence` | Returned evidence is normalized, scored, and reconciled |
| `validating_comparison` | Canonical entity and comparison consistency checks run |
| `preparing_result` | The validated result is assembled and, when authenticated, persisted |
| `completed` | A response-safe result is available |

No percentage is exposed because the number of web searches, repair passes, URL checks, and normalization operations varies by request.

### 7.3 Failure model

Jobs expose stable high-level failure codes:

- `research_failed`
- `validation_failed`

User-facing messages distinguish unsupported evidence from malformed comparison output where possible. Detailed errors are logged server-side without returning stack traces to the browser.

## 8. Research and Analysis Pipeline

The main pipeline is implemented in `artifacts/api-server/src/lib/analysis.ts`.

```mermaid
flowchart TD
    Input[Validated prompt, entities, criteria, URLs]
    Identity[Freeze canonical comparison identity]
    Market[Infer market, currency, and category]
    Official[Seed official local sources]
    Discovery{Concrete products already known?}
    Shortlist[Discover concrete shortlist]
    Research[Web-assisted structured research]
    Repair[Conditional structured-output repair]
    URLs[Collect, market-filter, and validate URLs]
    Normalize[Normalize evidence and weighted scores]
    Domain[Apply domain-specific quality rules]
    Canonical[Validate canonical entity consistency]
    Result[Analysis payload]

    Input --> Identity
    Identity --> Market
    Market --> Official
    Official --> Discovery
    Discovery -->|No| Shortlist
    Discovery -->|Yes| Research
    Shortlist --> Research
    Research --> Repair
    Repair --> URLs
    URLs --> Normalize
    Normalize --> Domain
    Domain --> Canonical
    Canonical --> Result
```

### 8.1 Intent and comparison identity

The parser extracts:

- Canonical entities.
- Subject or segment.
- Decision type and use case.
- Criteria.
- Market context.

Deterministic validation prevents model output from silently redefining the ranked comparison set. Objective phrases and categories cannot be treated as vendor names. When an open-ended objective requires product discovery, the system selects concrete products before full analysis.

### 8.2 Evidence policy

The pipeline prioritizes:

1. Official local product, pricing, warranty, subscription, finance, and support pages.
2. Government, regulator, standards, and audited sources.
3. Reputable local independent sources with identifiable methodology.

Market-specific terms must not be replaced with another country’s pricing or product conditions. Non-official fallback evidence is freshness-limited. Search snippets, anonymous posts, affiliate pages, and unsupported AI summaries are not authoritative evidence.

### 8.3 Source validation

Collected URLs are:

- Deduplicated.
- Filtered for the requested market.
- Checked with bounded timeouts and redirects.
- Rejected when they resolve to private or loopback destinations.
- Classified as reachable, referenceable, restricted, or unavailable.

Source availability affects evidence confidence and whether a source can support a score.

### 8.4 Scoring model

Evidence rows carry normalized scores, criterion weights, confidence, support direction, and weighted contribution. Missing evidence becomes neutral, low-confidence evidence rather than a fabricated advantage.

Normalization distinguishes:

- Direct percentages where higher is better.
- Inverse percentages where lower is better, such as complaint, defect, failure, fee, incident, downtime, and interest-rate measures.
- Qualitative evidence.
- Analyst judgment.
- Unverified evidence.

Persisted contributions must reconcile with reported score totals. Recommendation text is reconciled with the scorecard so tied scores and narrative winners do not contradict each other.

### 8.5 Domain-specific controls

The generic comparison pipeline has focused extensions for cases requiring additional evidence structure, including:

- Electric vehicle pricing and specification matrices.
- Indian Battery-as-a-Service comparisons.
- Provider-level credit card discovery.
- Home-loan product and five-year trend research.
- Strategic provider roles and enterprise migration considerations.

These controls add quality requirements without allowing a domain-specific repair pass to replace the canonical entity set.

## 9. Persistence and Data Ownership

### 9.1 Main data areas

The PostgreSQL schema in `lib/db/src/schema` covers:

- Users.
- Comparisons and detailed report structures.
- Normalized comparison evidence.
- Visitor sessions.
- Tenants.
- Tenant API keys.
- Usage events and billing periods.
- Idempotency records.
- Commercial account and retirement/audit data.

### 9.2 Authenticated browser persistence

Authenticated comparisons are persisted atomically after validation. Every list, detail, and delete query is constrained by Clerk `userId`. The browser dashboard currently presents recent history within the product’s configured time window.

Guest comparisons are returned to the browser but are not added to authenticated history.

### 9.3 Commercial API persistence

Commercial API operations are tenant-scoped. The metered comparison path coordinates:

- API-key scope checks.
- Tenant entitlement and quota.
- Idempotency-key ownership.
- Request-hash replay and conflict detection.
- Transaction locking.
- Comparison and evidence persistence.
- Usage event creation.

The comparison result and its billable usage record are committed atomically.

## 10. Authentication, Authorization, and Tenant Isolation

```mermaid
flowchart LR
    Browser -->|Clerk session token| BrowserRoutes[Browser API routes]
    APIClient -->|Tenant bearer API key| CommercialRoutes[Commercial API routes]
    BrowserRoutes --> UserScope[Clerk userId scope]
    CommercialRoutes --> KeyScope[API key scopes]
    KeyScope --> TenantScope[Tenant isolation]
    UserScope --> DB[(PostgreSQL)]
    TenantScope --> DB
```

### Browser users

- Clerk validates the session.
- The server derives `userId`; the client does not choose its owner.
- Queries include the user ownership predicate.
- Guest routes use server-side rate limiting and owner checks.

### Commercial customers

- Bearer API keys are stored and validated through the tenant API-key service.
- Every key has explicit scopes.
- Tenant identity is derived from the key.
- Quota and usage are enforced server-side.
- Idempotency protects duplicate metered execution.

## 11. Security and Privacy Design

Current controls include:

- Generated Zod validation at API boundaries.
- Rejection of unsafe markup, SQL-shaped input, and instruction-injection patterns.
- HTTP/HTTPS URL validation.
- A maximum comparison-set size.
- Canonical entity validation.
- Clerk session validation.
- Tenant API-key scopes and isolation.
- Guest request rate limiting.
- Private-network and loopback blocking during source checks.
- Bounded redirects and timeouts.
- API `no-store` responses and disabled ETags.
- Query-string removal from structured request logs.
- Pseudonymized visitor analytics with inactivity-based retention.
- Stable public error codes instead of internal stack traces.

### Trust boundaries

User prompts, supplied URLs, model output, and web content are all untrusted. Prompts and web pages are treated as data rather than instructions. Model output is parsed, normalized, source-checked, and validated before persistence.

## 12. Observability and Operations

The API uses structured logging for requests and background-job failures. Health endpoints support workflow checks. The application is run as separate Replit workflows for the API, web artifact, and component-preview artifact.

Operational verification includes:

- API and frontend TypeScript checks.
- API unit and integration tests.
- Intent parsing evaluations.
- Citation transport checks across supported Node runtimes.
- Build checks for workspace libraries and artifacts.
- Browser preview and console-log inspection.

Runtime services bind to the Replit-provided port and use artifact-aware base paths. Browser code calls proxied artifact routes rather than hard-coded localhost addresses.

## 13. Deployment Model

```mermaid
flowchart TB
    GitHub[GitHub main branch]
    Build[Workspace build and generated contracts]
    WebDeploy[Web artifact]
    APIDeploy[API artifact]
    Database[(Production PostgreSQL)]
    ClerkProd[Production Clerk configuration]
    OpenAIProd[OpenAI integration]

    GitHub --> Build
    Build --> WebDeploy
    Build --> APIDeploy
    WebDeploy --> APIDeploy
    WebDeploy --> ClerkProd
    APIDeploy --> ClerkProd
    APIDeploy --> OpenAIProd
    APIDeploy --> Database
```

Deployment configuration must provide the production database, Clerk configuration, session secret, and AI integration through environment secrets. Development preview domains are not production URLs and must not be embedded as canonical production addresses.

## 14. Key Design Decisions

### 14.1 Submit-and-poll instead of long browser requests

**Decision:** Browser research uses a short submission request and short polling requests.

**Reason:** Web research and structured repairs can exceed proxy idle windows. Polling is recoverable and gives the UI a stable status surface.

### 14.2 Measured stages instead of estimated percentages

**Decision:** The API exposes named pipeline stages and parsed entities, not a percentage.

**Reason:** Research duration and work volume are not predictable from elapsed time. A timer percentage would misrepresent actual completion.

### 14.3 Canonical identity before research

**Decision:** Freeze the ordered comparison set before downstream analysis.

**Reason:** Research models can otherwise merge brands, substitute products, or allow recommendation text to redefine the options.

### 14.4 Evidence-aware neutral handling

**Decision:** Missing evidence receives neutral, low-confidence treatment.

**Reason:** Absence of evidence must not become a positive or negative score by accident.

### 14.5 Generated API boundary

**Decision:** OpenAPI generates both client hooks and server schemas.

**Reason:** Shared generated contracts reduce drift between React callers, route handlers, and runtime validation.

### 14.6 Separate browser and commercial execution semantics

**Decision:** Browser jobs optimize for interactive progress; commercial requests add tenant quota, billing, and idempotency controls.

**Reason:** The two channels have different ownership, retry, and metering requirements.

## 15. Current Limitations and Risks

### 15.1 Volatile browser job storage

Browser comparison jobs are stored in API process memory. A process restart removes active and recently completed job state. Multi-instance deployment would also require shared job coordination.

**Recommended direction:** Move jobs to durable storage or a queue with leases, retries, stage history, and result retention.

### 15.2 No browser-job resume or idempotency key

A browser retry creates a new job. The commercial path has stronger idempotency semantics than the browser path.

**Recommended direction:** Add a client-generated submission key and server-side request hash for safe retry and resume.

### 15.3 Combined web research and synthesis

The AI web-search request performs evidence discovery and structured synthesis in one provider operation. Backend stages are emitted at real code boundaries, but the provider does not expose fine-grained internal search progress.

**Recommended direction:** If finer progress or deterministic retrieval is required, separate source acquisition from synthesis and persist the evidence set between stages.

### 15.4 Large frontend module

The main UI is concentrated in `App.tsx`, which increases coupling between routing, views, exports, and job state.

**Recommended direction:** Split by route and domain while preserving the generated API boundary and current user journeys.

### 15.5 Legacy synchronous comparison routes

Synchronous browser comparison endpoints coexist with the preferred asynchronous job endpoints.

**Recommended direction:** Confirm external dependencies, deprecate legacy browser usage, and retain only intentionally supported synchronous commercial behavior.

### 15.6 Error-log sensitivity

Background failure logs include error messages and stacks. Although request query strings are removed from access logs, exceptions may still contain source or provider context.

**Recommended direction:** Apply structured error redaction and retention policies appropriate to production data sensitivity.

## 16. Change Guidelines

When changing this architecture:

1. Update `lib/api-spec/openapi.yaml` first for API contract changes.
2. Regenerate the React client and Zod schemas.
3. Keep browser research asynchronous.
4. Emit progress only at real backend boundaries.
5. Preserve the canonical ordered entity set.
6. Validate every material score against source-linked evidence.
7. Keep user and tenant ownership predicates in database queries.
8. Make schema changes additive unless data deletion is explicitly reviewed.
9. Verify API tests, type checks, generated clients, and affected browser flows.
10. Update this document when a runtime boundary, data owner, major pipeline stage, or security assumption changes.

## 17. Primary Code References

| Area | Primary location |
|---|---|
| Web application | `artifacts/vendor-compare/src/App.tsx` |
| Web entry point | `artifacts/vendor-compare/src/main.tsx` |
| API application | `artifacts/api-server/src/app.ts` |
| Comparison routes and jobs | `artifacts/api-server/src/routes/comparisons/index.ts` |
| Research and analysis pipeline | `artifacts/api-server/src/lib/analysis.ts` |
| Commercial API | `artifacts/api-server/src/routes/commercial.ts` |
| API contract | `lib/api-spec/openapi.yaml` |
| Generated React API client | `lib/api-client-react/src` |
| Generated server schemas | `lib/api-zod/src/generated` |
| Database schema | `lib/db/src/schema` |
| Workspace operating guidance | `replit.md` |
