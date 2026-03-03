import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { FeatureFlags } from "../../config/featureFlags.ts";
import {
  DEFAULT_PROVIDER_SELECTION,
  PROVIDER_CAPABILITY_MATRIX,
  isWriterProviderId,
  type TranscriptionProviderId,
  type WriterProviderId,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import { sendSuccess } from "../http/envelope.ts";
import { HttpError } from "../http/errors.ts";
import { GeminiWriter } from "./geminiWriter.ts";
import { AnthropicWriter } from "./anthropicWriter.ts";
import { OpenAiWriter } from "./openAiWriter.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";
import { McpRegistryStore } from "../mcp/registryStore.ts";
import { McpGateway } from "../mcp/gateway.ts";
import { McpRetrievalCache } from "../mcp/retrievalCache.ts";
import {
  ContextRetrievalStrategy,
  assessAnalysisConfidence,
  attachToolCallContextMetadata,
  type ContextPolicyInput,
  type ContextRetrievalTrace,
} from "./contextRetrievalStrategy.ts";
import {
  AiTelemetryStore,
  estimateTokens,
  type AiServerUsageEvent,
} from "./telemetryStore.ts";

export interface AiRuntimeConfig {
  providers: {
    geminiApiKey: string;
    openaiApiKey: string;
    anthropicApiKey: string;
  };
  featureFlags: FeatureFlags;
}

interface WriterRegistryEntry {
  id: WriterProviderId;
  adapter: WriterProvider<ContextSourceInput, WorkItemInput, any> | null;
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  requiredEnv: string;
}

interface TranscriptionRegistryEntry {
  id: TranscriptionProviderId;
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  unavailableReason?: string;
  requiredEnv: string | null;
}

const buildWriterRegistry = (
  runtimeConfig: AiRuntimeConfig,
): Record<WriterProviderId, WriterRegistryEntry> => ({
  gemini: {
    id: "gemini",
    adapter: runtimeConfig.providers.geminiApiKey
      ? new GeminiWriter(runtimeConfig.providers.geminiApiKey)
      : null,
    enabled: true,
    configured: Boolean(runtimeConfig.providers.geminiApiKey),
    implemented: true,
    requiredEnv: "GEMINI_API_KEY",
  },
  openai: {
    id: "openai",
    adapter: runtimeConfig.providers.openaiApiKey
      ? new OpenAiWriter(runtimeConfig.providers.openaiApiKey)
      : null,
    enabled: runtimeConfig.featureFlags.ENABLE_OPENAI_WRITER,
    configured: Boolean(runtimeConfig.providers.openaiApiKey),
    implemented: true,
    requiredEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    id: "anthropic",
    adapter: runtimeConfig.providers.anthropicApiKey
      ? new AnthropicWriter(runtimeConfig.providers.anthropicApiKey)
      : null,
    enabled: runtimeConfig.featureFlags.ENABLE_ANTHROPIC_WRITER,
    configured: Boolean(runtimeConfig.providers.anthropicApiKey),
    implemented: true,
    requiredEnv: "ANTHROPIC_API_KEY",
  },
});

const buildTranscriptionRegistry = (): Record<
  TranscriptionProviderId,
  TranscriptionRegistryEntry
> => ({
  gemini: {
    id: "gemini",
    enabled: true,
    configured: true,
    implemented: true,
    requiredEnv: null,
  },
});

const getWriterProviderStatus = (entry: WriterRegistryEntry) => ({
  id: entry.id,
  enabled: entry.enabled,
  configured: entry.configured,
  implemented: entry.implemented,
  available: entry.enabled && entry.configured && entry.implemented && Boolean(entry.adapter),
  capabilities: PROVIDER_CAPABILITY_MATRIX[entry.id],
});

const getTranscriptionProviderStatus = (entry: TranscriptionRegistryEntry) => {
  const available = entry.enabled && entry.configured && entry.implemented;
  let unavailableReason: string | undefined;

  if (!available) {
    if (!entry.enabled) {
      unavailableReason = `Provider "${entry.id}" is disabled by feature flag.`;
    } else if (!entry.configured && entry.requiredEnv) {
      unavailableReason = `Provider "${entry.id}" key is not configured on the server. Missing ${entry.requiredEnv}.`;
    } else if (!entry.implemented) {
      unavailableReason =
        entry.unavailableReason ||
        `Provider "${entry.id}" transcription adapter is not implemented yet.`;
    } else {
      unavailableReason = `Provider "${entry.id}" is unavailable in this runtime.`;
    }
  }

  return {
    id: entry.id,
    enabled: entry.enabled,
    configured: entry.configured,
    implemented: entry.implemented,
    available,
    ...(unavailableReason ? { unavailableReason } : {}),
    capabilities: PROVIDER_CAPABILITY_MATRIX[entry.id],
  };
};

const readRequestedWriterProvider = (request: Request): WriterProviderId => {
  const candidate = request.body?.provider;
  if (candidate === undefined || candidate === null || candidate === "") {
    return DEFAULT_PROVIDER_SELECTION.writer;
  }

  if (!isWriterProviderId(candidate)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field \"provider\" is invalid.", {
      validProviders: Object.keys(PROVIDER_CAPABILITY_MATRIX),
      receivedProvider: candidate,
    });
  }

  return candidate;
};

const requireWriterProvider = (
  registry: Record<WriterProviderId, WriterRegistryEntry>,
  providerId: WriterProviderId,
): WriterProvider<ContextSourceInput, WorkItemInput, any> => {
  const entry = registry[providerId];

  if (!entry.enabled) {
    throw new HttpError(403, "FEATURE_DISABLED", `Provider "${providerId}" is disabled by feature flag.`, {
      provider: providerId,
      requiredFlag:
        providerId === "openai"
          ? "ENABLE_OPENAI_WRITER"
          : providerId === "anthropic"
            ? "ENABLE_ANTHROPIC_WRITER"
            : null,
    });
  }

  if (!entry.implemented) {
    throw new HttpError(501, "PROVIDER_NOT_IMPLEMENTED", `Provider "${providerId}" adapter is not implemented yet.`, {
      provider: providerId,
    });
  }

  if (!entry.configured || !entry.adapter) {
    throw new HttpError(503, "PROVIDER_NOT_CONFIGURED", `Provider "${providerId}" key is not configured on the server.`, {
      provider: providerId,
      missingEnv: entry.requiredEnv,
    });
  }

  return entry.adapter;
};

type RouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

const withProviderOverride =
  (providerId: WriterProviderId, handler: RouteHandler): RouteHandler =>
  async (req, res, next) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    req.body = { ...body, provider: providerId };
    return handler(req, res, next);
  };

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

const toServerUsage = (trace: ContextRetrievalTrace): AiServerUsageEvent[] => {
  const perServerUsageTokens = trace.budgets.perServerUsageTokens || {};
  return trace.servers.map((server) => ({
    serverId: server.serverId,
    serverName: server.serverName,
    tokens: perServerUsageTokens[server.serverId] || 0,
    reachable: server.reachable,
    fromCache: server.fromCache,
    latencyMs: server.latencyMs,
    ...(server.errorCode ? { errorCode: server.errorCode } : {}),
  }));
};

export const createAiRouter = (runtimeConfig: AiRuntimeConfig): Router => {
  const router = Router();
  const writerRegistry = buildWriterRegistry(runtimeConfig);
  const transcriptionRegistry = buildTranscriptionRegistry();
  const mcpRegistryStore = new McpRegistryStore();
  const mcpGateway = new McpGateway({ registryStore: mcpRegistryStore });
  const mcpRetrievalCache = new McpRetrievalCache();
  const contextRetrieval = new ContextRetrievalStrategy({
    featureEnabled: runtimeConfig.featureFlags.ENABLE_MCP_CONTEXT,
    registryStore: mcpRegistryStore,
    gateway: mcpGateway,
    cache: mcpRetrievalCache,
  });
  const telemetryStore = new AiTelemetryStore();

  const summarizeHandler: RouteHandler = async (req, res, next) => {
    const startedAt = Date.now();
    const providerHint =
      typeof req.body?.provider === "string" && req.body.provider.trim().length > 0
        ? req.body.provider.trim()
        : DEFAULT_PROVIDER_SELECTION.writer;
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
    let providerLabel = providerHint;

    try {
      if (!transcript) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      providerLabel = provider.id;
      const summary = await provider.summarizeTranscript(transcript, req.body?.providerConfig);
      telemetryStore.record({
        provider: provider.id,
        operation: "summarize",
        success: true,
        durationMs: Date.now() - startedAt,
        inputTokens: estimateTokens(transcript),
        outputTokens: estimateTokens(summary),
        retrievalTokens: 0,
      });
      sendSuccess(res, { provider: provider.id, summary });
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
      next(error);
    }
  };

  const analyzeHandler: RouteHandler = async (req, res, next) => {
    const startedAt = Date.now();
    const providerHint =
      typeof req.body?.provider === "string" && req.body.provider.trim().length > 0
        ? req.body.provider.trim()
        : DEFAULT_PROVIDER_SELECTION.writer;
    const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : "";
    const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";
    const contextSources = Array.isArray(req.body?.contextSources)
      ? (req.body.contextSources as ContextSourceInput[])
      : [];
    const contextPolicyInput =
      req.body?.contextPolicy && typeof req.body.contextPolicy === "object"
        ? (req.body.contextPolicy as ContextPolicyInput)
        : undefined;
    let providerLabel = providerHint;
    let selectedTrace: ContextRetrievalTrace | null = null;

    try {
      if (!transcript.trim()) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      providerLabel = provider.id;
      const firstRetrieval = await contextRetrieval.prepare(
        transcript,
        projectContext,
        contextPolicyInput,
      );
      selectedTrace = firstRetrieval.trace;
      const firstPassContext = [...contextSources, ...firstRetrieval.retrievedSources];
      const firstToolCalls = await provider.analyzeMeetingTranscript(
        transcript,
        projectContext,
        firstPassContext,
        req.body?.providerConfig,
      );
      const firstConfidence = assessAnalysisConfidence(firstToolCalls, transcript);
      let confidence = firstConfidence;
      let selectedToolCalls = firstToolCalls;
      let selectedRetrieval = firstRetrieval;
      let escalationAttempted = false;
      let escalationUsed = false;

      const shouldEscalate =
        runtimeConfig.featureFlags.ENABLE_MCP_CONTEXT &&
        firstRetrieval.trace.policy.mode === "auto-smart" &&
        confidence.isLowConfidence;

      if (shouldEscalate) {
        escalationAttempted = true;
        const expandedPolicy = {
          ...(contextPolicyInput || {}),
          mode: "manual-enrich" as const,
          globalTokenBudget: Math.min(6_000, firstRetrieval.trace.policy.globalTokenBudget * 2),
          perServerTokenBudget: Math.min(3_000, firstRetrieval.trace.policy.perServerTokenBudget * 2),
          maxSnippetCount: Math.min(20, firstRetrieval.trace.policy.maxSnippetCount + 4),
          maxSnippetChars: Math.min(8_000, firstRetrieval.trace.policy.maxSnippetChars + 800),
        };
        const secondRetrieval = await contextRetrieval.prepare(
          transcript,
          projectContext,
          expandedPolicy,
        );
        const secondPassContext = [...contextSources, ...secondRetrieval.retrievedSources];
        const secondToolCalls = await provider.analyzeMeetingTranscript(
          transcript,
          projectContext,
          secondPassContext,
          req.body?.providerConfig,
        );
        const secondConfidence = assessAnalysisConfidence(secondToolCalls, transcript);

        if (
          secondConfidence.score > confidence.score ||
          (selectedToolCalls.length === 0 && secondToolCalls.length > 0)
        ) {
          escalationUsed = true;
          selectedToolCalls = secondToolCalls;
          selectedRetrieval = secondRetrieval;
          confidence = secondConfidence;
        }
      }

      const retrievalTrace = {
        ...selectedRetrieval.trace,
        escalation: {
          attempted: escalationAttempted,
          used: escalationUsed,
          baseConfidence: Number(firstConfidence.score.toFixed(3)),
          finalConfidence: Number(confidence.score.toFixed(3)),
        },
      };
      selectedTrace = retrievalTrace;
      const toolCalls = attachToolCallContextMetadata(
        selectedToolCalls,
        selectedRetrieval.citations,
        retrievalTrace,
        confidence,
      );
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
        retrievalTokens: retrievalTrace.budgets.usedGlobalTokens,
        contextMode: retrievalTrace.policy.mode,
        serverUsage: toServerUsage(retrievalTrace),
      });
      sendSuccess(res, { provider: provider.id, toolCalls });
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
        retrievalTokens: selectedTrace?.budgets.usedGlobalTokens || 0,
        contextMode: selectedTrace?.policy.mode,
        serverUsage: selectedTrace ? toServerUsage(selectedTrace) : [],
        errorCode: readErrorCode(error),
      });
      next(error);
    }
  };

  const refineHandler: RouteHandler = async (req, res, next) => {
    const startedAt = Date.now();
    const providerHint =
      typeof req.body?.provider === "string" && req.body.provider.trim().length > 0
        ? req.body.provider.trim()
        : DEFAULT_PROVIDER_SELECTION.writer;
    const rawTranscript =
      typeof req.body?.rawTranscript === "string" ? req.body.rawTranscript.trim() : "";
    const fieldName = typeof req.body?.fieldName === "string" ? req.body.fieldName.trim() : "";
    const currentItem =
      req.body?.currentItem && typeof req.body.currentItem === "object"
        ? (req.body.currentItem as WorkItemInput)
        : null;
    const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";
    let providerLabel = providerHint;

    try {
      if (!rawTranscript || !fieldName || !currentItem) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Fields \"rawTranscript\", \"fieldName\", and \"currentItem\" are required.",
        );
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      providerLabel = provider.id;
      const refinedText = await provider.refineFieldContent(
        rawTranscript,
        fieldName,
        currentItem,
        projectContext,
        req.body?.providerConfig,
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
      sendSuccess(res, { provider: provider.id, refinedText });
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
      next(error);
    }
  };

  router.get("/providers", (_req, res) => {
    sendSuccess(res, {
      defaults: DEFAULT_PROVIDER_SELECTION,
      capabilities: PROVIDER_CAPABILITY_MATRIX,
      writers: Object.values(writerRegistry).map(getWriterProviderStatus),
      transcriptions: Object.values(transcriptionRegistry).map(
        getTranscriptionProviderStatus,
      ),
    });
  });

  router.post("/summarize", summarizeHandler);
  router.post("/analyze", analyzeHandler);
  router.post("/refine", refineHandler);
  router.get("/telemetry", (_req, res) => {
    sendSuccess(res, telemetryStore.getSnapshot());
  });

  // Backward-compatible aliases to preserve existing client calls while migration completes.
  router.post("/gemini/summarize", withProviderOverride("gemini", summarizeHandler));
  router.post("/gemini/analyze", withProviderOverride("gemini", analyzeHandler));
  router.post("/gemini/refine", withProviderOverride("gemini", refineHandler));

  return router;
};
