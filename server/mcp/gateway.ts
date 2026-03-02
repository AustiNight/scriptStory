import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { LOCAL_DATA_DIR } from "../config/paths.ts";
import { HttpError } from "../http/errors.ts";
import { sanitizeMcpContext, type SanitizedMcpContextSnippet } from "./sanitizeContext.ts";
import { McpRegistryStore } from "./registryStore.ts";
import type { McpServerAuth, McpServerRecord, McpServerSecrets } from "./schema.ts";

type FetchLike = typeof fetch;
type SpawnLike = typeof spawn;

interface InternalHealthState {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  openUntilMs?: number;
}

export interface McpServerHealthState {
  state: "closed" | "open" | "half-open";
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  retryAfterMs: number;
}

export interface McpGatewayTestResult {
  serverId: string;
  serverName: string;
  transport: "http" | "command";
  reachable: boolean;
  latencyMs: number;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
  outputSnippet?: SanitizedMcpContextSnippet;
  health: McpServerHealthState;
}

export interface McpGatewayOptions {
  registryStore: McpRegistryStore;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  now?: () => number;
  auditLogPath?: string;
}

interface HttpExecutionResult {
  statusCode: number;
  content: unknown;
  truncated: boolean;
}

interface CommandExecutionResult {
  exitCode: number;
  content: unknown;
  truncated: boolean;
}

interface BoundedReadResult {
  text: string;
  truncated: boolean;
}

const DEFAULT_AUDIT_LOG_PATH = path.join(LOCAL_DATA_DIR, "mcp-audit.log");
const JSON_CONTENT_TYPE_PATTERN = /application\/json/i;

const parseIfJson = (raw: string, contentType: string | null): unknown => {
  if (raw.trim().length === 0) {
    return "";
  }

  if (!contentType || !JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    return raw;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

const parseCommandLine = (input: string): string[] => {
  const text = input.trim();
  if (!text) {
    return [];
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (quote) {
    throw new Error("Command contains an unclosed quote.");
  }

  if (escaping) {
    current += "\\";
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
};

const boundedDecode = (buffer: Buffer): string => {
  const decoder = new TextDecoder();
  return decoder.decode(buffer);
};

const keepWithinLimit = (current: Buffer, incoming: Buffer, limit: number): { next: Buffer; truncated: boolean } => {
  if (current.length >= limit) {
    return { next: current, truncated: true };
  }

  const available = limit - current.length;
  if (incoming.length <= available) {
    return { next: Buffer.concat([current, incoming]), truncated: false };
  }

  return { next: Buffer.concat([current, incoming.subarray(0, available)]), truncated: true };
};

export class McpGateway {
  private readonly registryStore: McpRegistryStore;
  private readonly fetchImpl: FetchLike;
  private readonly spawnImpl: SpawnLike;
  private readonly now: () => number;
  private readonly auditLogPath: string;
  private readonly healthByServerId: Map<string, InternalHealthState>;

  constructor(options: McpGatewayOptions) {
    this.registryStore = options.registryStore;
    this.fetchImpl = options.fetchImpl || fetch;
    this.spawnImpl = options.spawnImpl || spawn;
    this.now = options.now || (() => Date.now());
    this.auditLogPath = options.auditLogPath || DEFAULT_AUDIT_LOG_PATH;
    this.healthByServerId = new Map();
  }

  private getOrCreateHealth(serverId: string): InternalHealthState {
    const existing = this.healthByServerId.get(serverId);
    if (existing) {
      return existing;
    }

    const created: InternalHealthState = {
      state: "closed",
      consecutiveFailures: 0,
      totalRequests: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    };
    this.healthByServerId.set(serverId, created);
    return created;
  }

  private toPublicHealth(server: McpServerRecord, health: InternalHealthState): McpServerHealthState {
    const now = this.now();
    const retryAfterMs =
      health.state === "open" && typeof health.openUntilMs === "number"
        ? Math.max(0, health.openUntilMs - now)
        : 0;

    return {
      state: health.state,
      consecutiveFailures: health.consecutiveFailures,
      totalRequests: health.totalRequests,
      totalSuccesses: health.totalSuccesses,
      totalFailures: health.totalFailures,
      lastFailureAt: health.lastFailureAt,
      lastFailureReason: health.lastFailureReason,
      lastSuccessAt: health.lastSuccessAt,
      lastLatencyMs: health.lastLatencyMs,
      retryAfterMs,
    };
  }

  public getServerHealth(server: McpServerRecord): McpServerHealthState {
    const health = this.getOrCreateHealth(server.id);
    return this.toPublicHealth(server, health);
  }

  private beginRequest(server: McpServerRecord): { blocked: boolean; retryAfterMs: number } {
    const health = this.getOrCreateHealth(server.id);
    health.totalRequests += 1;

    if (health.state === "open") {
      const retryAfterMs =
        typeof health.openUntilMs === "number"
          ? Math.max(0, Math.round(health.openUntilMs - this.now()))
          : server.timeouts.cooldownMs;
      if (retryAfterMs > 0) {
        return { blocked: true, retryAfterMs };
      }

      health.state = "half-open";
    }

    return { blocked: false, retryAfterMs: 0 };
  }

  private recordSuccess(server: McpServerRecord, latencyMs: number): void {
    const health = this.getOrCreateHealth(server.id);
    health.state = "closed";
    health.consecutiveFailures = 0;
    health.totalSuccesses += 1;
    health.lastSuccessAt = new Date().toISOString();
    health.lastLatencyMs = latencyMs;
    health.openUntilMs = undefined;
  }

  private recordFailure(server: McpServerRecord, reason: string): void {
    const health = this.getOrCreateHealth(server.id);
    health.totalFailures += 1;
    health.consecutiveFailures += 1;
    health.lastFailureAt = new Date().toISOString();
    health.lastFailureReason = reason;

    const shouldOpen = health.state === "half-open" || health.consecutiveFailures >= server.timeouts.failureThreshold;
    if (shouldOpen) {
      health.state = "open";
      health.openUntilMs = this.now() + server.timeouts.cooldownMs;
      return;
    }

    health.state = "closed";
  }

  private async appendAuditLog(event: Record<string, unknown>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.auditLogPath), { recursive: true });
      await fs.appendFile(this.auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Audit logging must not block runtime behavior.
    }
  }

  private resolveSecret(auth: McpServerAuth, secrets: McpServerSecrets): string | undefined {
    if (auth.type === "none") {
      return undefined;
    }

    if (auth.type === "bearer") {
      if (auth.envVar) {
        const envValue = process.env[auth.envVar];
        return envValue && envValue.trim().length > 0 ? envValue.trim() : undefined;
      }
      return secrets.bearerToken;
    }

    if (auth.type === "basic") {
      if (auth.passwordEnvVar) {
        const envValue = process.env[auth.passwordEnvVar];
        return envValue && envValue.trim().length > 0 ? envValue.trim() : undefined;
      }
      return secrets.basicPassword;
    }

    if (auth.valueEnvVar) {
      const envValue = process.env[auth.valueEnvVar];
      return envValue && envValue.trim().length > 0 ? envValue.trim() : undefined;
    }
    return secrets.headerValue;
  }

  private buildAuthHeaders(auth: McpServerAuth, secrets: McpServerSecrets): Record<string, string> {
    const headers: Record<string, string> = {};
    const secret = this.resolveSecret(auth, secrets);

    if (auth.type === "none") {
      return headers;
    }

    if (!secret) {
      return headers;
    }

    if (auth.type === "bearer") {
      headers.Authorization = `Bearer ${secret}`;
      return headers;
    }

    if (auth.type === "basic") {
      const encoded = Buffer.from(`${auth.username}:${secret}`).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
      return headers;
    }

    headers[auth.headerName] = secret;
    return headers;
  }

  private async readBoundedResponseBody(response: Response, maxBytes: number): Promise<BoundedReadResult> {
    if (!response.body) {
      return { text: "", truncated: false };
    }

    const reader = response.body.getReader();
    let buffered = Buffer.alloc(0);
    let truncated = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const next = keepWithinLimit(buffered, Buffer.from(value), maxBytes);
      buffered = next.next;
      if (next.truncated) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }

    return {
      text: boundedDecode(buffered),
      truncated,
    };
  }

  private async executeHttp(server: McpServerRecord, payload: unknown): Promise<HttpExecutionResult> {
    const secrets = await this.registryStore.getSecretsForServer(server.id);
    const authHeaders = this.buildAuthHeaders(server.auth, secrets);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), server.timeouts.requestMs);

    try {
      const response = await this.fetchImpl(server.endpointOrCommand, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/plain;q=0.9, */*;q=0.5",
          ...authHeaders,
        },
        body: JSON.stringify({
          type: "mcp-probe",
          payload,
        }),
        signal: controller.signal,
      });

      const boundedBody = await this.readBoundedResponseBody(response, server.maxPayload);
      const parsed = parseIfJson(boundedBody.text, response.headers.get("content-type"));

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${typeof parsed === "string" ? parsed.slice(0, 240) : "non-2xx response"}`,
        );
      }

      return {
        statusCode: response.status,
        content: parsed,
        truncated: boundedBody.truncated,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeCommand(server: McpServerRecord, payload: unknown): Promise<CommandExecutionResult> {
    const tokens = parseCommandLine(server.endpointOrCommand);
    if (tokens.length === 0) {
      throw new Error("Command transport requires a non-empty endpointOrCommand.");
    }

    const [command, ...args] = tokens;
    const child = this.spawnImpl(command, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdout.on("data", (chunk: Buffer | string) => {
      const next = keepWithinLimit(
        stdoutBuffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        server.maxPayload,
      );
      stdoutBuffer = next.next;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      const next = keepWithinLimit(
        stderrBuffer,
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
        Math.max(512, Math.floor(server.maxPayload / 2)),
      );
      stderrBuffer = next.next;
      stderrTruncated = stderrTruncated || next.truncated;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, server.timeouts.requestMs);

    try {
      const input = JSON.stringify({ type: "mcp-probe", payload });
      child.stdin.write(input);
      child.stdin.end();

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? -1));
      });

      const stdout = boundedDecode(stdoutBuffer);
      const stderr = boundedDecode(stderrBuffer);
      const truncated = stdoutTruncated || stderrTruncated;

      if (exitCode !== 0) {
        throw new Error(
          `Command exited with code ${exitCode}${stderr ? `: ${stderr.slice(0, 240)}` : ""}`,
        );
      }

      let parsed: unknown = stdout;
      if (stdout.trim().length > 0) {
        try {
          parsed = JSON.parse(stdout) as unknown;
        } catch {
          parsed = stdout;
        }
      }

      return {
        exitCode,
        content: parsed,
        truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  public async testServer(serverId: string, probePayload: unknown): Promise<McpGatewayTestResult> {
    const server = await this.registryStore.getServerById(serverId);
    if (!server) {
      throw new HttpError(404, "MCP_SERVER_NOT_FOUND", `MCP server "${serverId}" was not found.`);
    }

    const startedAt = this.now();
    const circuit = this.beginRequest(server);
    if (circuit.blocked) {
      const latencyMs = Math.max(1, this.now() - startedAt);
      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        action: "test",
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        success: false,
        blockedByCircuit: true,
        retryAfterMs: circuit.retryAfterMs,
      });

      return {
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        reachable: false,
        latencyMs,
        errorCode: "MCP_CIRCUIT_OPEN",
        errorMessage: `Circuit breaker open. Retry in ${circuit.retryAfterMs}ms.`,
        health: this.getServerHealth(server),
      };
    }

    if (!server.enabled) {
      const latencyMs = Math.max(1, this.now() - startedAt);
      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        action: "test",
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        success: false,
        reason: "server-disabled",
      });

      return {
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        reachable: false,
        latencyMs,
        errorCode: "MCP_SERVER_DISABLED",
        errorMessage: "Server is disabled.",
        health: this.getServerHealth(server),
      };
    }

    try {
      const execution =
        server.transport === "http"
          ? await this.executeHttp(server, probePayload)
          : await this.executeCommand(server, probePayload);
      const latencyMs = Math.max(1, this.now() - startedAt);

      this.recordSuccess(server, latencyMs);

      const outputSnippet = sanitizeMcpContext(
        {
          source: {
            serverId: server.id,
            serverName: server.name,
          },
          content: execution.content,
        },
        server.maxPayload,
      );

      outputSnippet.truncated = outputSnippet.truncated || execution.truncated;

      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        action: "test",
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        success: true,
        latencyMs,
      });

      return {
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        reachable: true,
        latencyMs,
        statusCode: "statusCode" in execution ? execution.statusCode : undefined,
        outputSnippet,
        health: this.getServerHealth(server),
      };
    } catch (error) {
      const latencyMs = Math.max(1, this.now() - startedAt);
      const errorMessage = error instanceof Error ? error.message : "MCP probe failed.";

      this.recordFailure(server, errorMessage);

      await this.appendAuditLog({
        timestamp: new Date().toISOString(),
        action: "test",
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        success: false,
        latencyMs,
        errorCode: "MCP_TEST_FAILED",
      });

      return {
        serverId: server.id,
        serverName: server.name,
        transport: server.transport,
        reachable: false,
        latencyMs,
        errorCode: "MCP_TEST_FAILED",
        errorMessage,
        health: this.getServerHealth(server),
      };
    }
  }
}
