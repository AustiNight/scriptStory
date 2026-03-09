export type OpenAiApiSurface = "responses" | "chat_completions";
export type OpenAiTemperatureSupport = "always" | "never" | "reasoning_none";
export type OpenAiReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface OpenAiModelCapabilities {
  id: string;
  label: string;
  supportedApis: readonly OpenAiApiSurface[];
  supportsReasoning: boolean;
  supportedReasoningEfforts: readonly OpenAiReasoningEffort[];
  defaultReasoningEffort: OpenAiReasoningEffort | null;
  temperatureSupport: OpenAiTemperatureSupport;
  supportsMaxOutputTokens: boolean;
}

export interface OpenAiModelOption {
  id: string;
  label: string;
}

const ALL_REASONING_EFFORTS: readonly OpenAiReasoningEffort[] = Object.freeze([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const OPENAI_MODELS: readonly OpenAiModelCapabilities[] = Object.freeze([
  {
    id: "gpt-4.1",
    label: "GPT-4.1",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: false,
    supportedReasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
    temperatureSupport: "always",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: false,
    supportedReasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
    temperatureSupport: "always",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-4.1-nano",
    label: "GPT-4.1 Nano",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: false,
    supportedReasoningEfforts: Object.freeze([]),
    defaultReasoningEffort: null,
    temperatureSupport: "always",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["none", "low", "medium", "high", "xhigh"]),
    defaultReasoningEffort: "none",
    temperatureSupport: "reasoning_none",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["minimal", "low", "medium", "high"]),
    defaultReasoningEffort: "medium",
    temperatureSupport: "never",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-5-mini",
    label: "GPT-5 Mini",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["minimal", "low", "medium", "high"]),
    defaultReasoningEffort: "medium",
    temperatureSupport: "never",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    supportedApis: Object.freeze(["responses", "chat_completions"]),
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["minimal", "low", "medium", "high"]),
    defaultReasoningEffort: "medium",
    temperatureSupport: "never",
    supportsMaxOutputTokens: true,
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    supportedApis: Object.freeze(["responses"]),
    supportsReasoning: true,
    supportedReasoningEfforts: Object.freeze(["low", "medium", "high", "xhigh"]),
    defaultReasoningEffort: "medium",
    temperatureSupport: "never",
    supportsMaxOutputTokens: true,
  },
]);

const OPENAI_MODEL_MAP: ReadonlyMap<string, OpenAiModelCapabilities> = new Map(
  OPENAI_MODELS.map((model) => [model.id, model]),
);

export const OPENAI_RESPONSES_MODEL_OPTIONS: readonly OpenAiModelOption[] = Object.freeze(
  OPENAI_MODELS.filter((model) => model.supportedApis.includes("responses")).map((model) => ({
    id: model.id,
    label: model.label,
  })),
);

const DEFAULT_OPENAI_RESPONSES_MODEL_ID = "gpt-4.1-mini";

const DEFAULT_OPENAI_RESPONSES_MODEL =
  OPENAI_MODEL_MAP.get(DEFAULT_OPENAI_RESPONSES_MODEL_ID) || OPENAI_MODELS[0];

export const OPENAI_REASONING_EFFORTS: readonly OpenAiReasoningEffort[] = ALL_REASONING_EFFORTS;

export const isSupportedOpenAiResponsesModel = (modelId: unknown): modelId is string => {
  if (typeof modelId !== "string") {
    return false;
  }

  const capability = OPENAI_MODEL_MAP.get(modelId);
  return Boolean(capability && capability.supportedApis.includes("responses"));
};

export const sanitizeOpenAiResponsesModelId = (value: unknown, fallback: string): string => {
  if (isSupportedOpenAiResponsesModel(value)) {
    return value;
  }

  if (isSupportedOpenAiResponsesModel(fallback)) {
    return fallback;
  }

  return DEFAULT_OPENAI_RESPONSES_MODEL.id;
};

export const getOpenAiModelCapabilities = (modelId: string): OpenAiModelCapabilities => {
  const capability = OPENAI_MODEL_MAP.get(modelId);
  if (capability) {
    return capability;
  }

  return DEFAULT_OPENAI_RESPONSES_MODEL;
};

export const resolveOpenAiReasoningEffortForModel = (
  modelId: string,
  requestedEffort: OpenAiReasoningEffort,
): OpenAiReasoningEffort | null => {
  const capability = getOpenAiModelCapabilities(modelId);
  if (!capability.supportsReasoning) {
    return null;
  }

  if (capability.supportedReasoningEfforts.includes(requestedEffort)) {
    return requestedEffort;
  }

  return (
    capability.defaultReasoningEffort ||
    capability.supportedReasoningEfforts[0] ||
    null
  );
};

export const doesOpenAiModelSupportTemperature = (
  modelId: string,
  reasoningEffort: OpenAiReasoningEffort,
): boolean => {
  const capability = getOpenAiModelCapabilities(modelId);
  if (capability.temperatureSupport === "always") {
    return true;
  }

  if (capability.temperatureSupport === "never") {
    return false;
  }

  return reasoningEffort === "none";
};

export const doesOpenAiModelSupportMaxOutputTokens = (modelId: string): boolean =>
  getOpenAiModelCapabilities(modelId).supportsMaxOutputTokens;
