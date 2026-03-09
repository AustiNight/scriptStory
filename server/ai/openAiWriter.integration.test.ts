import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenAiWriter,
  type OpenAiFetchLike,
} from "./openAiWriter.ts";
import { assessAnalysisConfidence } from "./contextRetrievalStrategy.ts";
import {
  WRITER_REGRESSION_FIXTURES,
  buildOpenAiStreamEvents,
  type FixtureToolCall,
  type WriterRegressionFixture,
} from "./test-fixtures/writerRegressionFixtures.ts";

const defaultOpenAiConfig = {
  summaryModel: "gpt-4.1-mini",
  analysisModel: "gpt-4.1",
  refineModel: "gpt-4.1-mini",
  fallbackModel: "gpt-4.1-mini",
  reasoningEffort: "none",
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

test("OpenAiWriter analyze: regression fixtures preserve tool-call structure and quality rubric", async () => {
  const modelSelections: string[] = [];

  for (const fixture of WRITER_REGRESSION_FIXTURES) {
    const fetchImpl: OpenAiFetchLike = async (_url, init) => {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      modelSelections.push(String(payload.model || ""));
      return createStreamResponse(buildOpenAiStreamEvents(fixture.expectedToolCalls));
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

    assert.deepEqual(toolCalls, fixture.expectedToolCalls);
    assertToolCallShape(fixture.id, toolCalls);
    assertQualityRubric(fixture, toolCalls);
  }

  assert.equal(modelSelections.length, WRITER_REGRESSION_FIXTURES.length);
  assert.ok(modelSelections.every((model) => model === "gpt-4.1"));
});

test("OpenAiWriter analyze: transient failure retries/fallback uses fallback model", async () => {
  const fixture = WRITER_REGRESSION_FIXTURES[0];
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    requestCount += 1;
    const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    modelSelections.push(String(payload.model || ""));

    if (requestCount === 1) {
      return createErrorResponse(429, "rate limited");
    }

    return createStreamResponse(buildOpenAiStreamEvents(fixture.expectedToolCalls));
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

test("OpenAiWriter analyze: timeout on primary model falls back cleanly", async () => {
  const fixture = WRITER_REGRESSION_FIXTURES[1];
  const modelSelections: string[] = [];
  let requestCount = 0;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
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

    return createStreamResponse(buildOpenAiStreamEvents(fixture.expectedToolCalls));
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
      requestTimeoutMs: 5,
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

test("OpenAiWriter summarize: gpt-5.2 with low reasoning omits temperature", async () => {
  let capturedPayload: Record<string, unknown> | null = null;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    capturedPayload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ output_text: "Summary output." }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const summary = await writer.summarizeTranscript(
    "Summarize this content.",
    {
      ...defaultOpenAiConfig,
      summaryModel: "gpt-5.2",
      reasoningEffort: "low",
    },
  );

  assert.equal(summary, "Summary output.");
  assert.ok(capturedPayload);
  assert.equal(capturedPayload?.model, "gpt-5.2");
  assert.equal("temperature" in (capturedPayload || {}), false);
  assert.deepEqual(capturedPayload?.reasoning, { effort: "low" });
  assert.equal(capturedPayload?.max_output_tokens, 900);
});

test("OpenAiWriter summarize: gpt-5.2 with none reasoning includes temperature", async () => {
  let capturedPayload: Record<string, unknown> | null = null;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    capturedPayload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ output_text: "Summary output." }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const summary = await writer.summarizeTranscript(
    "Summarize this content.",
    {
      ...defaultOpenAiConfig,
      summaryModel: "gpt-5.2",
      reasoningEffort: "none",
    },
  );

  assert.equal(summary, "Summary output.");
  assert.ok(capturedPayload);
  assert.equal(capturedPayload?.model, "gpt-5.2");
  assert.equal(capturedPayload?.temperature, 0.2);
  assert.deepEqual(capturedPayload?.reasoning, { effort: "none" });
});

test("OpenAiWriter summarize: unsupported chat-only model falls back to responses-safe model", async () => {
  let capturedPayload: Record<string, unknown> | null = null;

  const fetchImpl: OpenAiFetchLike = async (_url, init) => {
    capturedPayload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({ output_text: "Summary output." }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  await writer.summarizeTranscript(
    "Summarize this content.",
    {
      ...defaultOpenAiConfig,
      summaryModel: "gpt-5.3-chat-latest",
    },
  );

  assert.ok(capturedPayload);
  assert.equal(capturedPayload?.model, "gpt-4.1-mini");
});

test("OpenAiWriter analyze: decomposition follow-up pass expands epic into feature/story when missing", async () => {
  let requestCount = 0;

  const fetchImpl: OpenAiFetchLike = async () => {
    requestCount += 1;

    if (requestCount === 1) {
      return createStreamResponse(
        buildOpenAiStreamEvents([
          {
            name: "createWorkItem",
            args: {
              type: "EPIC",
              title: "Improve onboarding flow",
              description: "Create a modern onboarding workflow for first-time users.",
              criteria: [
                {
                  text: "Given onboarding is available, when a new user signs in, then onboarding can be completed in UI.",
                  met: false,
                },
              ],
              tempId: "E1",
            },
          },
        ]),
      );
    }

    return createStreamResponse(
      buildOpenAiStreamEvents([
        {
          name: "createWorkItem",
          args: {
            type: "FEATURE",
            title: "Onboarding step orchestration",
            description: "Define and persist a deterministic step sequence for onboarding.",
            criteria: [
              {
                text: "Given onboarding step state exists, when user progresses, then next step is resolved and persisted.",
                met: false,
              },
            ],
            tempId: "F1",
            parentTempId: "E1",
          },
        },
        {
          name: "createWorkItem",
          args: {
            type: "STORY",
            title: "Complete profile basics in onboarding",
            description:
              "As a new user, I can submit profile basics in the onboarding UI and see my saved profile reflected immediately.",
            criteria: [
              {
                text: "Given onboarding is active, when user submits profile basics, then API validates and persists data and UI reflects saved state.",
                met: false,
              },
            ],
            tempId: "S1",
            parentTempId: "F1",
          },
        },
      ]),
    );
  };

  const writer = new OpenAiWriter("test-api-key", {
    fetchImpl,
    sleep: async () => undefined,
    random: () => 0,
  });

  const toolCalls = await writer.analyzeMeetingTranscript(
    "We need to improve onboarding for new users and break it into implementation slices.",
    "",
    [],
    defaultOpenAiConfig,
  );

  const createTypes = toolCalls
    .filter((call) => call.name === "createWorkItem")
    .map((call) => String(call.args.type || "").toUpperCase());

  assert.equal(requestCount, 2);
  assert.ok(createTypes.includes("EPIC"));
  assert.ok(createTypes.includes("FEATURE"));
  assert.ok(createTypes.includes("STORY"));
});
