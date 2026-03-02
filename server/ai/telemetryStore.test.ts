import assert from "node:assert/strict";
import test from "node:test";
import { AiTelemetryStore, estimateTokens } from "./telemetryStore.ts";

test("AiTelemetryStore aggregates request, provider, operation, and server metrics", () => {
  const store = new AiTelemetryStore(20);

  store.record({
    provider: "openai",
    operation: "analyze",
    success: true,
    durationMs: 120,
    inputTokens: 80,
    outputTokens: 45,
    retrievalTokens: 60,
    contextMode: "manual-enrich",
    serverUsage: [
      {
        serverId: "docs",
        serverName: "Docs",
        tokens: 40,
        reachable: true,
        fromCache: false,
        latencyMs: 35,
      },
      {
        serverId: "ops",
        serverName: "Ops",
        tokens: 20,
        reachable: true,
        fromCache: true,
        latencyMs: 2,
      },
    ],
  });

  store.record({
    provider: "openai",
    operation: "analyze",
    success: false,
    durationMs: 240,
    inputTokens: 70,
    outputTokens: 0,
    retrievalTokens: 0,
    errorCode: "PROVIDER_TIMEOUT",
  });

  store.record({
    provider: "anthropic",
    operation: "summarize",
    success: true,
    durationMs: 40,
    inputTokens: 25,
    outputTokens: 10,
    retrievalTokens: 0,
  });

  const snapshot = store.getSnapshot();
  assert.equal(snapshot.totals.requests, 3);
  assert.equal(snapshot.totals.successes, 2);
  assert.equal(snapshot.totals.failures, 1);
  assert.equal(snapshot.totals.totalTokens, 290);

  assert.equal(snapshot.byProvider.openai.requests, 2);
  assert.equal(snapshot.byProvider.openai.failures, 1);
  assert.equal(snapshot.byProvider.openai.totalTokens, 255);

  assert.equal(snapshot.byOperation.analyze.requests, 2);
  assert.equal(snapshot.byOperation.summarize.requests, 1);
  assert.equal(snapshot.byOperation.refine.requests, 0);

  assert.equal(snapshot.byServer["docs:Docs"].requests, 1);
  assert.equal(snapshot.byServer["docs:Docs"].retrievalTokens, 40);
  assert.equal(snapshot.byServer["ops:Ops"].requests, 1);
  assert.equal(snapshot.byServer["ops:Ops"].retrievalTokens, 20);

  assert.equal(snapshot.recent.length, 3);
});

test("AiTelemetryStore respects event retention limit", () => {
  const store = new AiTelemetryStore(2);

  store.record({
    provider: "gemini",
    operation: "summarize",
    success: true,
    durationMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    retrievalTokens: 0,
  });
  store.record({
    provider: "gemini",
    operation: "refine",
    success: true,
    durationMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    retrievalTokens: 0,
  });
  store.record({
    provider: "gemini",
    operation: "analyze",
    success: true,
    durationMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    retrievalTokens: 0,
  });

  const snapshot = store.getSnapshot(10);
  assert.equal(snapshot.totals.requests, 2);
  assert.equal(snapshot.recent.length, 2);
});

test("estimateTokens returns bounded values for text and structured payloads", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.ok(estimateTokens({ text: "abcdefgh" }) >= 3);
  assert.equal(estimateTokens(null), 0);
});
