import type { WriterProviderId } from "./providerContracts.ts";

export interface OpenAIWriterRuntimeConfig {
  summaryModel: string;
  analysisModel: string;
  refineModel: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface AnthropicWriterRuntimeConfig {
  summaryModel: string;
  analysisModel: string;
  refineModel: string;
  fallbackModel: string;
  temperature: number;
  maxOutputTokens: number;
  requestTimeoutMs: number;
  maxRetries: number;
}

export interface WriterProviderRuntimeConfig {
  openai: OpenAIWriterRuntimeConfig;
  anthropic: AnthropicWriterRuntimeConfig;
}

export const DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG: OpenAIWriterRuntimeConfig = Object.freeze({
  summaryModel: "gpt-4.1-mini",
  analysisModel: "gpt-4.1",
  refineModel: "gpt-4.1-mini",
  fallbackModel: "gpt-4.1-mini",
  temperature: 0.2,
  maxOutputTokens: 900,
  requestTimeoutMs: 20_000,
  maxRetries: 2,
});

export const DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG: AnthropicWriterRuntimeConfig =
  Object.freeze({
    summaryModel: "claude-3-5-haiku-latest",
    analysisModel: "claude-3-5-sonnet-latest",
    refineModel: "claude-3-5-haiku-latest",
    fallbackModel: "claude-3-5-haiku-latest",
    temperature: 0.2,
    maxOutputTokens: 900,
    requestTimeoutMs: 20_000,
    maxRetries: 2,
  });

export const DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG: WriterProviderRuntimeConfig = Object.freeze({
  openai: { ...DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG },
  anthropic: { ...DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG },
});

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

const sanitizeModelId = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed || !MODEL_ID_PATTERN.test(trimmed)) {
    return fallback;
  }

  return trimmed;
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  if (parsed < min) {
    return min;
  }

  if (parsed > max) {
    return max;
  }

  return Number(parsed.toFixed(3));
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

export const sanitizeOpenAIWriterRuntimeConfig = (value: unknown): OpenAIWriterRuntimeConfig => {
  const fallback = DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG;
  const record = asRecord(value);

  if (!record) {
    return { ...fallback };
  }

  return {
    summaryModel: sanitizeModelId(record.summaryModel, fallback.summaryModel),
    analysisModel: sanitizeModelId(record.analysisModel, fallback.analysisModel),
    refineModel: sanitizeModelId(record.refineModel, fallback.refineModel),
    fallbackModel: sanitizeModelId(record.fallbackModel, fallback.fallbackModel),
    temperature: clampNumber(record.temperature, fallback.temperature, 0, 2),
    maxOutputTokens: clampInteger(record.maxOutputTokens, fallback.maxOutputTokens, 64, 4096),
    requestTimeoutMs: clampInteger(record.requestTimeoutMs, fallback.requestTimeoutMs, 5_000, 60_000),
    maxRetries: clampInteger(record.maxRetries, fallback.maxRetries, 0, 4),
  };
};

export const sanitizeAnthropicWriterRuntimeConfig = (
  value: unknown,
): AnthropicWriterRuntimeConfig => {
  const fallback = DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG;
  const record = asRecord(value);

  if (!record) {
    return { ...fallback };
  }

  return {
    summaryModel: sanitizeModelId(record.summaryModel, fallback.summaryModel),
    analysisModel: sanitizeModelId(record.analysisModel, fallback.analysisModel),
    refineModel: sanitizeModelId(record.refineModel, fallback.refineModel),
    fallbackModel: sanitizeModelId(record.fallbackModel, fallback.fallbackModel),
    temperature: clampNumber(record.temperature, fallback.temperature, 0, 2),
    maxOutputTokens: clampInteger(record.maxOutputTokens, fallback.maxOutputTokens, 64, 4096),
    requestTimeoutMs: clampInteger(record.requestTimeoutMs, fallback.requestTimeoutMs, 5_000, 60_000),
    maxRetries: clampInteger(record.maxRetries, fallback.maxRetries, 0, 4),
  };
};

export const sanitizeWriterProviderRuntimeConfig = (value: unknown): WriterProviderRuntimeConfig => {
  const record = asRecord(value);
  const openai = record
    ? sanitizeOpenAIWriterRuntimeConfig(record.openai)
    : { ...DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG };
  const anthropic = record
    ? sanitizeAnthropicWriterRuntimeConfig(record.anthropic)
    : { ...DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG };

  return { openai, anthropic };
};

export const getWriterProviderRuntimeConfig = (
  config: WriterProviderRuntimeConfig,
  providerId: WriterProviderId,
): unknown => {
  if (providerId === "openai") {
    return config.openai;
  }

  if (providerId === "anthropic") {
    return config.anthropic;
  }

  return undefined;
};
