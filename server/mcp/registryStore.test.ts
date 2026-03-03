import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCAL_DATA_DOCUMENTS } from "../localData/documents.ts";
import type { LocalDataStorageAdapter } from "../localData/storage.ts";
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

class InMemoryLocalDataStorageAdapter implements LocalDataStorageAdapter {
  private readonly docs = new Map<string, unknown>();

  public async ensureDocument(documentName: string, initialData: unknown): Promise<boolean> {
    if (this.docs.has(documentName)) {
      return false;
    }

    this.docs.set(documentName, JSON.parse(JSON.stringify(initialData)) as unknown);
    return true;
  }

  public async readDocument(documentName: string): Promise<unknown> {
    if (!this.docs.has(documentName)) {
      throw new Error(`Document not found: ${documentName}`);
    }
    return JSON.parse(JSON.stringify(this.docs.get(documentName))) as unknown;
  }

  public async writeDocument(documentName: string, value: unknown): Promise<void> {
    this.docs.set(documentName, JSON.parse(JSON.stringify(value)) as unknown);
  }

  public resolveDocumentPath(documentName: string): string {
    return `memory://${documentName}`;
  }
}

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
  assert.equal(created.scopeType, "local-user");
  assert.equal(created.scopeId, "local-default");
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

test("McpRegistryStore backfills ownership scope for legacy registry records", async () => {
  const { registryFilePath, secretsFilePath } = await createTempPaths();
  const now = new Date().toISOString();

  await fs.writeFile(
    registryFilePath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: [
          {
            id: "legacy-server",
            name: "Legacy Server",
            transport: "http",
            endpointOrCommand: "http://127.0.0.1:7888/mcp",
            auth: { type: "none" },
            enabled: true,
            priority: 10,
            timeouts: {
              requestMs: 2_000,
              cooldownMs: 10_000,
              failureThreshold: 2,
            },
            maxPayload: 4_096,
            allowedResources: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    secretsFilePath,
    `${JSON.stringify({ schemaVersion: 1, secretsByServerId: {} }, null, 2)}\n`,
    "utf8",
  );

  const store = new McpRegistryStore({ registryFilePath, secretsFilePath });
  const servers = await store.listServers();

  assert.equal(servers.length, 1);
  assert.equal(servers[0].id, "legacy-server");
  assert.equal(servers[0].scopeType, "local-user");
  assert.equal(servers[0].scopeId, "local-default");
});

test("McpRegistryStore supports pluggable storage adapters", async () => {
  const storage = new InMemoryLocalDataStorageAdapter();
  const store = new McpRegistryStore({ storage });

  await store.createServer({
    id: "memory-server",
    name: "Memory Server",
    transport: "command",
    endpointOrCommand: "echo mcp",
    auth: { type: "none" },
    enabled: true,
    priority: 5,
    timeouts: {
      requestMs: 1_000,
      cooldownMs: 4_000,
      failureThreshold: 2,
    },
    maxPayload: 2_048,
    allowedResources: [],
  });

  const registry = (await storage.readDocument(
    LOCAL_DATA_DOCUMENTS.mcpRegistry,
  )) as { servers?: Array<{ id?: string; scopeType?: string; scopeId?: string }> };
  assert.equal(Array.isArray(registry.servers), true);
  assert.equal(registry.servers?.length, 1);
  assert.equal(registry.servers?.[0]?.id, "memory-server");
  assert.equal(registry.servers?.[0]?.scopeType, "local-user");
  assert.equal(registry.servers?.[0]?.scopeId, "local-default");
});
