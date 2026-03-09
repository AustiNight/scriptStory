import {
  DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG,
  sanitizeOpenAIWriterRuntimeConfig,
  type OpenAIWriterRuntimeConfig,
} from "../../config/providerRuntimeConfig.ts";
import {
  doesOpenAiModelSupportMaxOutputTokens,
  doesOpenAiModelSupportTemperature,
  resolveOpenAiReasoningEffortForModel,
} from "../../config/openAiModelCatalog.ts";
import {
  PROVIDER_CAPABILITY_MATRIX,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import {
  OPENAI_ANALYST_TOOLS,
  normalizeToolCalls,
  type NormalizedToolCall,
} from "./toolCallContracts.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";
import {
  buildAnalyzePrompt,
  buildDecompositionFollowUpPrompt,
  buildKnowledgeBaseText,
  buildRefinePrompt,
  buildSummarizePrompt,
  isImageSource,
  isTextSource,
  mergeNormalizedToolCalls,
  needsHierarchicalDecompositionPass,
} from "./writerLogic.ts";

const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const BASE_RETRY_DELAY_MS = 250;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

export interface OpenAiFetchLike {
  (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response>;
}

export interface OpenAiWriterDependencies {
  fetchImpl?: OpenAiFetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface OpenAiRequestPayload {
  model: string;
  input: Array<{
    role: "user";
    content: Array<
      | {
          type: "input_text";
          text: string;
        }
      | {
          type: "input_image";
          image_url: string;
        }
    >;
  }>;
  temperature?: number;
  max_output_tokens?: number;
  reasoning?: {
    effort: string;
  };
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: "auto" | "required" | "none";
}

interface OpenAiRequestResult {
  jsonResponse?: Record<string, unknown>;
  streamEvents?: Array<Record<string, unknown>>;
}

export class OpenAiHttpError extends Error {
  public readonly status: number;
  public readonly transient: boolean;

  constructor(message: string, status: number, transient: boolean) {
    super(message);
    this.name = "OpenAiHttpError";
    this.status = status;
    this.transient = transient;
  }
}

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

const isTransientError = (error: unknown): boolean => {
  if (error instanceof OpenAiHttpError) {
    return error.transient;
  }

  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }

  if (error instanceof TypeError) {
    return true;
  }

  return false;
};

const readErrorMessage = async (response: Response): Promise<string> => {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const errorRecord = asRecord(body.error);
    const message =
      errorRecord && typeof errorRecord.message === "string"
        ? errorRecord.message
        : null;
    return message || `OpenAI request failed with status ${response.status}.`;
  } catch {
    return `OpenAI request failed with status ${response.status}.`;
  }
};

const extractOutputText = (payload: Record<string, unknown>): string => {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      continue;
    }

    const content = Array.isArray(itemRecord.content) ? itemRecord.content : [];
    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem);
      if (!contentRecord) {
        continue;
      }

      if (typeof contentRecord.text === "string" && contentRecord.text.trim()) {
        chunks.push(contentRecord.text.trim());
      }
    }
  }

  return chunks.join("\n").trim();
};

interface RawToolCall {
  name: string;
  arguments: unknown;
}

const extractToolCallsFromResponse = (payload: Record<string, unknown>): RawToolCall[] => {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const calls: RawToolCall[] = [];

  for (const item of output) {
    const itemRecord = asRecord(item);
    if (!itemRecord) {
      continue;
    }

    if (itemRecord.type !== "function_call") {
      continue;
    }

    if (typeof itemRecord.name !== "string") {
      continue;
    }

    calls.push({
      name: itemRecord.name,
      arguments:
        typeof itemRecord.arguments === "string"
          ? itemRecord.arguments
          : JSON.stringify(itemRecord.arguments ?? {}),
    });
  }

  return calls;
};

interface StreamCallAccumulator {
  name?: string;
  argumentsText: string;
}

const parseSseEvents = async (
  body: ReadableStream<Uint8Array>,
): Promise<Array<Record<string, unknown>>> => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (value) {
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    }

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex < 0) {
        break;
      }

      const block = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const dataLines = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());

      if (dataLines.length === 0) {
        continue;
      }

      const dataPayload = dataLines.join("\n");
      if (dataPayload === "[DONE]") {
        return events;
      }

      try {
        const parsed = JSON.parse(dataPayload);
        const record = asRecord(parsed);
        if (record) {
          events.push(record);
        }
      } catch {
        // Ignore malformed data packets.
      }
    }
  }

  return events;
};

const extractToolCallsFromStreamEvents = (
  events: Array<Record<string, unknown>>,
): RawToolCall[] => {
  const callMap = new Map<string, StreamCallAccumulator>();
  let completedPayload: Record<string, unknown> | null = null;

  const getOrCreateCall = (id: string): StreamCallAccumulator => {
    const existing = callMap.get(id);
    if (existing) {
      return existing;
    }

    const created: StreamCallAccumulator = { argumentsText: "" };
    callMap.set(id, created);
    return created;
  };

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = asRecord(event.item ?? event.output_item);
      if (!item || item.type !== "function_call") {
        continue;
      }

      const callIdCandidate = item.call_id ?? item.id ?? `${callMap.size + 1}`;
      const callId = String(callIdCandidate);
      const entry = getOrCreateCall(callId);

      if (typeof item.name === "string") {
        entry.name = item.name;
      }

      if (typeof item.arguments === "string") {
        entry.argumentsText = item.arguments;
      }
      continue;
    }

    if (type === "response.function_call_arguments.delta") {
      const callIdCandidate = event.call_id ?? event.item_id ?? event.id;
      if (!callIdCandidate) {
        continue;
      }

      const entry = getOrCreateCall(String(callIdCandidate));
      if (typeof event.name === "string") {
        entry.name = event.name;
      }

      if (typeof event.delta === "string") {
        entry.argumentsText += event.delta;
      }
      continue;
    }

    if (type === "response.function_call_arguments.done") {
      const callIdCandidate = event.call_id ?? event.item_id ?? event.id;
      if (!callIdCandidate) {
        continue;
      }

      const entry = getOrCreateCall(String(callIdCandidate));
      if (typeof event.name === "string") {
        entry.name = event.name;
      }

      if (typeof event.arguments === "string") {
        entry.argumentsText = event.arguments;
      }
      continue;
    }

    if (type === "response.completed") {
      const response = asRecord(event.response);
      if (response) {
        completedPayload = response;
      }
      continue;
    }

    if (type === "error") {
      const errorRecord = asRecord(event.error);
      const message =
        errorRecord && typeof errorRecord.message === "string"
          ? errorRecord.message
          : "OpenAI stream returned an error.";
      throw new OpenAiHttpError(message, 500, true);
    }
  }

  const streamCalls: RawToolCall[] = [];
  for (const [callId, entry] of callMap.entries()) {
    if (!entry.name || !entry.argumentsText.trim()) {
      continue;
    }

    streamCalls.push({
      name: entry.name,
      arguments: entry.argumentsText,
    });
  }

  if (streamCalls.length > 0) {
    return streamCalls;
  }

  return completedPayload ? extractToolCallsFromResponse(completedPayload) : [];
};

const buildOpenAiModelOptions = (
  model: string,
  config: OpenAIWriterRuntimeConfig,
): Pick<OpenAiRequestPayload, "max_output_tokens" | "reasoning" | "temperature"> => {
  const resolvedReasoningEffort = resolveOpenAiReasoningEffortForModel(
    model,
    config.reasoningEffort,
  );
  const supportsTemperature = doesOpenAiModelSupportTemperature(
    model,
    resolvedReasoningEffort || config.reasoningEffort,
  );

  return {
    ...(supportsTemperature ? { temperature: config.temperature } : {}),
    ...(doesOpenAiModelSupportMaxOutputTokens(model)
      ? { max_output_tokens: config.maxOutputTokens }
      : {}),
    ...(resolvedReasoningEffort
      ? {
          reasoning: {
            effort: resolvedReasoningEffort,
          },
        }
      : {}),
  };
};

export class OpenAiWriter
  implements WriterProvider<ContextSourceInput, WorkItemInput, NormalizedToolCall>
{
  public readonly id = "openai" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.openai;

  private readonly apiKey: string;
  private readonly fetchImpl: OpenAiFetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(apiKey: string, dependencies: OpenAiWriterDependencies = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
  }

  public async summarizeTranscript(
    transcript: string,
    providerConfig?: unknown,
  ): Promise<string> {
    const config = sanitizeOpenAIWriterRuntimeConfig(providerConfig);
    const prompt = buildSummarizePrompt(transcript);

    return this.withRetryAndFallback(
      config,
      config.summaryModel,
      async (model) => {
        const modelOptions = buildOpenAiModelOptions(model, config);
        const payload: OpenAiRequestPayload = {
          model,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          ],
          ...modelOptions,
        };

        const result = await this.executeRequest(payload, config.requestTimeoutMs);
        const response = result.jsonResponse || {};
        return extractOutputText(response);
      },
    );
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSourceInput[],
    providerConfig?: unknown,
  ): Promise<NormalizedToolCall[]> {
    if (!transcript.trim()) {
      return [];
    }

    const config = sanitizeOpenAIWriterRuntimeConfig(providerConfig);
    const enabledSources = contextSources.filter((source) => source.enabled !== false);
    const textSources = enabledSources.filter(isTextSource);
    const imageSources = enabledSources.filter(isImageSource);
    const knowledgeBaseText = buildKnowledgeBaseText(textSources);
    const prompt = buildAnalyzePrompt(transcript, projectContext, knowledgeBaseText);

    return this.withRetryAndFallback(
      config,
      config.analysisModel,
      async (model) => {
        const modelOptions = buildOpenAiModelOptions(model, config);
        const content: OpenAiRequestPayload["input"][number]["content"] = [
          { type: "input_text", text: prompt },
        ];

        for (const image of imageSources) {
          if (!image.mimeType || !image.content) {
            continue;
          }

          content.push({
            type: "input_text",
            text: `[IMAGE CONTEXT: Filename="${image.name}"]`,
          });
          content.push({
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.content}`,
          });
        }

        const payload: OpenAiRequestPayload = {
          model,
          input: [{ role: "user", content }],
          tools: OPENAI_ANALYST_TOOLS,
          tool_choice: "required",
          ...modelOptions,
          stream: true,
        };

        const result = await this.executeRequest(payload, config.requestTimeoutMs);
        const streamedCalls = result.streamEvents
          ? extractToolCallsFromStreamEvents(result.streamEvents)
          : [];
        const rawCalls =
          streamedCalls.length > 0
            ? streamedCalls
            : result.jsonResponse
              ? extractToolCallsFromResponse(result.jsonResponse)
              : [];

        const normalizedCalls = normalizeToolCalls(rawCalls);
        if (!needsHierarchicalDecompositionPass(normalizedCalls)) {
          return normalizedCalls;
        }

        try {
          const decompositionPrompt = buildDecompositionFollowUpPrompt(
            transcript,
            projectContext,
            normalizedCalls,
          );
          const decompositionPayload: OpenAiRequestPayload = {
            model,
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: decompositionPrompt }],
              },
            ],
            tools: OPENAI_ANALYST_TOOLS,
            tool_choice: "required",
            ...modelOptions,
            stream: true,
          };

          const decompositionResult = await this.executeRequest(
            decompositionPayload,
            config.requestTimeoutMs,
          );
          const decompositionStreamedCalls = decompositionResult.streamEvents
            ? extractToolCallsFromStreamEvents(decompositionResult.streamEvents)
            : [];
          const decompositionRawCalls =
            decompositionStreamedCalls.length > 0
              ? decompositionStreamedCalls
              : decompositionResult.jsonResponse
                ? extractToolCallsFromResponse(decompositionResult.jsonResponse)
                : [];
          const decompositionCalls = normalizeToolCalls(decompositionRawCalls);
          return mergeNormalizedToolCalls(normalizedCalls, decompositionCalls);
        } catch {
          return normalizedCalls;
        }
      },
    );
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItemInput,
    projectContext: string,
    providerConfig?: unknown,
  ): Promise<string> {
    const config = sanitizeOpenAIWriterRuntimeConfig(providerConfig);
    const prompt = buildRefinePrompt(rawTranscript, fieldName, currentItem, projectContext);

    return this.withRetryAndFallback(
      config,
      config.refineModel,
      async (model) => {
        const modelOptions = buildOpenAiModelOptions(model, config);
        const payload: OpenAiRequestPayload = {
          model,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: prompt }],
            },
          ],
          ...modelOptions,
        };

        const result = await this.executeRequest(payload, config.requestTimeoutMs);
        const response = result.jsonResponse || {};
        return extractOutputText(response);
      },
    );
  }

  private async withRetryAndFallback<T>(
    config: OpenAIWriterRuntimeConfig,
    primaryModel: string,
    runWithModel: (model: string) => Promise<T>,
  ): Promise<T> {
    const models = [primaryModel];
    if (config.fallbackModel && config.fallbackModel !== primaryModel) {
      models.push(config.fallbackModel);
    }

    let lastError: unknown = new OpenAiHttpError(
      "OpenAI request failed before execution.",
      500,
      true,
    );

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];

      for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
        try {
          return await runWithModel(model);
        } catch (error) {
          lastError = error;
          const transient = isTransientError(error);

          if (!transient) {
            throw error;
          }

          const isLastAttemptForModel = attempt >= config.maxRetries;
          const hasFallbackModel = modelIndex < models.length - 1;
          if (isLastAttemptForModel && hasFallbackModel) {
            break;
          }

          if (isLastAttemptForModel && !hasFallbackModel) {
            break;
          }

          const exponentialDelay = BASE_RETRY_DELAY_MS * 2 ** attempt;
          const jitter = Math.round(this.random() * 75);
          await this.sleep(exponentialDelay + jitter);
        }
      }
    }

    throw lastError;
  }

  private async executeRequest(
    payload: OpenAiRequestPayload,
    timeoutMs: number,
  ): Promise<OpenAiRequestResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(OPENAI_RESPONSES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new OpenAiHttpError(message, response.status, isTransientStatus(response.status));
      }

      const contentType = response.headers.get("content-type") || "";
      const isStream = payload.stream === true && contentType.includes("text/event-stream");

      if (isStream && response.body) {
        return { streamEvents: await parseSseEvents(response.body) };
      }

      const body = (await response.json()) as Record<string, unknown>;
      return { jsonResponse: body };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const openAiWriterDefaults = {
  ...DEFAULT_OPENAI_WRITER_RUNTIME_CONFIG,
};

export const openAiWriterInternals = {
  parseSseEvents,
  extractToolCallsFromResponse,
  extractToolCallsFromStreamEvents,
  extractOutputText,
};
