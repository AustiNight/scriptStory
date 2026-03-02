import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { McpRegistryStore } from "./registryStore.ts";

const createTempPaths = async (): Promise<{
  registryFilePath: string;
  secretsFilePath: string;
}> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "scriptstory-mcp-store-"));
  return {
    registryFilePath: path.join(tempDir, "mcp-servers.json"),
    secretsFilePath: path.join(tempDir, "mcp-secrets.json"),
  };
};

test("McpRegistryStore stores auth secrets outside registry and redacts them from server records", async () => {
  const { registryFilePath, secretsFilePath } = await createTempPaths();
  const store = new McpRegistryStore({ registryFilePath, secretsFilePath });

  const created = await store.createServer({
    id: "docs-server",
    name: "Docs Server",
    transport: "http",
    endpointOrCommand: "http://127.0.0.1:7777/mcp",
    auth: {
      type: "header",
      headerName: "x-api-key",
      headerValue: "super-secret-value",
    },
    enabled: true,
    priority: 10,
    timeouts: {
      requestMs: 2_000,
      cooldownMs: 10_000,
      failureThreshold: 2,
    },
    maxPayload: 4_096,
    allowedResources: ["project/docs/*"],
  });

  assert.equal(created.id, "docs-server");
  assert.equal(created.auth.type, "header");
  assert.equal(created.auth.hasSecret, true);
  assert.equal("headerValue" in (created.auth as Record<string, unknown>), false);

  const registryRaw = await fs.readFile(registryFilePath, "utf8");
  assert.equal(registryRaw.includes("super-secret-value"), false);

  const secretsRaw = await fs.readFile(secretsFilePath, "utf8");
  assert.equal(secretsRaw.includes("super-secret-value"), true);

  const patched = await store.patchServer("docs-server", {
    auth: {
      type: "header",
      headerName: "x-api-key",
      hasSecret: true,
    },
  });
  assert.equal(patched.auth.type, "header");
  assert.equal(patched.auth.hasSecret, true);

  await store.patchServer("docs-server", {
    auth: { type: "none" },
  });
  const secretsAfterClear = await fs.readFile(secretsFilePath, "utf8");
  assert.equal(secretsAfterClear.includes("super-secret-value"), false);
});

test("McpRegistryStore delete removes both registry record and stored secrets", async () => {
  const { registryFilePath, secretsFilePath } = await createTempPaths();
  const store = new McpRegistryStore({ registryFilePath, secretsFilePath });

  await store.createServer({
    id: "command-server",
    name: "Command Server",
    transport: "command",
    endpointOrCommand: "echo mcp",
    auth: {
      type: "bearer",
      token: "local-token",
    },
    enabled: true,
    priority: 20,
    timeouts: {
      requestMs: 1_500,
      cooldownMs: 9_000,
      failureThreshold: 3,
    },
    maxPayload: 2_048,
    allowedResources: [],
  });

  const deleted = await store.deleteServer("command-server");
  assert.equal(deleted, true);

  const servers = await store.listServers();
  assert.equal(servers.length, 0);

  const secretsRaw = await fs.readFile(secretsFilePath, "utf8");
  assert.equal(secretsRaw.includes("local-token"), false);
});
