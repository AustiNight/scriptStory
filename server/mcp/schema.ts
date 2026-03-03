import { HttpError } from "../http/errors.ts";
import {
  MVP_LOCAL_SINGLE_USER_SCOPE,
  type ConfigOwnership,
  type ConfigScopeType,
} from "../config/configOwnership.ts";

export const MCP_REGISTRY_SCHEMA_VERSION = 1;
export const MCP_SECRETS_SCHEMA_VERSION = 1;

export const MCP_TRANSPORTS = ["http", "command"] as const;
export type McpServerTransport = (typeof MCP_TRANSPORTS)[number];

export interface McpServerTimeouts {
  requestMs: number;
  cooldownMs: number;
  failureThreshold: number;
}

export interface McpAuthNone {
  type: "none";
}

export interface McpAuthBearer {
  type: "bearer";
  envVar?: string;
  hasSecret: boolean;
}

export interface McpAuthBasic {
  type: "basic";
  username: string;
  passwordEnvVar?: string;
  hasSecret: boolean;
}

export interface McpAuthHeader {
  type: "header";
  headerName: string;
  valueEnvVar?: string;
  hasSecret: boolean;
}

export type McpServerAuth = McpAuthNone | McpAuthBearer | McpAuthBasic | McpAuthHeader;

export interface McpServerRecord extends ConfigOwnership {
  id: string;
  name: string;
  transport: McpServerTransport;
  endpointOrCommand: string;
  auth: McpServerAuth;
  enabled: boolean;
  priority: number;
  timeouts: McpServerTimeouts;
  maxPayload: number;
  allowedResources: string[];
  createdAt: string;
  updatedAt: string;
}

export interface McpRegistryFile {
  schemaVersion: number;
  servers: McpServerRecord[];
}

export interface McpServerSecrets {
  bearerToken?: string;
  basicPassword?: string;
  headerValue?: string;
}

export interface McpSecretsFile {
  schemaVersion: number;
  secretsByServerId: Record<string, McpServerSecrets>;
}

export interface ParsedMcpServerCreateInput extends ConfigOwnership {
  id?: string;
  name: string;
  transport: McpServerTransport;
  endpointOrCommand: string;
  auth: McpServerAuth;
  authSecrets: McpServerSecrets;
  enabled: boolean;
  priority: number;
  timeouts: McpServerTimeouts;
  maxPayload: number;
  allowedResources: string[];
}

export interface ParsedMcpServerPatchInput {
  id?: string;
  name?: string;
  transport?: McpServerTransport;
  endpointOrCommand?: string;
  auth?: McpServerAuth;
  authSecrets?: McpServerSecrets;
  preserveExistingSecret?: boolean;
  enabled?: boolean;
  priority?: number;
  timeouts?: Partial<McpServerTimeouts>;
  maxPayload?: number;
  allowedResources?: string[];
}

const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{2,64}$/;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const WHITESPACE_PATTERN = /\s+/g;

const DEFAULT_TIMEOUTS: McpServerTimeouts = Object.freeze({
  requestMs: 12_000,
  cooldownMs: 30_000,
  failureThreshold: 3,
});

const DEFAULT_PRIORITY = 100;
const DEFAULT_MAX_PAYLOAD = 16_000;

const normalizeScopeType = (value: unknown): ConfigScopeType =>
  value === "local-user" || value === "user" || value === "workspace"
    ? value
    : MVP_LOCAL_SINGLE_USER_SCOPE.scopeType;

const normalizeScopeId = (value: unknown): string => {
  const normalized = readString(value);
  return normalized || MVP_LOCAL_SINGLE_USER_SCOPE.scopeId;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(WHITESPACE_PATTERN, " ").trim();
  return normalized.length > 0 ? normalized : null;
};

const readBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
};

const clampInteger = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  fieldName: string,
  mode: "create" | "patch",
): number | undefined => {
  if (value === undefined && mode === "patch") {
    return undefined;
  }

  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    if (mode === "patch") {
      throw new HttpError(400, "INVALID_REQUEST", `Field "${fieldName}" must be an integer.`);
    }
    return fallback;
  }

  const rounded = Math.round(parsed);
  if (rounded < min || rounded > max) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Field "${fieldName}" must be between ${min} and ${max}.`,
    );
  }

  return rounded;
};

const validateId = (value: unknown, mode: "create" | "patch"): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"id\" must be a string.");
  }

  const normalized = value.trim();
  if (!SERVER_ID_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "Field \"id\" is invalid. Use 2-64 chars: letters, numbers, underscore, dash.",
    );
  }

  if (mode === "create") {
    return normalized;
  }

  return normalized;
};

const validateTransport = (
  value: unknown,
  mode: "create" | "patch",
): McpServerTransport | undefined => {
  if (value === undefined || value === null || value === "") {
    if (mode === "patch") {
      return undefined;
    }
    throw new HttpError(400, "INVALID_REQUEST", "Field \"transport\" is required.");
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"transport\" must be a string.");
  }

  const normalized = value.trim().toLowerCase();
  if (normalized !== "http" && normalized !== "command") {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"transport\" must be \"http\" or \"command\".");
  }

  return normalized;
};

const validateEnvVar = (value: unknown, fieldName: string): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", `Field "${fieldName}" must be a string.`);
  }

  const normalized = value.trim();
  if (!ENV_VAR_PATTERN.test(normalized)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Field "${fieldName}" must be an environment variable name like EXAMPLE_TOKEN.`,
    );
  }

  return normalized;
};

const validateSecret = (value: unknown, fieldName: string): string | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_REQUEST", `Field "${fieldName}" must be a string.`);
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  if (normalized.length > 4_096) {
    throw new HttpError(400, "INVALID_REQUEST", `Field "${fieldName}" exceeds max length.`);
  }

  return normalized;
};

const parseAuth = (
  value: unknown,
  mode: "create" | "patch",
): {
  auth?: McpServerAuth;
  secrets?: McpServerSecrets;
  preserveExistingSecret?: boolean;
} => {
  if (value === undefined || value === null) {
    if (mode === "patch") {
      return {};
    }
    return { auth: { type: "none" }, secrets: {} };
  }

  const record = asRecord(value);
  if (!record) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"auth\" must be an object.");
  }

  const typeValue = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
  const type = typeValue || "none";

  if (type === "none") {
    return { auth: { type: "none" }, secrets: {} };
  }

  if (type === "bearer") {
    const token = validateSecret(record.token, "auth.token");
    const envVar = validateEnvVar(record.envVar, "auth.envVar");
    const preserveExistingSecret =
      token === undefined &&
      !envVar &&
      readBoolean(record.hasSecret) === true;

    if (!token && !envVar && !preserveExistingSecret && mode === "create") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Bearer auth requires auth.token, auth.envVar, or auth.hasSecret=true.",
      );
    }

    return {
      auth: { type: "bearer", envVar, hasSecret: Boolean(token) || preserveExistingSecret },
      secrets: token ? { bearerToken: token } : {},
      preserveExistingSecret,
    };
  }

  if (type === "basic") {
    const username = readString(record.username);
    if (!username) {
      throw new HttpError(400, "INVALID_REQUEST", "Basic auth requires field \"auth.username\".");
    }

    if (username.length > 256) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"auth.username\" exceeds max length.");
    }

    const password = validateSecret(record.password, "auth.password");
    const passwordEnvVar = validateEnvVar(record.passwordEnvVar, "auth.passwordEnvVar");
    const preserveExistingSecret =
      password === undefined &&
      !passwordEnvVar &&
      readBoolean(record.hasSecret) === true;

    if (!password && !passwordEnvVar && !preserveExistingSecret && mode === "create") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Basic auth requires auth.password, auth.passwordEnvVar, or auth.hasSecret=true.",
      );
    }

    return {
      auth: {
        type: "basic",
        username,
        passwordEnvVar,
        hasSecret: Boolean(password) || preserveExistingSecret,
      },
      secrets: password ? { basicPassword: password } : {},
      preserveExistingSecret,
    };
  }

  if (type === "header") {
    const headerName = readString(record.headerName);
    if (!headerName || !HEADER_NAME_PATTERN.test(headerName)) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Header auth requires valid auth.headerName (letters, numbers, dash).",
      );
    }

    const headerValue = validateSecret(record.headerValue, "auth.headerValue");
    const valueEnvVar = validateEnvVar(record.valueEnvVar, "auth.valueEnvVar");
    const preserveExistingSecret =
      headerValue === undefined &&
      !valueEnvVar &&
      readBoolean(record.hasSecret) === true;

    if (!headerValue && !valueEnvVar && !preserveExistingSecret && mode === "create") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Header auth requires auth.headerValue, auth.valueEnvVar, or auth.hasSecret=true.",
      );
    }

    return {
      auth: {
        type: "header",
        headerName,
        valueEnvVar,
        hasSecret: Boolean(headerValue) || preserveExistingSecret,
      },
      secrets: headerValue ? { headerValue } : {},
      preserveExistingSecret,
    };
  }

  throw new HttpError(400, "INVALID_REQUEST", "Field \"auth.type\" is invalid.");
};

const parseAllowedResources = (
  value: unknown,
  mode: "create" | "patch",
): string[] | undefined => {
  if (value === undefined || value === null) {
    return mode === "create" ? [] : undefined;
  }

  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"allowedResources\" must be an array.");
  }

  const resources: string[] = [];
  for (const entry of value) {
    const resource = readString(entry);
    if (!resource) {
      continue;
    }

    if (resource.length > 300) {
      throw new HttpError(400, "INVALID_REQUEST", "One or more allowedResources entries are too long.");
    }

    resources.push(resource);
  }

  return resources;
};

export const parseMcpServerCreateInput = (value: unknown): ParsedMcpServerCreateInput => {
  const record = asRecord(value);
  if (!record) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  const name = readString(record.name);
  if (!name) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"name\" is required.");
  }
  if (name.length > 160) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"name\" exceeds max length.");
  }

  const endpointOrCommand = readString(record.endpointOrCommand);
  if (!endpointOrCommand) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"endpointOrCommand\" is required.");
  }
  if (endpointOrCommand.length > 2_048) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"endpointOrCommand\" exceeds max length.");
  }

  const auth = parseAuth(record.auth, "create");
  const transport = validateTransport(record.transport, "create");
  const id = validateId(record.id, "create");
  const enabled = readBoolean(record.enabled) ?? true;
  const priority =
    clampInteger(record.priority, DEFAULT_PRIORITY, -1_000, 1_000, "priority", "create") ??
    DEFAULT_PRIORITY;
  const maxPayload =
    clampInteger(record.maxPayload, DEFAULT_MAX_PAYLOAD, 512, 200_000, "maxPayload", "create") ??
    DEFAULT_MAX_PAYLOAD;
  const allowedResources = parseAllowedResources(record.allowedResources, "create") ?? [];
  const timeoutsRecord = asRecord(record.timeouts) ?? {};

  const requestMs =
    clampInteger(
      timeoutsRecord.requestMs,
      DEFAULT_TIMEOUTS.requestMs,
      500,
      120_000,
      "timeouts.requestMs",
      "create",
    ) ?? DEFAULT_TIMEOUTS.requestMs;
  const cooldownMs =
    clampInteger(
      timeoutsRecord.cooldownMs,
      DEFAULT_TIMEOUTS.cooldownMs,
      1_000,
      600_000,
      "timeouts.cooldownMs",
      "create",
    ) ?? DEFAULT_TIMEOUTS.cooldownMs;
  const failureThreshold =
    clampInteger(
      timeoutsRecord.failureThreshold,
      DEFAULT_TIMEOUTS.failureThreshold,
      1,
      10,
      "timeouts.failureThreshold",
      "create",
    ) ?? DEFAULT_TIMEOUTS.failureThreshold;
  const scopeType = normalizeScopeType(record.scopeType);
  const scopeId = normalizeScopeId(record.scopeId);

  return {
    id,
    scopeType: scopeType === "local-user" ? scopeType : MVP_LOCAL_SINGLE_USER_SCOPE.scopeType,
    scopeId:
      scopeType === "local-user" ? scopeId : MVP_LOCAL_SINGLE_USER_SCOPE.scopeId,
    name,
    transport: transport as McpServerTransport,
    endpointOrCommand,
    auth: auth.auth as McpServerAuth,
    authSecrets: auth.secrets ?? {},
    enabled,
    priority,
    timeouts: { requestMs, cooldownMs, failureThreshold },
    maxPayload,
    allowedResources,
  };
};

export const parseMcpServerPatchInput = (value: unknown): ParsedMcpServerPatchInput => {
  const record = asRecord(value);
  if (!record) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  const patch: ParsedMcpServerPatchInput = {};
  const id = validateId(record.id, "patch");
  if (id) {
    patch.id = id;
  }

  if (Object.prototype.hasOwnProperty.call(record, "name")) {
    const name = readString(record.name);
    if (!name) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"name\" cannot be empty.");
    }
    if (name.length > 160) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"name\" exceeds max length.");
    }
    patch.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(record, "transport")) {
    patch.transport = validateTransport(record.transport, "patch");
  }

  if (Object.prototype.hasOwnProperty.call(record, "endpointOrCommand")) {
    const endpointOrCommand = readString(record.endpointOrCommand);
    if (!endpointOrCommand) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"endpointOrCommand\" cannot be empty.");
    }
    if (endpointOrCommand.length > 2_048) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"endpointOrCommand\" exceeds max length.");
    }
    patch.endpointOrCommand = endpointOrCommand;
  }

  if (Object.prototype.hasOwnProperty.call(record, "auth")) {
    const auth = parseAuth(record.auth, "patch");
    if (auth.auth) {
      patch.auth = auth.auth;
      patch.authSecrets = auth.secrets;
      patch.preserveExistingSecret = auth.preserveExistingSecret;
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "enabled")) {
    const enabled = readBoolean(record.enabled);
    if (enabled === null) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"enabled\" must be a boolean.");
    }
    patch.enabled = enabled;
  }

  if (Object.prototype.hasOwnProperty.call(record, "priority")) {
    patch.priority = clampInteger(record.priority, DEFAULT_PRIORITY, -1_000, 1_000, "priority", "patch");
  }

  if (Object.prototype.hasOwnProperty.call(record, "maxPayload")) {
    patch.maxPayload = clampInteger(record.maxPayload, DEFAULT_MAX_PAYLOAD, 512, 200_000, "maxPayload", "patch");
  }

  if (Object.prototype.hasOwnProperty.call(record, "allowedResources")) {
    patch.allowedResources = parseAllowedResources(record.allowedResources, "patch");
  }

  if (Object.prototype.hasOwnProperty.call(record, "timeouts")) {
    const timeoutsRecord = asRecord(record.timeouts);
    if (!timeoutsRecord) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"timeouts\" must be an object.");
    }

    patch.timeouts = {
      requestMs: clampInteger(
        timeoutsRecord.requestMs,
        DEFAULT_TIMEOUTS.requestMs,
        500,
        120_000,
        "timeouts.requestMs",
        "patch",
      ),
      cooldownMs: clampInteger(
        timeoutsRecord.cooldownMs,
        DEFAULT_TIMEOUTS.cooldownMs,
        1_000,
        600_000,
        "timeouts.cooldownMs",
        "patch",
      ),
      failureThreshold: clampInteger(
        timeoutsRecord.failureThreshold,
        DEFAULT_TIMEOUTS.failureThreshold,
        1,
        10,
        "timeouts.failureThreshold",
        "patch",
      ),
    };
  }

  return patch;
};

export const assertRegistryFileShape = (value: unknown): McpRegistryFile => {
  const record = asRecord(value);
  if (!record) {
    throw new HttpError(500, "MCP_REGISTRY_INVALID", "MCP registry file is invalid.");
  }

  const schemaVersion =
    typeof record.schemaVersion === "number"
      ? Math.round(record.schemaVersion)
      : Number.NaN;
  if (!Number.isFinite(schemaVersion)) {
    throw new HttpError(500, "MCP_REGISTRY_INVALID", "MCP registry schemaVersion is invalid.");
  }

  if (schemaVersion !== MCP_REGISTRY_SCHEMA_VERSION) {
    throw new HttpError(
      500,
      "MCP_REGISTRY_SCHEMA_UNSUPPORTED",
      `Unsupported MCP registry schema version ${schemaVersion}.`,
    );
  }

  if (!Array.isArray(record.servers)) {
    throw new HttpError(500, "MCP_REGISTRY_INVALID", "MCP registry servers must be an array.");
  }

  const servers = record.servers
    .filter((entry) => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const server = entry as Partial<McpServerRecord>;
      const normalizedScopeType =
        normalizeScopeType(server.scopeType) === "local-user"
          ? "local-user"
          : MVP_LOCAL_SINGLE_USER_SCOPE.scopeType;
      return {
        ...server,
        scopeType: normalizedScopeType,
        scopeId:
          normalizedScopeType === "local-user"
            ? normalizeScopeId(server.scopeId)
            : MVP_LOCAL_SINGLE_USER_SCOPE.scopeId,
      } as McpServerRecord;
    });

  return {
    schemaVersion,
    servers,
  };
};

export const assertSecretsFileShape = (value: unknown): McpSecretsFile => {
  const record = asRecord(value);
  if (!record) {
    throw new HttpError(500, "MCP_SECRETS_INVALID", "MCP secrets file is invalid.");
  }

  const schemaVersion =
    typeof record.schemaVersion === "number"
      ? Math.round(record.schemaVersion)
      : Number.NaN;
  if (!Number.isFinite(schemaVersion)) {
    throw new HttpError(500, "MCP_SECRETS_INVALID", "MCP secrets schemaVersion is invalid.");
  }

  if (schemaVersion !== MCP_SECRETS_SCHEMA_VERSION) {
    throw new HttpError(
      500,
      "MCP_SECRETS_SCHEMA_UNSUPPORTED",
      `Unsupported MCP secrets schema version ${schemaVersion}.`,
    );
  }

  const secretsRecord = asRecord(record.secretsByServerId);
  if (!secretsRecord) {
    throw new HttpError(500, "MCP_SECRETS_INVALID", "MCP secretsByServerId must be an object.");
  }

  const secretsByServerId: Record<string, McpServerSecrets> = {};
  for (const [serverId, secretValue] of Object.entries(secretsRecord)) {
    if (!SERVER_ID_PATTERN.test(serverId)) {
      continue;
    }

    const secretRecord = asRecord(secretValue);
    if (!secretRecord) {
      continue;
    }

    secretsByServerId[serverId] = {
      bearerToken: validateSecret(secretRecord.bearerToken, "secretsByServerId.bearerToken"),
      basicPassword: validateSecret(secretRecord.basicPassword, "secretsByServerId.basicPassword"),
      headerValue: validateSecret(secretRecord.headerValue, "secretsByServerId.headerValue"),
    };
  }

  return {
    schemaVersion,
    secretsByServerId,
  };
};
