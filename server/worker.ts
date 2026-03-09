import { readFeatureFlags } from "../config/featureFlags.ts";
import type { WriterProviderId } from "../config/providerContracts.ts";
import {
  AiTelemetryStore,
  estimateTokens,
} from "./ai/telemetryStore.ts";
import {
  buildProviderCatalog,
  buildTranscriptionRegistry,
  buildWriterRegistry,
  readProviderHint,
  readRequestedWriterProvider,
  requireWriterProvider,
  type AiRuntimeConfig,
  type WriterRegistryEntry,
} from "./ai/providerRegistry.ts";
import type { ContextSourceInput, WorkItemInput } from "./ai/types.ts";
import { HttpError, toHttpError } from "./http/errors.ts";

interface AssetBinding {
  fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface CloudflareEnv {
  ASSETS: AssetBinding;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENABLE_OPENAI_WRITER?: string;
  ENABLE_ANTHROPIC_WRITER?: string;
  ENABLE_MCP_CONTEXT?: string;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type ContextPolicyMode = "auto-smart" | "manual-enrich";

interface ContextPolicyConfig {
  mode: ContextPolicyMode;
  globalTokenBudget: number;
  perServerTokenBudget: number;
  maxSnippetCount: number;
  maxSnippetChars: number;
  cacheTtlMs: number;
}

interface ContextRetrievalTrace {
  policy: ContextPolicyConfig;
  stage1: {
    needsExternalContext: boolean;
    reason: string;
    query: string;
    queryHash: string;
    keywordCount: number;
  };
  budgets: {
    globalTokenBudget: number;
    perServerTokenBudget: number;
    maxSnippetCount: number;
    maxSnippetChars: number;
    usedGlobalTokens: number;
    usedSnippetCount: number;
    perServerUsageTokens: Record<string, number>;
  };
  cache: {
    hits: number;
    misses: number;
    size: number;
  };
  servers: Array<{
    serverId: string;
    serverName: string;
    reachable: boolean;
    fromCache: boolean;
    latencyMs: number;
    snippetCount: number;
    errorCode?: string;
  }>;
}

interface AnalysisConfidence {
  score: number;
  threshold: number;
  isLowConfidence: boolean;
  reasons: string[];
}

interface ApiEnvelopeSuccess<T> {
  ok: true;
  data: T;
  requestId: string;
  timestamp: string;
}

interface ApiEnvelopeError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}

const DEFAULT_AUTO_POLICY: ContextPolicyConfig = Object.freeze({
  mode: "auto-smart",
  globalTokenBudget: 900,
  perServerTokenBudget: 300,
  maxSnippetCount: 5,
  maxSnippetChars: 900,
  cacheTtlMs: 90_000,
});

const DEFAULT_MANUAL_POLICY: ContextPolicyConfig = Object.freeze({
  mode: "manual-enrich",
  globalTokenBudget: 1_800,
  perServerTokenBudget: 700,
  maxSnippetCount: 10,
  maxSnippetChars: 1_600,
  cacheTtlMs: 180_000,
});

const CONFIDENCE_THRESHOLD = 0.58;
const workerStartedAt = Date.now();
const telemetryStore = new AiTelemetryStore();

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.round(parsed);
  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
};

const sanitizeContextPolicy = (input: unknown): ContextPolicyConfig => {
  const record = asRecord(input) || {};
  const mode = record.mode === "manual-enrich" ? "manual-enrich" : "auto-smart";
  const defaults = mode === "manual-enrich" ? DEFAULT_MANUAL_POLICY : DEFAULT_AUTO_POLICY;

  return {
    mode,
    globalTokenBudget: clampInteger(record.globalTokenBudget, defaults.globalTokenBudget, 200, 6_000),
    perServerTokenBudget: clampInteger(record.perServerTokenBudget, defaults.perServerTokenBudget, 120, 3_000),
    maxSnippetCount: clampInteger(record.maxSnippetCount, defaults.maxSnippetCount, 1, 20),
    maxSnippetChars: clampInteger(record.maxSnippetChars, defaults.maxSnippetChars, 80, 8_000),
    cacheTtlMs: clampInteger(record.cacheTtlMs, defaults.cacheTtlMs, 10_000, 600_000),
  };
};

const hashQuery = (value: string): string => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return `cf_${Math.abs(hash).toString(16)}`;
};

const buildDisabledRetrievalTrace = (
  transcript: string,
  policyInput: unknown,
): ContextRetrievalTrace => {
  const policy = sanitizeContextPolicy(policyInput);
  const query = transcript.trim().slice(0, 1_400);

  return {
    policy,
    stage1: {
      needsExternalContext: false,
      reason: "MCP context is unavailable in the Cloudflare Worker deployment.",
      query,
      queryHash: hashQuery(query),
      keywordCount: 0,
    },
    budgets: {
      globalTokenBudget: policy.globalTokenBudget,
      perServerTokenBudget: policy.perServerTokenBudget,
      maxSnippetCount: policy.maxSnippetCount,
      maxSnippetChars: policy.maxSnippetChars,
      usedGlobalTokens: 0,
      usedSnippetCount: 0,
      perServerUsageTokens: {},
    },
    cache: {
      hits: 0,
      misses: 0,
      size: 0,
    },
    servers: [],
  };
};

const assessAnalysisConfidence = (
  toolCalls: unknown[],
  transcript: string,
): AnalysisConfidence => {
  const count = Array.isArray(toolCalls) ? toolCalls.length : 0;
  const reasons: string[] = [];
  let score = 0.25;

  if (count === 0) {
    reasons.push("No tool calls were produced.");
    score -= 0.15;
  } else {
    reasons.push(`${count} tool call${count === 1 ? "" : "s"} were produced.`);
    score += Math.min(0.45, count * 0.12);
  }

  if (transcript.trim().length < 80) {
    reasons.push("Transcript segment was short.");
    score -= 0.1;
  } else {
    reasons.push("Transcript segment had enough context.");
    score += 0.1;
  }

  const boundedScore = Number(Math.min(0.98, Math.max(0.05, score)).toFixed(3));
  return {
    score: boundedScore,
    threshold: CONFIDENCE_THRESHOLD,
    isLowConfidence: boundedScore < CONFIDENCE_THRESHOLD,
    reasons,
  };
};

const attachToolCallMetadata = (
  toolCalls: unknown[],
  trace: ContextRetrievalTrace,
  confidence: AnalysisConfidence,
): unknown[] =>
  toolCalls.map((call) => {
    if (!call || typeof call !== "object") {
      return call;
    }

    return {
      ...(call as Record<string, unknown>),
      metadata: {
        citations: [],
        retrieval: trace,
        confidence,
      },
    };
  });

const readErrorCode = (error: unknown): string => {
  if (error instanceof HttpError) {
    return error.code;
  }

  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return String((error as { code: string }).code);
  }

  return "UNEXPECTED_ERROR";
};

const createRuntimeConfig = (env: CloudflareEnv): AiRuntimeConfig => {
  const featureFlags = readFeatureFlags(env as Record<string, string | undefined>);

  return {
    providers: {
      geminiApiKey: env.GEMINI_API_KEY?.trim() || "",
      openaiApiKey: env.OPENAI_API_KEY?.trim() || "",
      anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || "",
    },
    featureFlags: {
      ...featureFlags,
      ENABLE_MCP_CONTEXT: false,
    },
  };
};

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

const sendSuccess = <T>(requestId: string, data: T, status = 200): Response =>
  Response.json(
    {
      ok: true,
      data,
      requestId,
      timestamp: new Date().toISOString(),
    } satisfies ApiEnvelopeSuccess<T>,
    {
      status,
      headers: responseHeaders,
    },
  );

const sendError = (requestId: string, error: HttpError): Response =>
  Response.json(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
      requestId,
      timestamp: new Date().toISOString(),
    } satisfies ApiEnvelopeError,
    {
      status: error.status,
      headers: responseHeaders,
    },
  );

const readJsonBody = async (request: Request): Promise<unknown> => {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
};

const hasFileExtension = (pathname: string): boolean =>
  pathname.split("/").pop()?.includes(".") === true;

const isSpaNavigationRequest = (request: Request, pathname: string): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  if (pathname.startsWith("/api/")) {
    return false;
  }

  if (hasFileExtension(pathname)) {
    return false;
  }

  return (request.headers.get("accept") || "").includes("text/html");
};

const fetchStaticAsset = async (request: Request, env: CloudflareEnv): Promise<Response> => {
  const initial = await env.ASSETS.fetch(request);
  if (initial.status !== 404) {
    return initial;
  }

  const url = new URL(request.url);
  if (!isSpaNavigationRequest(request, url.pathname)) {
    return initial;
  }

  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  indexUrl.search = "";
  return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
};

const handleSummarize = async (
  requestId: string,
  body: unknown,
  writerRegistry: Record<WriterProviderId, WriterRegistryEntry>,
): Promise<Response> => {
  const startedAt = Date.now();
  const providerHint = readProviderHint(body);
  const record = asRecord(body) || {};
  const transcript = typeof record.transcript === "string" ? record.transcript.trim() : "";
  let providerLabel = providerHint;

  try {
    if (!transcript) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
    }

    const providerId = readRequestedWriterProvider(body);
    const provider = requireWriterProvider(writerRegistry, providerId);
    providerLabel = provider.id;
    const summary = await provider.summarizeTranscript(transcript, record.providerConfig);
    telemetryStore.record({
      provider: provider.id,
      operation: "summarize",
      success: true,
      durationMs: Date.now() - startedAt,
      inputTokens: estimateTokens(transcript),
      outputTokens: estimateTokens(summary),
      retrievalTokens: 0,
    });
    return sendSuccess(requestId, { provider: provider.id, summary });
  } catch (error) {
    telemetryStore.record({
      provider: providerLabel,
      operation: "summarize",
      success: false,
      durationMs: Date.now() - startedAt,
      inputTokens: estimateTokens(transcript),
      outputTokens: 0,
      retrievalTokens: 0,
      errorCode: readErrorCode(error),
    });
    throw error;
  }
};

const handleAnalyze = async (
  requestId: string,
  body: unknown,
  writerRegistry: Record<WriterProviderId, WriterRegistryEntry>,
): Promise<Response> => {
  const startedAt = Date.now();
  const providerHint = readProviderHint(body);
  const record = asRecord(body) || {};
  const transcript = typeof record.transcript === "string" ? record.transcript : "";
  const projectContext = typeof record.projectContext === "string" ? record.projectContext : "";
  const contextSources = Array.isArray(record.contextSources)
    ? (record.contextSources as ContextSourceInput[])
    : [];
  const contextPolicyInput =
    record.contextPolicy && typeof record.contextPolicy === "object"
      ? record.contextPolicy
      : undefined;
  let providerLabel = providerHint;
  const retrievalTrace = buildDisabledRetrievalTrace(transcript, contextPolicyInput);

  try {
    if (!transcript.trim()) {
      throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
    }

    const providerId = readRequestedWriterProvider(body);
    const provider = requireWriterProvider(writerRegistry, providerId);
    providerLabel = provider.id;
    const rawToolCalls = await provider.analyzeMeetingTranscript(
      transcript,
      projectContext,
      contextSources,
      record.providerConfig,
    );
    const confidence = assessAnalysisConfidence(rawToolCalls, transcript);
    const toolCalls = attachToolCallMetadata(rawToolCalls, retrievalTrace, confidence);

    telemetryStore.record({
      provider: provider.id,
      operation: "analyze",
      success: true,
      durationMs: Date.now() - startedAt,
      inputTokens:
        estimateTokens(transcript) +
        estimateTokens(projectContext) +
        estimateTokens(
          contextSources.map((source) => ({
            name: source.name,
            type: source.type,
            mimeType: source.mimeType,
            contentLength: typeof source.content === "string" ? source.content.length : 0,
          })),
        ),
      outputTokens: estimateTokens(toolCalls),
      retrievalTokens: 0,
      contextMode: retrievalTrace.policy.mode,
      serverUsage: [],
    });

    return sendSuccess(requestId, { provider: provider.id, toolCalls });
  } catch (error) {
    telemetryStore.record({
      provider: providerLabel,
      operation: "analyze",
      success: false,
      durationMs: Date.now() - startedAt,
      inputTokens:
        estimateTokens(transcript) +
        estimateTokens(projectContext) +
        estimateTokens(
          contextSources.map((source) => ({
            name: source.name,
            type: source.type,
            mimeType: source.mimeType,
            contentLength: typeof source.content === "string" ? source.content.length : 0,
          })),
        ),
      outputTokens: 0,
      retrievalTokens: 0,
      contextMode: retrievalTrace.policy.mode,
      serverUsage: [],
      errorCode: readErrorCode(error),
    });
    throw error;
  }
};

const handleRefine = async (
  requestId: string,
  body: unknown,
  writerRegistry: Record<WriterProviderId, WriterRegistryEntry>,
): Promise<Response> => {
  const startedAt = Date.now();
  const providerHint = readProviderHint(body);
  const record = asRecord(body) || {};
  const rawTranscript =
    typeof record.rawTranscript === "string" ? record.rawTranscript.trim() : "";
  const fieldName = typeof record.fieldName === "string" ? record.fieldName.trim() : "";
  const currentItem =
    record.currentItem && typeof record.currentItem === "object"
      ? (record.currentItem as WorkItemInput)
      : null;
  const projectContext = typeof record.projectContext === "string" ? record.projectContext : "";
  let providerLabel = providerHint;

  try {
    if (!rawTranscript || !fieldName || !currentItem) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Fields \"rawTranscript\", \"fieldName\", and \"currentItem\" are required.",
      );
    }

    const providerId = readRequestedWriterProvider(body);
    const provider = requireWriterProvider(writerRegistry, providerId);
    providerLabel = provider.id;
    const refinedText = await provider.refineFieldContent(
      rawTranscript,
      fieldName,
      currentItem,
      projectContext,
      record.providerConfig,
    );

    telemetryStore.record({
      provider: provider.id,
      operation: "refine",
      success: true,
      durationMs: Date.now() - startedAt,
      inputTokens:
        estimateTokens(rawTranscript) +
        estimateTokens(fieldName) +
        estimateTokens(currentItem) +
        estimateTokens(projectContext),
      outputTokens: estimateTokens(refinedText),
      retrievalTokens: 0,
    });

    return sendSuccess(requestId, { provider: provider.id, refinedText });
  } catch (error) {
    telemetryStore.record({
      provider: providerLabel,
      operation: "refine",
      success: false,
      durationMs: Date.now() - startedAt,
      inputTokens:
        estimateTokens(rawTranscript) +
        estimateTokens(fieldName) +
        estimateTokens(currentItem) +
        estimateTokens(projectContext),
      outputTokens: 0,
      retrievalTokens: 0,
      errorCode: readErrorCode(error),
    });
    throw error;
  }
};

const handleApiRequest = async (request: Request, env: CloudflareEnv): Promise<Response> => {
  const url = new URL(request.url);
  const requestId = crypto.randomUUID();
  const runtimeConfig = createRuntimeConfig(env);
  const writerRegistry = buildWriterRegistry(runtimeConfig);
  const transcriptionRegistry = buildTranscriptionRegistry();

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendSuccess(requestId, {
        status: "ok",
        api: {
          runtime: "cloudflare-worker",
          bindMode: "edge",
        },
        providers: {
          geminiConfigured: Boolean(runtimeConfig.providers.geminiApiKey),
          openaiConfigured: Boolean(runtimeConfig.providers.openaiApiKey),
          anthropicConfigured: Boolean(runtimeConfig.providers.anthropicApiKey),
        },
        featureFlags: runtimeConfig.featureFlags,
        uptimeSeconds: Math.round((Date.now() - workerStartedAt) / 1_000),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/ai/providers") {
      return sendSuccess(
        requestId,
        buildProviderCatalog(writerRegistry, transcriptionRegistry),
      );
    }

    if (request.method === "GET" && url.pathname === "/api/ai/telemetry") {
      return sendSuccess(requestId, telemetryStore.getSnapshot());
    }

    if (url.pathname.startsWith("/api/mcp")) {
      throw new HttpError(
        501,
        "MCP_UNAVAILABLE",
        "MCP routes are not available in the Cloudflare Worker deployment.",
        {
          reason: "Phase 1 Cloudflare support excludes filesystem-backed and command-based MCP features.",
        },
      );
    }

    if (request.method === "POST" && url.pathname === "/api/ai/summarize") {
      return handleSummarize(requestId, await readJsonBody(request), writerRegistry);
    }

    if (request.method === "POST" && url.pathname === "/api/ai/analyze") {
      return handleAnalyze(requestId, await readJsonBody(request), writerRegistry);
    }

    if (request.method === "POST" && url.pathname === "/api/ai/refine") {
      return handleRefine(requestId, await readJsonBody(request), writerRegistry);
    }

    if (request.method === "POST" && url.pathname === "/api/ai/gemini/summarize") {
      const body = asRecord(await readJsonBody(request)) || {};
      return handleSummarize(requestId, { ...body, provider: "gemini" }, writerRegistry);
    }

    if (request.method === "POST" && url.pathname === "/api/ai/gemini/analyze") {
      const body = asRecord(await readJsonBody(request)) || {};
      return handleAnalyze(requestId, { ...body, provider: "gemini" }, writerRegistry);
    }

    if (request.method === "POST" && url.pathname === "/api/ai/gemini/refine") {
      const body = asRecord(await readJsonBody(request)) || {};
      return handleRefine(requestId, { ...body, provider: "gemini" }, writerRegistry);
    }

    throw new HttpError(404, "NOT_FOUND", "API route not found.", {
      method: request.method,
      path: url.pathname,
    });
  } catch (error) {
    const normalized = toHttpError(error);
    if (normalized.status >= 500) {
      console.error(
        `[worker:error] requestId=${requestId} method=${request.method} path=${url.pathname} code=${normalized.code} message=${normalized.message}`,
      );
    }

    return sendError(requestId, normalized);
  }
};

export default {
  async fetch(
    request: Request,
    env: CloudflareEnv,
    _ctx: WorkerExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env);
    }

    return fetchStaticAsset(request, env);
  },
};
