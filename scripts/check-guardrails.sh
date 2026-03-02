#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

FAILED=0

record_error() {
  FAILED=1
  printf '[guardrails] ERROR: %s\n' "$1" >&2
}

record_error_block() {
  FAILED=1
  printf '[guardrails] ERROR: %s\n%s\n' "$1" "$2" >&2
}

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    record_error "Missing required file: $path"
  fi
}

list_tracked_files() {
  git ls-files | rg -v ':Zone\.Identifier$' || true
}

check_forbidden_scope_artifacts() {
  local path_matches
  path_matches="$(list_tracked_files | rg -n '(^|/)(ios|android)(/|$)|(^|/)capacitor(\.|/|$)|(^|/)capacitor\.config\.(json|js|ts)$|(^|/)(jira|atlassian)(/|$)' || true)"
  if [[ -n "$path_matches" ]]; then
    record_error_block "Deferred-scope artifact paths detected." "$path_matches"
  fi

  local capacitor_deps
  capacitor_deps="$(rg -n '"@capacitor/' package.json || true)"
  if [[ -n "$capacitor_deps" ]]; then
    record_error_block "Deferred-scope Capacitor dependency detected in package.json." "$capacitor_deps"
  fi

  local jira_deps
  jira_deps="$(rg -n '"(@atlassian/|jira|jira-client)"' package.json || true)"
  if [[ -n "$jira_deps" ]]; then
    record_error_block "Deferred-scope Jira/Atlassian dependency detected in package.json." "$jira_deps"
  fi
}

check_secret_hygiene() {
  local tracked_env_files
  tracked_env_files="$(list_tracked_files | rg -n '(^|/)\.env(\..+)?$' | rg -v '\.env\.example$' || true)"
  if [[ -n "$tracked_env_files" ]]; then
    record_error_block "Tracked environment file(s) detected; use local, uncommitted env files." "$tracked_env_files"
  fi

  local secret_matches
  secret_matches="$(git grep -nE 'AIza[0-9A-Za-z_-]{35}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}' || true)"
  if [[ -n "$secret_matches" ]]; then
    record_error_block "Possible committed secret(s) detected." "$secret_matches"
  fi
}

check_feature_flags() {
  require_file "config/featureFlags.ts"
  require_file ".env.example"

  local missing_entries=()
  local flag
  for flag in ENABLE_OPENAI_WRITER ENABLE_ANTHROPIC_WRITER ENABLE_MCP_CONTEXT; do
    if ! rg -q "$flag" config/featureFlags.ts; then
      missing_entries+=("config/featureFlags.ts missing ${flag}")
    fi

    if ! rg -q "^${flag}=false$" .env.example; then
      missing_entries+=(".env.example missing ${flag}=false")
    fi
  done

  if ((${#missing_entries[@]} > 0)); then
    local details=""
    local item
    for item in "${missing_entries[@]}"; do
      details+="- ${item}"$'\n'
    done
    record_error_block "Explicit feature-flag guardrails are incomplete." "$details"
  fi
}

check_mcp_sanitization_path() {
  require_file "server/mcp/sanitizeContext.ts"

  if [[ -f "server/mcp/sanitizeContext.ts" ]]; then
    if ! rg -q 'export function sanitizeMcpContext' server/mcp/sanitizeContext.ts; then
      record_error "server/mcp/sanitizeContext.ts must export sanitizeMcpContext."
    fi

    if ! rg -q 'source' server/mcp/sanitizeContext.ts; then
      record_error "MCP sanitization output must remain source-tagged."
    fi

    if ! rg -q 'maxChars|DEFAULT_MAX_CHARS|truncated' server/mcp/sanitizeContext.ts; then
      record_error "MCP sanitization output must remain bounded and truncation-aware."
    fi
  fi
}

check_guardrail_docs() {
  require_file "docs/guardrails.md"
}

check_guardrail_docs
check_forbidden_scope_artifacts
check_secret_hygiene
check_feature_flags
check_mcp_sanitization_path

if [[ "$FAILED" -ne 0 ]]; then
  printf '[guardrails] Validation failed.\n' >&2
  exit 1
fi

printf '[guardrails] All guardrail checks passed.\n'
