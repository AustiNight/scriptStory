import {
  DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG,
  sanitizeAnthropicWriterRuntimeConfig,
  type AnthropicWriterRuntimeConfig,
} from "../../config/providerRuntimeConfig.ts";
import {
  PROVIDER_CAPABILITY_MATRIX,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import {
  ANTHROPIC_ANALYST_TOOLS,
  normalizeToolCalls,
  type NormalizedToolCall,
} from "./toolCallContracts.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_SOURCE_CONTENT_CHARS = 15_000;
const BASE_RETRY_DELAY_MS = 250;

const isTextSource = (source: ContextSourceInput): boolean =>
  !source.mimeType || source.mimeType.startsWith("text/") || source.mimeType === "application/json";

const isImageSource = (source: ContextSourceInput): boolean =>
  Boolean(source.mimeType && source.mimeType.startsWith("image/"));

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

export interface AnthropicFetchLike {
  (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ): Promise<Response>;
}

export interface AnthropicWriterDependencies {
  fetchImpl?: AnthropicFetchLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

interface AnthropicRequestPayload {
  model: string;
  messages: Array<{
    role: "user";
    content: Array<
      | {
          type: "text";
          text: string;
        }
      | {
          type: "image";
          source: {
            type: "base64";
            media_type: string;
            data: string;
          };
        }
    >;
  }>;
  temperature: number;
  max_tokens: number;
  stream?: boolean;
  tools?: typeof ANTHROPIC_ANALYST_TOOLS;
  tool_choice?: { type: "auto" | "any" };
}

interface AnthropicRequestResult {
  jsonResponse?: Record<string, unknown>;
  streamEvents?: Array<Record<string, unknown>>;
  truncated?: boolean;
}

export class AnthropicHttpError extends Error {
  public readonly status: number;
  public readonly transient: boolean;

  constructor(message: string, status: number, transient: boolean) {
    super(message);
    this.name = "AnthropicHttpError";
    this.status = status;
    this.transient = transient;
  }
}

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 409 || status === 429 || status >= 500;

const isTransientError = (error: unknown): boolean => {
  if (error instanceof AnthropicHttpError) {
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
    const nestedError = asRecord(body.error);
    const message =
      (nestedError && typeof nestedError.message === "string"
        ? nestedError.message
        : null) ||
      (typeof body.message === "string" ? body.message : null);
    return message || `Anthropic request failed with status ${response.status}.`;
  } catch {
    return `Anthropic request failed with status ${response.status}.`;
  }
};

const extractOutputText = (payload: Record<string, unknown>): string => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const chunks: string[] = [];

  for (const item of content) {
    const itemRecord = asRecord(item);
    if (!itemRecord || itemRecord.type !== "text") {
      continue;
    }

    if (typeof itemRecord.text === "string" && itemRecord.text.trim()) {
      chunks.push(itemRecord.text.trim());
    }
  }

  return chunks.join("\n").trim();
};

interface RawToolCall {
  name: string;
  arguments: unknown;
}

const extractToolCallsFromMessage = (payload: Record<string, unknown>): RawToolCall[] => {
  const content = Array.isArray(payload.content) ? payload.content : [];
  const calls: RawToolCall[] = [];

  for (const item of content) {
    const block = asRecord(item);
    if (!block || block.type !== "tool_use" || typeof block.name !== "string") {
      continue;
    }

    calls.push({
      name: block.name,
      arguments: block.input ?? "{}",
    });
  }

  return calls;
};

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

const isTruncatedStream = (events: Array<Record<string, unknown>>): boolean =>
  events.some((event) => {
    if (event.type !== "message_delta") {
      return false;
    }

    const delta = asRecord(event.delta);
    return delta?.stop_reason === "max_tokens";
  });

interface StreamCallAccumulator {
  name?: string;
  inputFromStart?: unknown;
  inputDelta: string;
}

const extractToolCallsFromStreamEvents = (
  events: Array<Record<string, unknown>>,
): { calls: RawToolCall[]; truncated: boolean } => {
  const callMap = new Map<string, StreamCallAccumulator>();

  const getOrCreateCall = (id: string): StreamCallAccumulator => {
    const existing = callMap.get(id);
    if (existing) {
      return existing;
    }

    const created: StreamCallAccumulator = { inputDelta: "" };
    callMap.set(id, created);
    return created;
  };

  for (const event of events) {
    const type = typeof event.type === "string" ? event.type : "";

    if (type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (!block || block.type !== "tool_use") {
        continue;
      }

      const callKey = String(event.index ?? block.id ?? `tool_${callMap.size + 1}`);
      const entry = getOrCreateCall(callKey);

      if (typeof block.name === "string") {
        entry.name = block.name;
      }

      if (Object.prototype.hasOwnProperty.call(block, "input")) {
        entry.inputFromStart = block.input;
      }
      continue;
    }

    if (type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (!delta || delta.type !== "input_json_delta") {
        continue;
      }

      const callKey = String(event.index ?? `tool_${callMap.size + 1}`);
      const entry = getOrCreateCall(callKey);
      if (typeof delta.partial_json === "string") {
        entry.inputDelta += delta.partial_json;
      }
      continue;
    }

    if (type === "error") {
      const errorRecord = asRecord(event.error);
      const message =
        errorRecord && typeof errorRecord.message === "string"
          ? errorRecord.message
          : "Anthropic stream returned an error.";
      throw new AnthropicHttpError(message, 500, true);
    }
  }

  const streamCalls: RawToolCall[] = [];
  for (const [, entry] of callMap.entries()) {
    if (!entry.name) {
      continue;
    }

    streamCalls.push({
      name: entry.name,
      arguments:
        entry.inputDelta.trim().length > 0
          ? entry.inputDelta
          : entry.inputFromStart ?? "{}",
    });
  }

  return {
    calls: streamCalls,
    truncated: isTruncatedStream(events),
  };
};

const buildKnowledgeBaseText = (textSources: ContextSourceInput[]): string =>
  textSources
    .map((source) => {
      const truncated = source.content.slice(0, MAX_SOURCE_CONTENT_CHARS);
      const suffix =
        source.content.length > MAX_SOURCE_CONTENT_CHARS ? "\n[truncated]" : "";
      return `\n-- SOURCE: ${source.name} (${source.type}) --\n${truncated}${suffix}`;
    })
    .join("\n");

const buildAnalyzePrompt = (
  transcript: string,
  projectContext: string,
  knowledgeBaseText: string,
): string => `
You are an expert Agile Architect and Product Owner.

MISSION:
Analyze the transcript and generate a comprehensive set of structured work-item tool calls.
Break large requirements into hierarchy (Epic -> Feature -> Story) where applicable.

EXISTING vs NEW:
1) Use image file naming clues:
   - UAT/PROD/LIVE/DEMO implies existing features.
   - PROTOTYPE/MOCKUP/DESIGN implies new features.
2) Use transcript language clues:
   - "Here we have", "As you can see", "This is working" implies demo.
   - "We need to", "It should", "I want" implies new requirement.
3) Behavior:
   - Existing/demoed features: represent existing capability with story criteria marked met=true and create follow-up tasks/bugs as needed.
   - New features: create EPIC/FEATURE/STORY with met=false criteria.

VALIDATION RULES:
- EPIC/FEATURE/STORY require: title, description, criteria[] with text + met.
- BUG requires: title, description, stepsToReproduce[], expectedResult, actualResult.
- TASK requires: title and description.
- Use tempId/parentTempId for same-batch hierarchy links.

EXISTING BOARD CONTEXT:
${projectContext || "No active board context provided."}

KNOWLEDGE BASE:
${knowledgeBaseText || "No text documentation provided."}

TRANSCRIPT:
"${transcript}"
`.trim();

export class AnthropicWriter
  implements WriterProvider<ContextSourceInput, WorkItemInput, NormalizedToolCall>
{
  public readonly id = "anthropic" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.anthropic;

  private readonly apiKey: string;
  private readonly fetchImpl: AnthropicFetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(apiKey: string, dependencies: AnthropicWriterDependencies = {}) {
    this.apiKey = apiKey;
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = dependencies.random ?? Math.random;
  }

  public async summarizeTranscript(
    transcript: string,
    providerConfig?: unknown,
  ): Promise<string> {
    const config = sanitizeAnthropicWriterRuntimeConfig(providerConfig);
    const prompt = `
Summarize this meeting transcript in 1 or 2 concise sentences.
Focus on work items, risks, and decisions.

Transcript:
"${transcript}"
    `.trim();

    return this.withRetryAndFallback(
      config,
      config.summaryModel,
      async (model) => {
        const payload: AnthropicRequestPayload = {
          model,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          temperature: config.temperature,
          max_tokens: config.maxOutputTokens,
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

    const config = sanitizeAnthropicWriterRuntimeConfig(providerConfig);
    const enabledSources = contextSources.filter((source) => source.enabled !== false);
    const textSources = enabledSources.filter(isTextSource);
    const imageSources = enabledSources.filter(isImageSource);
    const knowledgeBaseText = buildKnowledgeBaseText(textSources);
    const prompt = buildAnalyzePrompt(transcript, projectContext, knowledgeBaseText);

    return this.withRetryAndFallback(
      config,
      config.analysisModel,
      async (model) => {
        const content: AnthropicRequestPayload["messages"][number]["content"] = [
          { type: "text", text: prompt },
        ];

        for (const image of imageSources) {
          if (!image.mimeType || !image.content) {
            continue;
          }

          content.push({
            type: "text",
            text: `[IMAGE CONTEXT: Filename="${image.name}"]`,
          });
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: image.mimeType,
              data: image.content,
            },
          });
        }

        const payload: AnthropicRequestPayload = {
          model,
          messages: [{ role: "user", content }],
          tools: ANTHROPIC_ANALYST_TOOLS,
          tool_choice: { type: "auto" },
          temperature: config.temperature,
          max_tokens: config.maxOutputTokens,
          stream: true,
        };

        const streamedResult = await this.executeRequest(payload, config.requestTimeoutMs);
        const streamExtraction = streamedResult.streamEvents
          ? extractToolCallsFromStreamEvents(streamedResult.streamEvents)
          : null;

        const rawCalls = streamExtraction
          ? streamExtraction.calls
          : streamedResult.jsonResponse
            ? extractToolCallsFromMessage(streamedResult.jsonResponse)
            : [];
        const normalized = normalizeToolCalls(rawCalls);

        if (normalized.length > 0) {
          return normalized;
        }

        if (streamExtraction?.truncated) {
          const recoveryPayload: AnthropicRequestPayload = {
            ...payload,
            stream: false,
          };
          const recoveryResult = await this.executeRequest(recoveryPayload, config.requestTimeoutMs);
          const recoveryCalls = recoveryResult.jsonResponse
            ? extractToolCallsFromMessage(recoveryResult.jsonResponse)
            : [];
          return normalizeToolCalls(recoveryCalls);
        }

        return normalized;
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
    const config = sanitizeAnthropicWriterRuntimeConfig(providerConfig);
    const prompt = `
Refine the ${fieldName} field for this ${currentItem.type}.

Current Title: ${currentItem.title}
Current Description: ${currentItem.description}
Project Context:
${projectContext || "No additional context."}

Transcript Input:
"${rawTranscript}"

Return only the refined field text.
    `.trim();

    return this.withRetryAndFallback(
      config,
      config.refineModel,
      async (model) => {
        const payload: AnthropicRequestPayload = {
          model,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          temperature: config.temperature,
          max_tokens: config.maxOutputTokens,
        };

        const result = await this.executeRequest(payload, config.requestTimeoutMs);
        const response = result.jsonResponse || {};
        return extractOutputText(response);
      },
    );
  }

  private async withRetryAndFallback<T>(
    config: AnthropicWriterRuntimeConfig,
    primaryModel: string,
    runWithModel: (model: string) => Promise<T>,
  ): Promise<T> {
    const models = [primaryModel];
    if (config.fallbackModel && config.fallbackModel !== primaryModel) {
      models.push(config.fallbackModel);
    }

    let lastError: unknown = new AnthropicHttpError(
      "Anthropic request failed before execution.",
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
    payload: AnthropicRequestPayload,
    timeoutMs: number,
  ): Promise<AnthropicRequestResult> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(ANTHROPIC_MESSAGES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const message = await readErrorMessage(response);
        throw new AnthropicHttpError(message, response.status, isTransientStatus(response.status));
      }

      const contentType = response.headers.get("content-type") || "";
      const isStream = payload.stream === true && contentType.includes("text/event-stream");

      if (isStream && response.body) {
        const streamEvents = await parseSseEvents(response.body);
        return {
          streamEvents,
          truncated: isTruncatedStream(streamEvents),
        };
      }

      const body = (await response.json()) as Record<string, unknown>;
      return {
        jsonResponse: body,
        truncated: body.stop_reason === "max_tokens",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const anthropicWriterDefaults = {
  ...DEFAULT_ANTHROPIC_WRITER_RUNTIME_CONFIG,
};

export const anthropicWriterInternals = {
  parseSseEvents,
  extractToolCallsFromMessage,
  extractToolCallsFromStreamEvents,
  extractOutputText,
};
