import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpGateway } from "./gateway.ts";
import { McpRegistryStore } from "./registryStore.ts";

const createTempPaths = async (): Promise<{
  registryFilePath: string;
  secretsFilePath: string;
  auditLogPath: string;
}> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptstory-mcp-gateway-"));
  return {
    registryFilePath: path.join(tempDir, "mcp-servers.json"),
    secretsFilePath: path.join(tempDir, "mcp-secrets.json"),
    auditLogPath: path.join(tempDir, "mcp-audit.log"),
  };
};

test("McpGateway opens circuit after repeated failures and recovers after cooldown", async () => {
  const { registryFilePath, secretsFilePath, auditLogPath } = await createTempPaths();
  const store = new McpRegistryStore({ registryFilePath, secretsFilePath });

  await store.createServer({
    id: "failing-http",
    name: "Failing HTTP",
    transport: "http",
    endpointOrCommand: "http://127.0.0.1:7555/mcp",
    auth: { type: "none" },
    enabled: true,
    priority: 10,
    timeouts: {
      requestMs: 2_000,
      cooldownMs: 5_000,
      failureThreshold: 2,
    },
    maxPayload: 2_000,
    allowedResources: [],
  });

  let fetchCalls = 0;
  let now = 10_000;
  const gateway = new McpGateway({
    registryStore: store,
    now: () => now,
    auditLogPath,
    fetchImpl: async () => {
      fetchCalls += 1;
      if (fetchCalls <= 2) {
        return new Response("upstream failure", { status: 500, headers: { "content-type": "text/plain" } });
      }

      return new Response("<b>context</b> is available", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    },
  });

  const first = await gateway.testServer("failing-http", { action: "test-1" });
  assert.equal(first.reachable, false);
  assert.equal(first.errorCode, "MCP_TEST_FAILED");
  assert.equal(first.health.state, "closed");
  assert.equal(first.health.consecutiveFailures, 1);

  const second = await gateway.testServer("failing-http", { action: "test-2" });
  assert.equal(second.reachable, false);
  assert.equal(second.errorCode, "MCP_TEST_FAILED");
  assert.equal(second.health.state, "open");
  assert.equal(second.health.consecutiveFailures, 2);

  const blocked = await gateway.testServer("failing-http", { action: "test-3" });
  assert.equal(blocked.reachable, false);
  assert.equal(blocked.errorCode, "MCP_CIRCUIT_OPEN");
  assert.equal(fetchCalls, 2);

  now += 5_001;
  const recovered = await gateway.testServer("failing-http", { action: "test-4" });
  assert.equal(recovered.reachable, true);
  assert.equal(recovered.health.state, "closed");
  assert.equal(recovered.health.consecutiveFailures, 0);
  assert.ok(recovered.outputSnippet);
  assert.equal(recovered.outputSnippet?.text, "context is available");
});
