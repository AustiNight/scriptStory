import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYST_TOOL_DEFINITIONS,
  ANTHROPIC_ANALYST_TOOLS,
  GEMINI_ANALYST_TOOLS,
  OPENAI_ANALYST_TOOLS,
} from "./toolCallContracts.ts";

test("tool manifests: provider tool sets stay aligned to canonical definitions", () => {
  const canonicalNames = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.name);
  const openAiNames = OPENAI_ANALYST_TOOLS.map((tool) => tool.name);
  const anthropicNames = ANTHROPIC_ANALYST_TOOLS.map((tool) => tool.name);
  const geminiNames =
    GEMINI_ANALYST_TOOLS[0]?.functionDeclarations.map((tool) => tool.name) || [];

  assert.deepEqual(openAiNames, canonicalNames);
  assert.deepEqual(anthropicNames, canonicalNames);
  assert.deepEqual(geminiNames, canonicalNames);
});

test("tool manifests: gemini navigateFocus targetId remains nullable string", () => {
  const navigateFocus = GEMINI_ANALYST_TOOLS[0]?.functionDeclarations.find(
    (tool) => tool.name === "navigateFocus",
  );

  assert.ok(navigateFocus);
  const targetId = navigateFocus.parameters.properties?.targetId;
  assert.ok(targetId);
  assert.equal(targetId?.type, "STRING");
  assert.equal(targetId?.nullable, true);
});
