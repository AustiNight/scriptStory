import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  OpenAiWriter,
  type OpenAiFetchLike,
} from "./openAiWriter.ts";

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
const fixturePath = path.join(__dirname, "test-fixtures", "openai-writer-fixtures.json");

const defaultOpenAiConfig = {
  summaryModel: "gpt-4.1-mini",
  analysisModel: "gpt-4.1",
  refineModel: "gpt-4.1-mini",
  fallbackModel: "gpt-4.1-mini",
  temperature: 0.2,
  maxOutputTokens: 900,
  requestTimeoutMs: 20_000,
  maxRetries: 1,
};

const createStreamResponse = (events: Array<Record<string, unknown>>): Response => {
  const body = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

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

test("OpenAiWriter analyze: deterministic streamed tool-call extraction from fixture transcript", async () => {
  const fixture = await loadFixture();
  const modelSelections: string[] = [];

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));
    return createStreamResponse(fixture.streamEvents);
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    fixture.transcript,
    fixture.projectContext,
    fixture.contextSources,
    defaultOpenAiConfig,
  );

  assert.deepEqual(modelSelections, ["gpt-4.1"]);
  assert.deepEqual(toolCalls, fixture.expectedToolCalls);
});

test("OpenAiWriter analyze: transient failure retries/fallback uses fallback model", async () => {
  const fixture = await loadFixture();
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));

    if (requestCount === 1) {
      return createErrorResponse(429, "rate limited");
    }

    return createStreamResponse(fixture.streamEvents);
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    fixture.transcript,
    fixture.projectContext,
    fixture.contextSources,
    {
      ...defaultOpenAiConfig,
      maxRetries: 0,
    },
  );

  assert.deepEqual(modelSelections, ["gpt-4.1", "gpt-4.1-mini"]);
  assert.deepEqual(toolCalls, fixture.expectedToolCalls);
});

test("OpenAiWriter analyze: invalid tool arguments are dropped by schema validator", async () => {
  const invalidEvents = [
    {
      type: "response.output_item.done",
      item: {
        id: "fc_bad_1",
        type: "function_call",
        name: "createWorkItem",
        arguments: "{\"type\":\"TASK\",\"description\":\"Missing title should fail validation.\"}",
      },
    },
    {
      type: "response.output_item.done",
      item: {
        id: "fc_ok_1",
        type: "function_call",
        name: "setVisualMode",
        arguments: "{\"enableBlur\":true}",
      },
    },
  ] satisfies Array<Record<string, unknown>>;

  const fetchImpl: OpenAiFetchLike = async () => createStreamResponse(invalidEvents);

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    "toggle blur and create a placeholder task",
    "",
    [],
    defaultOpenAiConfig,
  );

  assert.deepEqual(toolCalls, [{ name: "setVisualMode", args: { enableBlur: true } }]);
});
