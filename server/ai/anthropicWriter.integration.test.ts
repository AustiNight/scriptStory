import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicWriter,
  type AnthropicFetchLike,
} from "./anthropicWriter.ts";
import { assessAnalysisConfidence } from "./contextRetrievalStrategy.ts";
import {
  WRITER_REGRESSION_FIXTURES,
  buildAnthropicStreamEvents,
  type FixtureToolCall,
  type WriterRegressionFixture,
} from "./test-fixtures/writerRegressionFixtures.ts";

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

const hasWorkItemMutation = (toolCalls: FixtureToolCall[]): boolean =>
  toolCalls.some(
    (call) => call.name === "createWorkItem" || call.name === "updateWorkItem",
  );

const assertToolCallShape = (fixtureId: string, toolCalls: FixtureToolCall[]): void => {
  for (const call of toolCalls) {
    assert.equal(typeof call.name, "string", `${fixtureId}: tool call name must be a string.`);
    assert.ok(call.name.length > 0, `${fixtureId}: tool call name must not be empty.`);
    assert.equal(
      typeof call.args,
      "object",
      `${fixtureId}: tool call arguments must be object-shaped.`,
    );
    assert.equal(Array.isArray(call.args), false, `${fixtureId}: tool call arguments must not be arrays.`);
  }
};

const assertQualityRubric = (
  fixture: WriterRegressionFixture,
  toolCalls: FixtureToolCall[],
): void => {
  assert.ok(
    toolCalls.length >= fixture.qualityRubric.minToolCalls,
    `${fixture.id}: expected at least ${fixture.qualityRubric.minToolCalls} tool calls, got ${toolCalls.length}.`,
  );
  assert.ok(
    toolCalls.length <= fixture.qualityRubric.maxToolCalls,
    `${fixture.id}: expected at most ${fixture.qualityRubric.maxToolCalls} tool calls, got ${toolCalls.length}.`,
  );
  if (fixture.qualityRubric.requireWorkItemMutation) {
    assert.equal(
      hasWorkItemMutation(toolCalls),
      true,
      `${fixture.id}: expected at least one create/update work-item call.`,
    );
  }

  const confidence = assessAnalysisConfidence(toolCalls, fixture.transcript);
  assert.ok(
    confidence.score >= fixture.qualityRubric.minConfidenceScore,
    `${fixture.id}: confidence ${confidence.score} below rubric minimum ${fixture.qualityRubric.minConfidenceScore}.`,
  );
};

test("AnthropicWriter analyze: regression fixtures preserve tool-call structure and quality rubric", async () => {
  const modelSelections: string[] = [];

  for (const fixture of WRITER_REGRESSION_FIXTURES) {
    const fetchImpl: AnthropicFetchLike = async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      modelSelections.push(String(payload.model || ""));
      return createStreamResponse(buildAnthropicStreamEvents(fixture.expectedToolCalls));
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

    assert.deepEqual(toolCalls, fixture.expectedToolCalls);
    assertToolCallShape(fixture.id, toolCalls);
    assertQualityRubric(fixture, toolCalls);
  }

  assert.equal(modelSelections.length, WRITER_REGRESSION_FIXTURES.length);
  assert.ok(modelSelections.every((model) => model === "claude-3-5-sonnet-latest"));
});

test("AnthropicWriter analyze: transient failure retries/fallback uses fallback model", async () => {
  const fixture = WRITER_REGRESSION_FIXTURES[0];
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: AnthropicFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));

    if (requestCount === 1) {
      return createErrorResponse(429, "rate limited");
    }

    return createStreamResponse(buildAnthropicStreamEvents(fixture.expectedToolCalls));
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

test("AnthropicWriter analyze: timeout on primary model falls back cleanly", async () => {
  const fixture = WRITER_REGRESSION_FIXTURES[1];
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: AnthropicFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));

    if (requestCount === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("Expected abort signal for timeout scenario."));
          return;
        }

        if (signal.aborted) {
          reject(new DOMException("Request aborted.", "AbortError"));
          return;
        }

        signal.addEventListener(
          "abort",
          () => {
            reject(new DOMException("Request aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    }

    return createStreamResponse(buildAnthropicStreamEvents(fixture.expectedToolCalls));
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
      requestTimeoutMs: 5,
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
