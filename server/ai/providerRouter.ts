import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { FeatureFlags } from "../../config/featureFlags.ts";
import {
  DEFAULT_PROVIDER_SELECTION,
  PROVIDER_CAPABILITY_MATRIX,
  isWriterProviderId,
  type WriterProviderId,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import { sendSuccess } from "../http/envelope.ts";
import { HttpError } from "../http/errors.ts";
import { GeminiWriter, type ContextSourceInput } from "./geminiWriter.ts";

interface WorkItemInput {
  type: string;
  title: string;
  description: string;
}

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
    adapter: null,
    enabled: runtimeConfig.featureFlags.ENABLE_OPENAI_WRITER,
    configured: Boolean(runtimeConfig.providers.openaiApiKey),
    implemented: false,
    requiredEnv: "OPENAI_API_KEY",
  },
  anthropic: {
    id: "anthropic",
    adapter: null,
    enabled: runtimeConfig.featureFlags.ENABLE_ANTHROPIC_WRITER,
    configured: Boolean(runtimeConfig.providers.anthropicApiKey),
    implemented: false,
    requiredEnv: "ANTHROPIC_API_KEY",
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

export const createAiRouter = (runtimeConfig: AiRuntimeConfig): Router => {
  const router = Router();
  const writerRegistry = buildWriterRegistry(runtimeConfig);

  const summarizeHandler: RouteHandler = async (req, res, next) => {
    try {
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript.trim() : "";
      if (!transcript) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      const summary = await provider.summarizeTranscript(transcript);
      sendSuccess(res, { provider: provider.id, summary });
    } catch (error) {
      next(error);
    }
  };

  const analyzeHandler: RouteHandler = async (req, res, next) => {
    try {
      const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : "";
      const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";
      const contextSources = Array.isArray(req.body?.contextSources)
        ? (req.body.contextSources as ContextSourceInput[])
        : [];

      if (!transcript.trim()) {
        throw new HttpError(400, "INVALID_REQUEST", "Field \"transcript\" is required.");
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      const toolCalls = await provider.analyzeMeetingTranscript(transcript, projectContext, contextSources);
      sendSuccess(res, { provider: provider.id, toolCalls });
    } catch (error) {
      next(error);
    }
  };

  const refineHandler: RouteHandler = async (req, res, next) => {
    try {
      const rawTranscript =
        typeof req.body?.rawTranscript === "string" ? req.body.rawTranscript.trim() : "";
      const fieldName = typeof req.body?.fieldName === "string" ? req.body.fieldName.trim() : "";
      const currentItem =
        req.body?.currentItem && typeof req.body.currentItem === "object"
          ? (req.body.currentItem as WorkItemInput)
          : null;
      const projectContext = typeof req.body?.projectContext === "string" ? req.body.projectContext : "";

      if (!rawTranscript || !fieldName || !currentItem) {
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "Fields \"rawTranscript\", \"fieldName\", and \"currentItem\" are required.",
        );
      }

      const providerId = readRequestedWriterProvider(req);
      const provider = requireWriterProvider(writerRegistry, providerId);
      const refinedText = await provider.refineFieldContent(
        rawTranscript,
        fieldName,
        currentItem,
        projectContext,
      );
      sendSuccess(res, { provider: provider.id, refinedText });
    } catch (error) {
      next(error);
    }
  };

  router.get("/providers", (_req, res) => {
    sendSuccess(res, {
      defaults: DEFAULT_PROVIDER_SELECTION,
      capabilities: PROVIDER_CAPABILITY_MATRIX,
      writers: Object.values(writerRegistry).map(getWriterProviderStatus),
    });
  });

  router.post("/summarize", summarizeHandler);
  router.post("/analyze", analyzeHandler);
  router.post("/refine", refineHandler);

  // Backward-compatible aliases to preserve existing client calls while migration completes.
  router.post("/gemini/summarize", withProviderOverride("gemini", summarizeHandler));
  router.post("/gemini/analyze", withProviderOverride("gemini", analyzeHandler));
  router.post("/gemini/refine", withProviderOverride("gemini", refineHandler));

  return router;
};
