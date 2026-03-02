import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readFeatureFlags } from "../../config/featureFlags.ts";
import {
  DEFAULT_PROVIDER_SELECTION,
  sanitizeProviderSelection,
} from "../../config/providerContracts.ts";
import { McpGateway } from "../mcp/gateway.ts";
import { McpRegistryStore } from "../mcp/registryStore.ts";
import { McpRetrievalCache } from "../mcp/retrievalCache.ts";
import { ContextRetrievalStrategy } from "./contextRetrievalStrategy.ts";

const createDisabledRetrievalStrategy = async (): Promise<ContextRetrievalStrategy> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptstory-feature-flags-"));
  const store = new McpRegistryStore({
    registryFilePath: path.join(tempDir, "mcp-servers.json"),
    secretsFilePath: path.join(tempDir, "mcp-secrets.json"),
  });
  const gateway = new McpGateway({
    registryStore: store,
    auditLogPath: path.join(tempDir, "mcp-audit.log"),
  });
  const cache = new McpRetrievalCache({
    metadataFilePath: path.join(tempDir, "cache-metadata.json"),
  });

  return new ContextRetrievalStrategy({
    featureEnabled: false,
    registryStore: store,
    gateway,
    cache,
  });
};

test("feature-flag regression: new capabilities default to disabled", () => {
  const flags = readFeatureFlags({});
  assert.equal(flags.ENABLE_OPENAI_WRITER, false);
  assert.equal(flags.ENABLE_ANTHROPIC_WRITER, false);
  assert.equal(flags.ENABLE_MCP_CONTEXT, false);
});

test("feature-flag regression: provider selection sanitization remains stable with invalid config", () => {
  const selection = sanitizeProviderSelection({
    writer: "not-a-provider",
    transcription: "not-a-provider",
  });
  assert.deepEqual(selection, DEFAULT_PROVIDER_SELECTION);
});

test("feature-flag regression: MCP retrieval returns safe empty result when disabled", async () => {
  const strategy = await createDisabledRetrievalStrategy();
  const result = await strategy.prepare(
    "Need integration docs for OAuth flow.",
    "Project context",
    { mode: "manual-enrich" },
  );

  assert.equal(result.retrievedSources.length, 0);
  assert.equal(result.citations.length, 0);
  assert.equal(result.trace.stage1.needsExternalContext, false);
  assert.equal(result.trace.stage1.reason, "MCP context feature disabled.");
  assert.equal(result.trace.budgets.usedGlobalTokens, 0);
});
