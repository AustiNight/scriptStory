import assert from "node:assert/strict";
import test from "node:test";
import { GeminiWriter } from "./geminiWriter.ts";

test("GeminiWriter analyze: decomposition follow-up pass expands epic into feature/story when missing", async () => {
  let requestCount = 0;
  const observedPrompts: string[] = [];

  const writer = new GeminiWriter("test-api-key");
  const writerRecord = writer as unknown as {
    ai: {
      models: {
        generateContent: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };
  };

  writerRecord.ai = {
    models: {
      generateContent: async (payload: Record<string, unknown>) => {
        requestCount += 1;

        const contents = Array.isArray(payload.contents)
          ? (payload.contents as Array<Record<string, unknown>>)
          : [];
        const firstContent = contents[0] || {};
        const parts = Array.isArray(firstContent.parts)
          ? (firstContent.parts as Array<Record<string, unknown>>)
          : [];
        const prompt = typeof parts[0]?.text === "string" ? parts[0].text : "";
        if (prompt) {
          observedPrompts.push(prompt);
        }

        if (requestCount === 1) {
          return {
            functionCalls: [
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
            ],
          };
        }

        return {
          functionCalls: [
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
          ],
        };
      },
    },
  };

  const toolCalls = await writer.analyzeMeetingTranscript(
    "We need to improve onboarding for new users and break it into implementation slices.",
    "",
    [],
  );

  const createTypes = toolCalls
    .filter((call) => call.name === "createWorkItem")
    .map((call) => String(call.args.type || "").toUpperCase());

  assert.equal(requestCount, 2);
  assert.ok(createTypes.includes("EPIC"));
  assert.ok(createTypes.includes("FEATURE"));
  assert.ok(createTypes.includes("STORY"));
  assert.equal(observedPrompts.length, 2);
  assert.equal(observedPrompts[1].includes("under-decomposed"), true);
});
