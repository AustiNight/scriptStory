import type { FeatureFlags } from "../../config/featureFlags.ts";
import {
  DEFAULT_PROVIDER_SELECTION,
  PROVIDER_CAPABILITY_MATRIX,
  isWriterProviderId,
  type TranscriptionProviderId,
  type WriterProviderId,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import { HttpError } from "../http/errors.ts";
import { AnthropicWriter } from "./anthropicWriter.ts";
import { GeminiWriter } from "./geminiWriter.ts";
import { OpenAiWriter } from "./openAiWriter.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";

export interface AiRuntimeConfig {
  providers: {
    geminiApiKey: string;
    openaiApiKey: string;
    anthropicApiKey: string;
  };
  featureFlags: FeatureFlags;
}

export interface WriterRegistryEntry {
  id: WriterProviderId;
  adapter: WriterProvider<ContextSourceInput, WorkItemInput, any> | null;
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  requiredEnv: string;
}

export interface TranscriptionRegistryEntry {
  id: TranscriptionProviderId;
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  unavailableReason?: string;
  requiredEnv: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

export const buildWriterRegistry = (
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

export const buildTranscriptionRegistry = (): Record<
  TranscriptionProviderId,
  TranscriptionRegistryEntry
> => ({
  browser: {
    id: "browser",
    enabled: true,
    configured: true,
    implemented: true,
    requiredEnv: null,
  },
});

export const getWriterProviderStatus = (entry: WriterRegistryEntry) => ({
  id: entry.id,
  enabled: entry.enabled,
  configured: entry.configured,
  implemented: entry.implemented,
  available: entry.enabled && entry.configured && entry.implemented && Boolean(entry.adapter),
  capabilities: PROVIDER_CAPABILITY_MATRIX[entry.id],
});

export const getTranscriptionProviderStatus = (entry: TranscriptionRegistryEntry) => {
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

export const buildProviderCatalog = (
  writerRegistry: Record<WriterProviderId, WriterRegistryEntry>,
  transcriptionRegistry: Record<TranscriptionProviderId, TranscriptionRegistryEntry>,
) => ({
  defaults: DEFAULT_PROVIDER_SELECTION,
  capabilities: PROVIDER_CAPABILITY_MATRIX,
  writers: Object.values(writerRegistry).map(getWriterProviderStatus),
  transcriptions: Object.values(transcriptionRegistry).map(getTranscriptionProviderStatus),
});

export const readRequestedWriterProvider = (body: unknown): WriterProviderId => {
  const candidate = asRecord(body)?.provider;
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

export const readProviderHint = (body: unknown): string => {
  const candidate = asRecord(body)?.provider;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : DEFAULT_PROVIDER_SELECTION.writer;
};

export const requireWriterProvider = (
  registry: Record<WriterProviderId, WriterRegistryEntry>,
  providerId: WriterProviderId,
): WriterProvider<ContextSourceInput, WorkItemInput, any> => {
  const entry = registry[providerId];

  if (!entry.enabled) {
    throw new HttpError(
      403,
      "FEATURE_DISABLED",
      `Provider "${providerId}" is disabled by feature flag.`,
      {
        provider: providerId,
        requiredFlag:
          providerId === "openai"
            ? "ENABLE_OPENAI_WRITER"
            : providerId === "anthropic"
              ? "ENABLE_ANTHROPIC_WRITER"
              : null,
      },
    );
  }

  if (!entry.implemented) {
    throw new HttpError(
      501,
      "PROVIDER_NOT_IMPLEMENTED",
      `Provider "${providerId}" adapter is not implemented yet.`,
      {
        provider: providerId,
      },
    );
  }

  if (!entry.configured || !entry.adapter) {
    throw new HttpError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      `Provider "${providerId}" key is not configured on the server.`,
      {
        provider: providerId,
        missingEnv: entry.requiredEnv,
      },
    );
  }

  return entry.adapter;
};
