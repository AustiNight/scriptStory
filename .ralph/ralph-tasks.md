# Ralph Tasks

## Guardrails (Non-Negotiable)
- Scope for this implementation is limited to:
  - Add additional AI providers: OpenAI and Anthropic.
  - Add configurable MCP servers for work-item writer context.
- Explicitly deferred (do not implement in this task set):
  - iOS App Store deployment work.
  - Android Play Store deployment work.
  - Jira Cloud integration work.
- MVP target is single-user local execution only (existing app operating model); design must leave a clean migration path to per-user/per-workspace configuration.
- MCP server configuration may accept arbitrary endpoints/commands, but execution must still apply safety controls (timeouts, payload limits, audit logs, and explicit enable/disable controls).
- MCP-sourced content is untrusted input and must be sanitized, source-tagged, and bounded before entering model prompts or UI rendering.
- Optimize for token efficiency without degrading work-item quality:
  - Default strategy is hybrid "Auto-Smart Retrieval" with bounded context budgets.
  - Manual "Enrich Context" path must remain available for high-fidelity cases.
- Preserve current Gemini-based behavior while introducing provider abstraction and new providers.
- Secrets must never be committed to git; use environment variables and local non-committed config files only.

- [x] Epic: Constraint Check (Guardrails)
  - [x] Add `docs/guardrails.md` mirroring the non-negotiable constraints and deferred scope.
  - [x] Add a lightweight guardrail validation script `scripts/check-guardrails.sh` that fails on forbidden scope introduction (Capacitor/iOS/Android/Jira artifacts) in this milestone branch.
  - [x] Add guardrail checks for security constraints (no committed secrets, MCP prompt/context sanitization path present, and provider + MCP features behind explicit flags).
  - [x] Add `npm run check:guardrails` in `package.json` and wire into local verification flow.
  - [x] Acceptance Criteria: Guardrails are documented, scriptable, and enforced before merge; deferred scope artifacts are blocked.

- [x] Epic: Create Local API Runtime For Provider + MCP Orchestration
  - [x] Create `server/` TypeScript runtime (Node + Express/Fastify) and add scripts for `dev:server` and combined `dev` workflow.
  - [x] Configure Vite proxy so browser calls `/api/*` locally without CORS breakage.
  - [x] Add health endpoint (`GET /api/health`) and structured error envelope for all API responses.
  - [x] Bind server to loopback-only (`127.0.0.1`) by default for single-user local MVP.
  - [x] Add secure environment loading for provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, existing Gemini key fallback) from local env files.
  - [x] Add local persistence folder `.local-data/` (gitignored) for single-user config payloads (MCP registry, defaults, cache metadata).
  - [x] Acceptance Criteria: App runs locally with frontend + backend together; no provider secret is read directly by browser code.

- [x] Epic: Introduce AI Provider Abstraction (Frontend + Backend)
  - [x] Define provider contracts:
    - `WriterProvider`: summarize transcript, analyze transcript into tool calls, optional command session.
    - `TranscriptionProvider`: realtime/near-realtime transcript capture capabilities.
  - [x] Add provider capability matrix (realtime audio, streaming text, tool-call support, strict JSON mode).
  - [x] Refactor current Gemini logic in `services/geminiLiveService.ts` behind adapter interfaces without changing output behavior.
  - [x] Add backend provider router (`/api/ai/*`) that dispatches to selected provider adapter.
  - [x] Add feature flags for incremental rollout (`ENABLE_OPENAI_WRITER`, `ENABLE_ANTHROPIC_WRITER`, `ENABLE_MCP_CONTEXT`) with safe defaults.
  - [x] Add provider selection model in app state/local storage with safe defaults (`Gemini` for transcription, configurable writer provider).
  - [x] Acceptance Criteria: Existing workflows still function after abstraction; provider can be swapped by config instead of hard-coded imports.

- [x] Epic: Add OpenAI Provider Adapter
  - [x] Implement backend OpenAI adapter for writer operations:
    - Transcript summarization.
    - Transcript analysis into tool invocations (`createWorkItem`, `updateWorkItem`, `deleteWorkItem`, etc.).
  - [x] Implement streaming/tool-call handling and schema validation so tool arguments match existing `types.ts` contracts.
  - [x] Add retry/backoff and model fallback strategy for transient OpenAI failures.
  - [x] Add provider-specific config fields in settings (model IDs, temperature, max output tokens).
  - [x] Add integration tests with fixed transcript fixtures validating quality and deterministic tool-call extraction shape.
  - [x] Acceptance Criteria: User can choose OpenAI writer provider and produce valid work-item outputs equivalent to Gemini baseline quality.

- [x] Epic: Add Anthropic Provider Adapter
  - [x] Implement backend Anthropic adapter for writer operations:
    - Transcript summarization.
    - Transcript analysis into tool invocations.
  - [x] Define fallback behavior for non-realtime transcription scenarios (keep Gemini transcription path while Anthropic handles writer tasks).
  - [x] Implement tool-use parsing/validation and adapter normalization into shared tool-call objects.
  - [x] Implement streaming response support for long analysis calls and safe truncation behavior.
  - [x] Add provider-specific config fields in settings (model IDs, temperature, max output tokens).
  - [x] Add integration tests with same transcript fixtures used for Gemini/OpenAI to compare extraction fidelity.
  - [x] Acceptance Criteria: User can choose Anthropic writer provider and complete end-to-end work-item generation without schema regressions.

- [x] Epic: Build MCP Gateway + Server Registry (Single-User Local MVP)
  - [x] Add backend MCP gateway service that is the only component allowed to communicate with MCP servers.
  - [x] Add MCP registry schema for arbitrary servers:
    - `id`, `name`, `transport`, `endpointOrCommand`, `auth`, `enabled`, `priority`, `timeouts`, `maxPayload`, `allowedResources`.
  - [x] Persist registry in `.local-data/mcp-servers.json` with schema version for future migration.
  - [x] Add registry CRUD endpoints (`GET/POST/PATCH/DELETE /api/mcp/servers`) and test endpoint (`POST /api/mcp/servers/:id/test`).
  - [x] Add auth-secret handling for MCP server configs (store secrets outside committed files and redact values in logs/API responses).
  - [x] Add context sanitation pipeline for MCP results (truncate oversized payloads, strip unsafe markup, normalize to plain text with source metadata).
  - [x] Add per-server circuit breaker state and health tracking to avoid repeated failures.
  - [x] Acceptance Criteria: Single local user can add arbitrary MCP server configs, test connectivity, enable/disable servers, and persist state across restarts.

- [x] Epic: Implement Token-Efficient Context Retrieval Strategy (Recommended Hybrid)
  - [x] Implement default `Auto-Smart Retrieval` policy:
    - Stage 1: low-token intent classification decides whether external context is needed.
    - Stage 2: fetch candidates from enabled MCP servers, rank, and include only top snippets under strict token budget.
  - [x] Implement manual `Enrich Context` path to force deeper retrieval for difficult/ambiguous items.
  - [x] Add confidence-based escalation: if initial generation confidence/validation is low, perform a second pass with expanded context budget before returning output.
  - [x] Implement budget controller with explicit caps:
    - Global per-request context token budget.
    - Per-server quota cap.
    - Hard ceiling on attached snippet count and snippet length.
  - [x] Add cache for MCP retrieval results (query hash + TTL) to reduce repeated token spend across iterative edits.
  - [x] Add citation objects in tool-call metadata so each generated work-item can show which MCP source snippets influenced output.
  - [x] Acceptance Criteria: Default flow minimizes token usage via bounded retrieval, while manual enrichment can increase fidelity on demand; citations are available for generated items.

- [ ] Epic: Add UI For Provider + MCP Configuration + Context Controls
  - [ ] Extend Settings modal in `App.tsx` with new tabs:
    - `AI Providers`.
    - `MCP Servers`.
    - `Context Policy`.
  - [ ] Add provider selector for writer/transcription roles with model-level config fields.
  - [ ] Add MCP server management UI:
    - Create/edit/delete server entries.
    - Enable/disable toggles.
    - Priority ordering.
    - Connection test action with status output.
  - [ ] Add context policy UI controls:
    - Auto-Smart (default).
    - Manual Enrich action.
    - Token budget sliders/inputs.
  - [ ] Add generated-item context trace view (source citations and retrieval stats) in work-item card details or side panel.
  - [ ] Acceptance Criteria: User can fully configure providers and MCP context behavior from UI without code edits or direct file edits.

- [ ] Epic: Quality, Regression, and Cost Validation
  - [ ] Build transcript fixture suite covering bug reports, stories/features, mixed meeting chatter, and ambiguous requirements.
  - [ ] Add regression checks comparing provider outputs to expected tool-call structure and minimum quality rubric.
  - [ ] Add token usage telemetry per request/provider/server and expose aggregate stats in a local diagnostics panel.
  - [ ] Add failure-mode tests (MCP offline, invalid auth, provider timeout, malformed tool args) and verify graceful fallback behavior.
  - [ ] Add feature-flag regression checks proving app remains stable with new capabilities disabled.
  - [ ] Acceptance Criteria: Provider + MCP features pass regression suite, quality rubric, and token-budget compliance checks with graceful degradation on failures.

- [ ] Epic: Future Evolution Hooks (Per-User/Per-Workspace Readiness Without Implementing Multi-User Now)
  - [ ] Introduce config domain model with explicit ownership fields (`scopeType`, `scopeId`) while using fixed local single-user defaults for MVP.
  - [ ] Add migration-ready storage interfaces so `.local-data` persistence can be replaced later by database-backed per-user/per-workspace storage.
  - [ ] Document upgrade path in `docs/multi-tenant-evolution.md`:
    - What data moves to workspace scope.
    - What stays user scope.
    - Backward compatibility migration steps.
  - [ ] Acceptance Criteria: MVP remains single-user local, but storage/contracts are structured to add user/workspace scoping without breaking existing configs.
