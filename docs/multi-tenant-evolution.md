# Multi-Tenant Evolution Plan

## Current MVP Baseline

- Runtime model remains single-user local execution.
- Config ownership is explicit on persisted MCP server records:
  - `scopeType`
  - `scopeId`
- MVP writes fixed ownership defaults:
  - `scopeType: "local-user"`
  - `scopeId: "local-default"`
- `.local-data` remains the active persistence backend.

## Data Scope Model

### Workspace Scope (Future)

The following data should move to workspace scope in a multi-user rollout:

- MCP server registry entries (`mcp-servers.json` equivalent data).
- MCP server secret references/credentials (or secure secret indirection).
- Shared context retrieval policy defaults and retrieval budget baselines.
- Team-level provider defaults for writer/transcription roles where required.

### User Scope (Future)

The following data should remain user-scoped:

- Per-user provider preference overrides.
- Personal context policy overrides (if allowed by workspace policy).
- User-local diagnostics preferences and view settings.

### Hybrid/Policy-Driven Scope

- Some defaults should be workspace-owned with optional user override:
  - writer provider selection default
  - retrieval mode default (`auto-smart` vs `manual-enrich`)

## Storage Migration Strategy

## 1. Introduce scope-aware repositories

- Keep repository contracts stable, but make scope explicit in domain records.
- Continue writing MVP local defaults while multi-user is disabled.

## 2. Replace file adapter with DB adapter

- Current stores use a storage adapter interface around `.local-data` JSON docs.
- Add a database-backed adapter that implements the same methods.
- Keep business logic in stores/repositories unchanged.

## 3. Dual-read / single-write bridge (optional rollout)

- Read from DB first, fallback to local file for unmigrated records.
- Continue writing to local files until migration is verified.
- Flip to DB writes after verification; keep file reads as temporary fallback.

## 4. Cutover and cleanup

- Disable fallback reads after migration confidence threshold is met.
- Remove legacy file-path overrides after full tenant migration.

## Backward Compatibility Steps

1. Existing local files remain valid and readable.
2. Legacy MCP records without scope fields are automatically backfilled to MVP local scope in memory.
3. New writes include explicit `scopeType` and `scopeId`.
4. API behavior remains unchanged for current single-user local flows.

## Non-Goals In This Milestone

- No multi-user auth/session model.
- No workspace membership or permissions model.
- No cloud database rollout in this branch.
