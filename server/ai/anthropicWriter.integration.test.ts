import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AnthropicWriter,
  type AnthropicFetchLike,
} from "./anthropicWriter.ts";

interface FixtureContextSource {
  name: string;
  type: "FILE" | "PASTE";
  content: string;
  mimeType?: string;
  enabled?: boolean;
}

interface FixtureToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface AnalyzeFixture {
  transcript: string;
  projectContext: string;
  contextSources: FixtureContextSource[];
  streamEvents: Array<Record<string, unknown>>;
  expectedToolCalls: FixtureToolCall[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturePath = path.join(__dirname, "test-fixtures", "anthropic-writer-fixtures.json");

const defaultAnthropicConfig = {
  summaryModel: "claude-3-5-haiku-latest",
  analysisModel: "claude-3-5-sonnet-latest",
  refineModel: "claude-3-5-haiku-latest",
  fallbackModel: "claude-3-5-haiku-latest",
  temperature: 0.2,
  maxOutputTokens: 900,
  requestTimeoutMs: 20_000,
  maxRetries: 1,
};

const createStreamResponse = (events: Array<Record<string, unknown>>): Response => {
  const body = events
    .map((event) => `event: ${String(event.type || "message")}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

const createJsonResponse = (body: Record<string, unknown>): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const createErrorResponse = (status: number, message: string): Response =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });

const loadFixture = async (): Promise<AnalyzeFixture> => {
  const raw = await fs.readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, AnalyzeFixture>;
  return parsed.feature_and_bug_review;
};

test("AnthropicWriter analyze: deterministic streamed tool-call extraction from fixture transcript", async () => {
  const fixture = await loadFixture();
  const modelSelections: string[] = [];

  const fetchImpl: AnthropicFetchLike = async (_url, init) => {
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));
    return createStreamResponse(fixture.streamEvents);
  };

  const writer = new AnthropicWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    fixture.transcript,
    fixture.projectContext,
    fixture.contextSources,
    defaultAnthropicConfig,
  );

  assert.deepEqual(modelSelections, ["claude-3-5-sonnet-latest"]);
  assert.deepEqual(toolCalls, fixture.expectedToolCalls);
});

test("AnthropicWriter analyze: transient failure retries/fallback uses fallback model", async () => {
  const fixture = await loadFixture();
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: AnthropicFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));

    if (requestCount === 1) {
      return createErrorResponse(429, "rate limited");
    }

    return createStreamResponse(fixture.streamEvents);
  };

  const writer = new AnthropicWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    fixture.transcript,
    fixture.projectContext,
    fixture.contextSources,
    {
      ...defaultAnthropicConfig,
      maxRetries: 0,
    },
  );

  assert.deepEqual(modelSelections, ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"]);
  assert.deepEqual(toolCalls, fixture.expectedToolCalls);
});

test("AnthropicWriter analyze: invalid tool arguments are dropped by schema validator", async () => {
  const invalidEvents = [
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "toolu_bad_1",
        name: "createWorkItem",
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json:
          "{\"type\":\"TASK\",\"description\":\"Missing title should fail validation.\"}",
      },
    },
    {
      type: "content_block_stop",
      index: 0,
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_ok_1",
        name: "setVisualMode",
        input: { enableBlur: true },
      },
    },
    {
      type: "content_block_stop",
      index: 1,
    },
    {
      type: "message_delta",
      delta: {
        stop_reason: "tool_use",
      },
    },
  ] satisfies Array<Record<string, unknown>>;

  const fetchImpl: AnthropicFetchLike = async () => createStreamResponse(invalidEvents);

  const writer = new AnthropicWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    "toggle blur and create a placeholder task",
    "",
    [],
    defaultAnthropicConfig,
  );

  assert.deepEqual(toolCalls, [{ name: "setVisualMode", args: { enableBlur: true } }]);
});

test("AnthropicWriter analyze: truncated stream safely falls back to non-stream recovery", async () => {
  const modelSelections: string[] = [];
  const streamFlags: boolean[] = [];
  let requestCount = 0;

  const fetchImpl: AnthropicFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));
    streamFlags.push(Boolean(payload.stream));

    if (requestCount === 1) {
      return createStreamResponse([
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_truncated_1",
            name: "createWorkItem",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: "{\"type\":\"TASK\",\"title\":\"Truncated payload",
          },
        },
        {
          type: "message_delta",
          delta: {
            stop_reason: "max_tokens",
          },
        },
      ]);
    }

    return createJsonResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_recovery_1",
          name: "createWorkItem",
          input: {
            type: "TASK",
            title: "Recovered call",
            description: "Retry without stream recovered a valid tool payload.",
          },
        },
      ],
      stop_reason: "tool_use",
    });
  };

  const writer = new AnthropicWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    "create a follow-up task for cleanup",
    "",
    [],
    defaultAnthropicConfig,
  );

  assert.deepEqual(modelSelections, ["claude-3-5-sonnet-latest", "claude-3-5-sonnet-latest"]);
  assert.deepEqual(streamFlags, [true, false]);
  assert.deepEqual(toolCalls, [
    {
      name: "createWorkItem",
      args: {
        type: "TASK",
        title: "Recovered call",
        description: "Retry without stream recovered a valid tool payload.",
      },
    },
  ]);
});
