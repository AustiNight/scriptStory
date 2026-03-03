import { randomUUID } from "node:crypto";
import { HttpError } from "../http/errors.ts";
import { LOCAL_DATA_DOCUMENTS } from "../localData/documents.ts";
import {
  FileLocalDataStorageAdapter,
  type LocalDataStorageAdapter,
} from "../localData/storage.ts";
import {
  MCP_REGISTRY_SCHEMA_VERSION,
  MCP_SECRETS_SCHEMA_VERSION,
  assertRegistryFileShape,
  assertSecretsFileShape,
  parseMcpServerCreateInput,
  parseMcpServerPatchInput,
  type McpRegistryFile,
  type McpSecretsFile,
  type McpServerAuth,
  type McpServerRecord,
  type McpServerSecrets,
} from "./schema.ts";

export interface McpRegistryRepository {
  listServers(): Promise<McpServerRecord[]>;
  getServerById(serverId: string): Promise<McpServerRecord | null>;
  getSecretsForServer(serverId: string): Promise<McpServerSecrets>;
  createServer(input: unknown): Promise<McpServerRecord>;
  patchServer(serverId: string, input: unknown): Promise<McpServerRecord>;
  deleteServer(serverId: string): Promise<boolean>;
}

export interface McpRegistryStoreOptions {
  registryFilePath?: string;
  secretsFilePath?: string;
  storage?: LocalDataStorageAdapter;
}

const createEmptyRegistry = (): McpRegistryFile => ({
  schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
  servers: [],
});

const createEmptySecrets = (): McpSecretsFile => ({
  schemaVersion: MCP_SECRETS_SCHEMA_VERSION,
  secretsByServerId: {},
});

const hasSecretForAuthType = (auth: McpServerAuth, secrets: McpServerSecrets): boolean => {
  if (auth.type === "bearer") {
    return typeof secrets.bearerToken === "string" && secrets.bearerToken.length > 0;
  }

  if (auth.type === "basic") {
    return typeof secrets.basicPassword === "string" && secrets.basicPassword.length > 0;
  }

  if (auth.type === "header") {
    return typeof secrets.headerValue === "string" && secrets.headerValue.length > 0;
  }

  return false;
};

const applySecretPresence = (auth: McpServerAuth, secrets: McpServerSecrets): McpServerAuth => {
  if (auth.type === "none") {
    return auth;
  }

  return {
    ...auth,
    hasSecret: hasSecretForAuthType(auth, secrets),
  };
};

const buildDefaultStorage = (options: McpRegistryStoreOptions): LocalDataStorageAdapter => {
  const documentPaths: Partial<Record<string, string>> = {};
  if (options.registryFilePath) {
    documentPaths[LOCAL_DATA_DOCUMENTS.mcpRegistry] = options.registryFilePath;
  }
  if (options.secretsFilePath) {
    documentPaths[LOCAL_DATA_DOCUMENTS.mcpSecrets] = options.secretsFilePath;
  }

  return new FileLocalDataStorageAdapter({
    ...(Object.keys(documentPaths).length > 0 ? { documentPaths } : {}),
  });
};

export class McpRegistryStore implements McpRegistryRepository {
  private readonly storage: LocalDataStorageAdapter;
  private writeQueue: Promise<void>;

  constructor(options: McpRegistryStoreOptions = {}) {
    this.storage = options.storage || buildDefaultStorage(options);
    this.writeQueue = Promise.resolve();
  }

  private async ensureFilesExist(): Promise<void> {
    await Promise.all([
      this.storage.ensureDocument(LOCAL_DATA_DOCUMENTS.mcpRegistry, createEmptyRegistry()),
      this.storage.ensureDocument(LOCAL_DATA_DOCUMENTS.mcpSecrets, createEmptySecrets()),
    ]);
  }

  private async readRegistryFile(): Promise<McpRegistryFile> {
    await this.ensureFilesExist();
    try {
      const data = await this.storage.readDocument(LOCAL_DATA_DOCUMENTS.mcpRegistry);
      return assertRegistryFileShape(data);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(500, "MCP_REGISTRY_INVALID", "Failed to read MCP registry file.");
    }
  }

  private async readSecretsFile(): Promise<McpSecretsFile> {
    await this.ensureFilesExist();
    try {
      const data = await this.storage.readDocument(LOCAL_DATA_DOCUMENTS.mcpSecrets);
      return assertSecretsFileShape(data);
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      throw new HttpError(500, "MCP_SECRETS_INVALID", "Failed to read MCP secrets file.");
    }
  }

  private async writeRegistryFile(file: McpRegistryFile): Promise<void> {
    await this.storage.writeDocument(LOCAL_DATA_DOCUMENTS.mcpRegistry, file);
  }

  private async writeSecretsFile(file: McpSecretsFile): Promise<void> {
    await this.storage.writeDocument(LOCAL_DATA_DOCUMENTS.mcpSecrets, file);
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  public async listServers(): Promise<McpServerRecord[]> {
    const [registry, secrets] = await Promise.all([this.readRegistryFile(), this.readSecretsFile()]);

    return registry.servers
      .map((server) => ({
        ...server,
        auth: applySecretPresence(server.auth, secrets.secretsByServerId[server.id] || {}),
      }))
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));
  }

  public async getServerById(serverId: string): Promise<McpServerRecord | null> {
    const [registry, secrets] = await Promise.all([this.readRegistryFile(), this.readSecretsFile()]);
    const server = registry.servers.find((entry) => entry.id === serverId);
    if (!server) {
      return null;
    }

    return {
      ...server,
      auth: applySecretPresence(server.auth, secrets.secretsByServerId[server.id] || {}),
    };
  }

  public async getSecretsForServer(serverId: string): Promise<McpServerSecrets> {
    const secrets = await this.readSecretsFile();
    return { ...(secrets.secretsByServerId[serverId] || {}) };
  }

  public async createServer(input: unknown): Promise<McpServerRecord> {
    return this.enqueueWrite(async () => {
      const parsed = parseMcpServerCreateInput(input);
      const [registry, secrets] = await Promise.all([this.readRegistryFile(), this.readSecretsFile()]);
      const id = parsed.id || randomUUID();

      if (registry.servers.some((server) => server.id === id)) {
        throw new HttpError(409, "MCP_SERVER_EXISTS", `MCP server with id "${id}" already exists.`);
      }

      const now = new Date().toISOString();
      const persistedSecrets: McpServerSecrets = { ...parsed.authSecrets };

      const server: McpServerRecord = {
        id,
        scopeType: parsed.scopeType,
        scopeId: parsed.scopeId,
        name: parsed.name,
        transport: parsed.transport,
        endpointOrCommand: parsed.endpointOrCommand,
        auth: applySecretPresence(parsed.auth, persistedSecrets),
        enabled: parsed.enabled,
        priority: parsed.priority,
        timeouts: parsed.timeouts,
        maxPayload: parsed.maxPayload,
        allowedResources: parsed.allowedResources,
        createdAt: now,
        updatedAt: now,
      };

      registry.servers.push(server);
      secrets.secretsByServerId[id] = persistedSecrets;

      await Promise.all([this.writeRegistryFile(registry), this.writeSecretsFile(secrets)]);
      return server;
    });
  }

  public async patchServer(serverId: string, input: unknown): Promise<McpServerRecord> {
    return this.enqueueWrite(async () => {
      const patch = parseMcpServerPatchInput(input);
      const [registry, secrets] = await Promise.all([this.readRegistryFile(), this.readSecretsFile()]);

      const currentIndex = registry.servers.findIndex((server) => server.id === serverId);
      if (currentIndex === -1) {
        throw new HttpError(404, "MCP_SERVER_NOT_FOUND", `MCP server "${serverId}" was not found.`);
      }

      const current = registry.servers[currentIndex];
      const nextId = patch.id || current.id;
      if (nextId !== serverId && registry.servers.some((server) => server.id === nextId)) {
        throw new HttpError(409, "MCP_SERVER_EXISTS", `MCP server with id "${nextId}" already exists.`);
      }

      const currentSecrets = { ...(secrets.secretsByServerId[current.id] || {}) };
      let nextSecrets = { ...currentSecrets };

      if (patch.auth) {
        const authTypeChanged = patch.auth.type !== current.auth.type;
        if (authTypeChanged || !patch.preserveExistingSecret) {
          nextSecrets = {};
        }
      }

      if (patch.authSecrets) {
        nextSecrets = { ...nextSecrets, ...patch.authSecrets };
      }

      if (patch.auth?.type === "none") {
        nextSecrets = {};
      }

      const nextAuth = patch.auth
        ? applySecretPresence(patch.auth, nextSecrets)
        : applySecretPresence(current.auth, nextSecrets);
      const now = new Date().toISOString();
      const nextServer: McpServerRecord = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.transport !== undefined ? { transport: patch.transport } : {}),
        ...(patch.endpointOrCommand !== undefined ? { endpointOrCommand: patch.endpointOrCommand } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.maxPayload !== undefined ? { maxPayload: patch.maxPayload } : {}),
        ...(patch.allowedResources !== undefined ? { allowedResources: patch.allowedResources } : {}),
        ...(patch.timeouts
          ? {
              timeouts: {
                ...current.timeouts,
                ...(patch.timeouts.requestMs !== undefined
                  ? { requestMs: patch.timeouts.requestMs }
                  : {}),
                ...(patch.timeouts.cooldownMs !== undefined
                  ? { cooldownMs: patch.timeouts.cooldownMs }
                  : {}),
                ...(patch.timeouts.failureThreshold !== undefined
                  ? { failureThreshold: patch.timeouts.failureThreshold }
                  : {}),
              },
            }
          : {}),
        ...(patch.auth ? { auth: nextAuth } : { auth: applySecretPresence(current.auth, nextSecrets) }),
        id: nextId,
        updatedAt: now,
      };

      registry.servers[currentIndex] = nextServer;

      if (nextId !== current.id) {
        delete secrets.secretsByServerId[current.id];
      }

      if (Object.keys(nextSecrets).length === 0) {
        delete secrets.secretsByServerId[nextId];
      } else {
        secrets.secretsByServerId[nextId] = nextSecrets;
      }

      await Promise.all([this.writeRegistryFile(registry), this.writeSecretsFile(secrets)]);
      return nextServer;
    });
  }

  public async deleteServer(serverId: string): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const [registry, secrets] = await Promise.all([this.readRegistryFile(), this.readSecretsFile()]);
      const beforeLength = registry.servers.length;
      registry.servers = registry.servers.filter((server) => server.id !== serverId);
      const deleted = registry.servers.length < beforeLength;

      if (!deleted) {
        return false;
      }

      delete secrets.secretsByServerId[serverId];
      await Promise.all([this.writeRegistryFile(registry), this.writeSecretsFile(secrets)]);
      return true;
    });
  }
}
