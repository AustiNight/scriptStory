import assert from "node:assert/strict";
import test from "node:test";
import type { NormalizedToolCall } from "./toolCallContracts.ts";
import {
  buildAnalyzePrompt,
  mergeNormalizedToolCalls,
  needsHierarchicalDecompositionPass,
} from "./writerLogic.ts";

const createWorkItem = (type: string, title: string, extra: Record<string, unknown> = {}): NormalizedToolCall => ({
  name: "createWorkItem",
  args: {
    type,
    title,
    description: `${title} description`,
    ...extra,
  },
});

test("writer logic: decomposition pass required when epic lacks feature or story", () => {
  const calls: NormalizedToolCall[] = [createWorkItem("EPIC", "Platform migration", { tempId: "E1" })];
  assert.equal(needsHierarchicalDecompositionPass(calls), true);
});

test("writer logic: decomposition pass not required when epic, feature, story all exist", () => {
  const calls: NormalizedToolCall[] = [
    createWorkItem("EPIC", "Platform migration", { tempId: "E1" }),
    createWorkItem("FEATURE", "Auth migration", { tempId: "F1", parentTempId: "E1" }),
    createWorkItem("STORY", "Migrate session refresh", { tempId: "S1", parentTempId: "F1" }),
  ];
  assert.equal(needsHierarchicalDecompositionPass(calls), false);
});

test("writer logic: mergeNormalizedToolCalls dedupes create calls by semantic key", () => {
  const primary: NormalizedToolCall[] = [
    createWorkItem("FEATURE", "Auth migration", { tempId: "F1", parentTempId: "E1" }),
  ];
  const secondary: NormalizedToolCall[] = [
    createWorkItem("FEATURE", "Auth migration", { tempId: "F99", parentTempId: "E1" }),
    createWorkItem("STORY", "Migrate session refresh", { tempId: "S1", parentTempId: "F1" }),
  ];

  const merged = mergeNormalizedToolCalls(primary, secondary);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].args.type, "FEATURE");
  assert.equal(merged[1].args.type, "STORY");
});

test("writer logic: analyze prompt includes atomic story and hierarchy constraints", () => {
  const prompt = buildAnalyzePrompt("transcript", "context", "kb");
  assert.equal(prompt.includes("ATOMIC STORY DEFINITION"), true);
  assert.equal(prompt.includes("EPIC -> FEATURE -> STORY"), true);
  assert.equal(prompt.includes("Given/When/Then"), true);
});
