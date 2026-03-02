# Guardrails

## Non-Negotiable Constraints
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

## Guardrail Enforcement
- Run `npm run check:guardrails` before merge.
- `scripts/check-guardrails.sh` blocks:
  - Deferred-scope artifacts (Capacitor/iOS/Android/Jira paths and dependencies).
  - Committed secrets and tracked environment files.
  - Missing explicit feature-flag declarations (`ENABLE_OPENAI_WRITER`, `ENABLE_ANTHROPIC_WRITER`, `ENABLE_MCP_CONTEXT`).
  - Missing MCP context sanitization path (`server/mcp/sanitizeContext.ts`).

## Local Verification
- Lightweight guardrail check: `npm run check:guardrails`.
- Full local verification flow: `npm run verify`.
