import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpRegistryStore } from "../mcp/registryStore.ts";
import { McpGateway } from "../mcp/gateway.ts";
import { McpRetrievalCache } from "../mcp/retrievalCache.ts";
import {
  ContextRetrievalStrategy,
  assessAnalysisConfidence,
  attachToolCallContextMetadata,
} from "./contextRetrievalStrategy.ts";

const createRuntime = async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptstory-context-retrieval-"));
  const registryFilePath = path.join(tempDir, "mcp-servers.json");
  const secretsFilePath = path.join(tempDir, "mcp-secrets.json");
  const auditLogPath = path.join(tempDir, "mcp-audit.log");
  const cacheMetadataPath = path.join(tempDir, "cache-metadata.json");

  const store = new McpRegistryStore({ registryFilePath, secretsFilePath });
  await store.createServer({
    id: "docs-server",
    name: "Docs Server",
    transport: "http",
    endpointOrCommand: "http://127.0.0.1:7760/mcp",
    auth: { type: "none" },
    enabled: true,
    priority: 10,
    timeouts: {
      requestMs: 2_000,
      cooldownMs: 2_000,
      failureThreshold: 2,
    },
    maxPayload: 5_000,
    allowedResources: [],
  });
  await store.createServer({
    id: "ops-server",
    name: "Ops Server",
    transport: "http",
    endpointOrCommand: "http://127.0.0.1:7761/mcp",
    auth: { type: "none" },
    enabled: true,
    priority: 20,
    timeouts: {
      requestMs: 2_000,
      cooldownMs: 2_000,
      failureThreshold: 2,
    },
    maxPayload: 5_000,
    allowedResources: [],
  });

  let fetchCalls = 0;
  const gateway = new McpGateway({
    registryStore: store,
    auditLogPath,
    fetchImpl: async (input, init) => {
      fetchCalls += 1;
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}")) as {
        type?: string;
        payload?: Record<string, unknown>;
      };
      const query = typeof body.payload?.query === "string" ? body.payload.query : "";
      const payload =
        url.includes("7760")
          ? {
              snippets: [
                {
                  resource: "docs/auth.md",
                  text: `<b>OAuth token policy</b> for ${query}.`,
                },
                {
                  resource: "docs/schema.md",
                  text: "API schema notes for work-item generation and validation rules.",
                },
              ],
            }
          : {
              snippets: [
                {
                  resource: "ops/runbook.md",
                  text: "Incident runbook with rollback steps and production safeguards.",
                },
                {
                  resource: "ops/limits.md",
                  text: "Rate limits, retry intervals, and timeout recommendations.",
                },
              ],
            };

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const cache = new McpRetrievalCache({
    metadataFilePath: cacheMetadataPath,
  });
  const strategy = new ContextRetrievalStrategy({
    featureEnabled: true,
    registryStore: store,
    gateway,
    cache,
  });

  return {
    strategy,
    getFetchCalls: () => fetchCalls,
  };
};

test("ContextRetrievalStrategy auto-smart can skip MCP retrieval for local-only transcript", async () => {
  const runtime = await createRuntime();
  const result = await runtime.strategy.prepare(
    "We should clean up this title and improve wording.",
    "",
    { mode: "auto-smart" },
  );

  assert.equal(result.trace.stage1.needsExternalContext, false);
  assert.equal(result.retrievedSources.length, 0);
  assert.equal(runtime.getFetchCalls(), 0);
});

test("ContextRetrievalStrategy manual enrich enforces budgets and reuses cache", async () => {
  const runtime = await createRuntime();
  const transcript =
    "We need the API schema and OAuth token policy to define secure integration tasks and bug fixes.";
  const policy = {
    mode: "manual-enrich",
    globalTokenBudget: 140,
    perServerTokenBudget: 80,
    maxSnippetCount: 4,
    maxSnippetChars: 120,
    cacheTtlMs: 60_000,
  };

  const first = await runtime.strategy.prepare(transcript, "Current board has login and billing work.", policy);
  assert.equal(first.trace.stage1.needsExternalContext, true);
  assert.ok(first.retrievedSources.length > 0);
  assert.ok(first.retrievedSources.length <= 4);
  assert.ok(first.trace.budgets.usedGlobalTokens <= 140);
  assert.ok(
    Object.values(first.trace.budgets.perServerUsageTokens).every((tokens) => tokens <= 80),
  );
  assert.ok(first.retrievedSources.every((source) => source.content.length <= 120));
  assert.equal(first.citations.length, first.retrievedSources.length);
  assert.equal(runtime.getFetchCalls(), 2);

  const second = await runtime.strategy.prepare(
    transcript,
    "Current board has login and billing work.",
    policy,
  );
  assert.equal(runtime.getFetchCalls(), 2);
  assert.ok(second.trace.cache.hits >= 2);
});

test("Confidence scoring and tool-call metadata include citations", async () => {
  const runtime = await createRuntime();
  const retrieval = await runtime.strategy.prepare(
    "Need API docs for login token expiration bug and acceptance criteria.",
    "",
    { mode: "manual-enrich" },
  );
  assert.ok(retrieval.citations.length > 0);

  const lowConfidence = assessAnalysisConfidence(
    [
      {
        name: "createWorkItem",
        args: {
          type: "BUG",
          title: "Login reset issue",
          description: "Token is rejected.",
        },
      },
    ],
    "Create a bug for token expiration and define reproduction steps.",
  );

  assert.equal(lowConfidence.isLowConfidence, true);
  const withMetadata = attachToolCallContextMetadata(
    [
      {
        name: "createWorkItem",
        args: {
          type: "BUG",
          title: "Login reset issue",
          description: "Token is rejected.",
        },
      },
    ],
    retrieval.citations,
    retrieval.trace,
    lowConfidence,
  ) as Array<{ metadata?: { citations?: unknown[] } }>;

  assert.ok(withMetadata[0]?.metadata);
  assert.ok(Array.isArray(withMetadata[0]?.metadata?.citations));
  assert.ok((withMetadata[0]?.metadata?.citations || []).length > 0);
});
