# Chat Bot Project Knowledge

## Architecture & Stack
*   **Frontend**: React (React Router, TypeScript).
*   **Backend**: Node.js (TypeScript) + Fastify/Express.
*   **Database**: PostgreSQL.
*   **Database Tooling**: Kysely (Query Builder) + raw SQL, CamelCasePlugin
    enabled — camelCase in code, snake_case in the DB.
*   **AI Provider**: DeepInfra (via OpenAI-compatible API).
*   **AI Framework**: Vercel AI SDK: backend `streamText`/
    `toUIMessageStream` (route `POST /api/threads/:id/chat`), frontend
    `useChat` from `@ai-sdk/react`. AI Connector MVP implemented — details +
    verified SDK behaviour in `features/ai-connector/MVP.md`.
*   **Hosting**: Dockerized on Cubi.

## Key Feature Requirements
*   Real-time chat via SSE.
*   Long-term factual memory extraction shared across sessions via **RAG (Retrieval-Augmented Generation)** using `pgvector`.
*   Message-level observability (cost per token, cache hit/miss).
*   Optional: Token threshold compactisation, user auth/sessions.
*   *Note: MCP (Model Context Protocol) is explicitly out of scope for the
    initial build.*
*   **Security posture (local single-user app):** no auth by design
    (`REQUEST_USER_ID` placeholder). Origin locked via `@fastify/cors`
    (`CORS_ORIGINS` env, defaults `localhost`/`127.0.0.1:5173`) — the
    vite dev proxy and a same-origin nginx proxy bypass it entirely, so it's
    free insurance for cross-origin deployments only. `@fastify/helmet`
    headers, `@fastify/rate-limit` (global 100/min; chat 20/min — the
    `register` must be awaited, limits attach via onRoute hooks). Input
    guards: title string/≤255 enforced in `threadService`; `:threadId`
    UUID-checked in `@services/validation` (400s, not 500s). Deferred
    hardening (db port/creds, prod Dockerfile, markdown URL policy) lives in
    `.pi/FUTURE-IMPROVEMENTS.md`.

## Directories
*   `/adrs`: Architecture Decision Records.
*   `/features`: High-level plans modularized by domain.
*   `frontend/src`: `pages/` (route targets/entries), `components/` (pure UI),
    `actions/<feature>/` (route actions), `services/` (pure I/O), plus
    `App.tsx` + `router.tsx`.

## Backend Structure (layered; connection owned by query layer — ADR 0004)
*   `backend/src/db/db.ts` — the app-wide Kysely/pg singleton. Connection
    resolved at import time: `VITEST_TEST_DATABASE_URL` → `DATABASE_URL` →
    `DB_*` parts. Pool is lazy; `createDbFromPool` exported for global-setup.
    `CamelCasePlugin` is enabled on every instance (app + tests): query
    identifiers, inserts and result rows are camelCase, SQL/schema stay
    snake_case. Migrations keep snake_case literals (no-op for the mapper)
    and must stay idempotent — test provisioning replays them on a fresh
    schema. Raw `sql` bypasses the plugin: use camelCase `AS` aliases there.
*   `backend/src/db/queries/<table>/<query>.ts` — one Kysely query per file;
    the only layer touching Kysely, importing the singleton directly.
    Folders: `threads`, `messages`, `messageUsage`, `users`, `modelConfigs`;
    cross-table joins live under their primary table
    (`messages/listMessagesWithUsageByThread`). Signatures carry domain
    args only (ownership filters: `user_id` rows always).
*   `backend/src/services/*` — business logic only, no Kysely; signatures are
    `(userId, …args)` — `userId` is the only context threaded down
    (`services/aiService` owns the streaming user+assistant exchange).
    `DEFAULT_USER_ID` lives in `userService` (seeding + route-layer
    placeholder).
*   `backend/app/**` — Fastify routes call services; the only layer currently
    assuming a user, via the `REQUEST_USER_ID` placeholder constant, until
    page-level auth resolves it (see FUTURE-IMPROVEMENTS).
*   Tests: real e2e (vitest + testcontainers, no mocks). `useTestDb()` is a
    lifecycle hook (truncate between tests, destroy the pool per file); the
    singleton is redirected to the test DB via `VITEST_TEST_DATABASE_URL`
    published by global-setup; files run serially sharing one database.
    DB resolution: `TEST_DATABASE_URL` → testcontainers → agent-sandbox
    fallback (dev chat_db via gateway, dedicated `chatbot_test` DB).
    Run: `cd backend && npm test` — works on host AND inside the agent
    container.

## Frontend Structure (React Router v7 Data Router)
*   **Routing**: Data Router API via the unified `react-router` package (not
    `react-router-dom`). `src/router.tsx` is a **plain route map** (paths +
    module wiring); each route's loader/action is co-located in that route's
    module. Threads are URL-driven (`/threads/:threadId`); the index route
    redirects to the newest thread via its loader (routing concern, not page).
*   **Placement rules (strict layering)**:
    *   `pages/` = route targets. Framework entries (`AppLayout.tsx`,
        `ChatPage.tsx`) hold only router glue (hooks / `<Outlet/>`) and
        delegate **immediately** to pure components; loaders live there
        (root threads loader in `AppLayout`, messages loader in `ChatPage`,
        wired via `lazy` so it ships in the code-split chunk).
    *   Pages needing no framework (`AboutPage`, `EmptyPage`) live in `pages/`
        as pure files, no wrapper.
    *   `components/` = all pure UI, incl. layouts: `layout/AppShell.tsx`
        (pure chrome wrapping all pages), `layout/ThreadSidebar.tsx`
        (props + callbacks), `chat/ChatView.tsx` (message list + composer),
        `ui/*` (shadcn).
    *   `actions/<feature>/` = route actions `action()` - parse request/formData,
        call a service, `redirect()`: `actions/threads/{newThread,renameThread}.ts`
        (the echo `sendMessage` action was deleted with the AI Connector cutover).
    *   `services/` = pure I/O, **zero framework imports**: `api.ts`
        (`fetchThreads`/`createThread`/`fetchMessages` +
        `Thread`/`Message`/`MessageUsage` types), `utils.ts` (`cn`).
*   **Framework files (only)**: `App.tsx`, `router.tsx`, `pages/AppLayout.tsx`,
    `pages/ChatPage.tsx`, `actions/threads/*`. `ChatPage` is framework glue
    only (loader + revalidation); the live exchange lives in
    `components/chat/ChatController.tsx` — the sole sanctioned
    `@ai-sdk/react` component. Purity is enforced mechanically: the
    depcruise `frontend-purity-*` rules in the validation gate replace
    the old manual grep.
*   **Data flow**: no `useEffect` fetching. Threads via root loader
    (`useRouteLoaderData('root')`), messages via `useLoaderData` in `ChatPage`.
    New chat = `/threads/new` action + `redirect()` (a navigation). Send
    message = `useChat` (`@ai-sdk/react`) POSTing to the streaming chat route;
    on finish the messages loader revalidates so persisted state (incl.
    `message_usage`) becomes source of truth; optimistic/streaming rows are
    merged in `components/chat/ChatController` until reconciliation. Rename =
    `threads/:threadId/rename` action returning `null` (revalidates the root
    threads loader); sidebar shows the draft optimistically via `pendingRename`
    while the dedicated rename fetcher settles.
*   **Pages**: `/` (EmptyPage when no threads), `/about` (static),
    `/threads/:threadId` (ChatPage -> ChatView; only lazy chunk).

## Backend: AI Connector (implemented)
*   `backend/src/services/aiService/` — provider boundary folder; public
    surface is `index.ts` (`submitChat`, `ChatStreamHandle`,
    `DEFAULT_MODEL_ID`, `computeCostUsd`). Internals (folder-private):
    *   `config.ts` — env/provider config: model id, `AI_BASE_URL` mock
        switch, `AI_STREAM_IDLE_TIMEOUT_MS` (default 5s).
    *   `cost.ts` — local pricing map (`$0.10/$0.15 per 1M input/output`) +
        pure `computeCostUsd`.
    *   `usageMap.ts` — usage report → `message_usage` row; only-reported
        fields are set, the rest lands NULL. `Result` failures carry stable
        codes (`thread_not_found`, `provider_not_configured`,
        `stream_timeout`, `provider_error`, `persist_failed`).
    *   `exchange.ts` — `ChatExchange` class: text accumulation, latency
        window, text + usage persistence, single-settlement outcome
        promise, and the inter-token idle watchdog (arms on first text
        delta, fires `onIdleTimeout` → caller aborts via the shared
        `AbortController`).
    *   `submitChat.ts` — the flow: verify thread → insert user+assistant
        rows → `streamText` (system + full history) → wire hooks →
        `toUIMessageStream`.
*   Route `POST /api/threads/:id/chat`: 404 `thread_not_found`, 503
    `provider_not_configured` (message surfaces in the UI error line), 500
    otherwise; aborts on client disconnect; partial text persists as
    `interrupted`/`timeout`. Old echo `POST /api/messages` deleted.
*   Mock inference server: `backend/mock/` — OpenAI-compatible SSE responder
    (deterministic canned replies, `PAUSE:<ms>` test hook, cache token
    telemetry). `npm run mock` (port 4141). Tests point `AI_BASE_URL` at it;
    `DEEPINFRA_API_KEY` only needed for the real provider.
*   Usage NULL policy: provider-dependent columns (`cached_input_tokens`,
    `cache_write_tokens`, `reasoning_tokens`) are nullable; columns we always
    control stay NOT NULL. ai@7 drops `raw` extras, so `cache_write_tokens`
    lands NULL until the SDK surfaces it (fallback reader wired, see MVP.md).
*   `npm run smoke` — end-to-end HTTP smoke (fresh `chatbot_smoke` DB +
    mock server + happy path + interrupt path).
*   Frontend has **no test framework** (decision: none for now); logic covered
    by backend tests + build-time manual verification.

## Conventions
*   **Validation gate**: `npm run gate` is the single definition of clean —
    typecheck → biome → cn-rule → knip (dead code + unlisted deps) →
    depcruise boundaries → env-sync (code ↔ `.env.example` ↔ compose
    passthrough whitelist) → hadolint (skips with a warning when absent) →
    backend tests → frontend build. lefthook runs it pre-commit (wired via
    root `prepare`; a fresh clone just needs `npm install`). Gotchas baked
    in: frontend `typecheck` is `tsc -b` (the solution-style tsconfig makes
    plain `tsc --noEmit` check **zero files**); dependency-cruiser v18
    wants rule lists under `forbidden` and **no `options:` object** (it
    prunes external edges and can crash) — see the comments in
    `.dependency-cruiser.mjs`. New pitfall → add a check before fixing.
*   **Class Merging (The "Prop Superiority" Rule)**: To ensure a parent's injected `className` (used for layout) cannot accidentally override internal styles dictated by explicit component props, always structure `cn()` calls in three layers: `cn(baseDefaults, className, propDrivenClasses)`. Because `tailwind-merge` respects the last conflicting class, placing prop-driven logic *after* `className` mechanically guarantees that explicit React props always win over parent CSS injections. This applies universally across the project, including primitive components (`Button` variants/sizes must not be overridable by `className`).
*   **Module interface**: private by default; anything used outside a folder
    is re-exported through that folder's `index.ts` (the public surface).
    Current barrel owners: `services/aiService/`, `components/chat/`,
    `components/metadata/`. Single-file modules (query layer) self-export.
*   **Result type** (`backend/src/types/result.ts`): success payloads live
    under the `data` field (renamed from `value` on review).