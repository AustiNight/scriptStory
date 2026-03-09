import type { ContextSourceInput, WorkItemInput } from "./types.ts";
import type { NormalizedToolCall } from "./toolCallContracts.ts";

const MAX_SOURCE_CONTENT_CHARS = 15_000;

export const isTextSource = (source: ContextSourceInput): boolean =>
  !source.mimeType || source.mimeType.startsWith("text/") || source.mimeType === "application/json";

export const isImageSource = (source: ContextSourceInput): boolean =>
  Boolean(source.mimeType && source.mimeType.startsWith("image/"));

export const buildKnowledgeBaseText = (textSources: ContextSourceInput[]): string =>
  textSources
    .map((source) => {
      const truncated = source.content.slice(0, MAX_SOURCE_CONTENT_CHARS);
      const suffix =
        source.content.length > MAX_SOURCE_CONTENT_CHARS ? "\n[truncated]" : "";
      return `\n-- SOURCE: ${source.name} (${source.type}) --\n${truncated}${suffix}`;
    })
    .join("\n");

export const buildSummarizePrompt = (transcript: string): string => `
Summarize this meeting transcript in 1 or 2 concise sentences.
Focus on work items, risks, and decisions.

Transcript:
"${transcript}"
`.trim();

export const buildAnalyzePrompt = (
  transcript: string,
  projectContext: string,
  knowledgeBaseText: string,
): string => `
You are an expert Agile Architect and Product Owner (the "Architect").

YOUR MISSION:
Analyze the transcript and generate a comprehensive set of structured work-item tool calls.
You must decompose large requirements into hierarchy (EPIC -> FEATURE -> STORY).

NON-NEGOTIABLE DECOMPOSITION RULES:
1) Do not stop at EPIC level.
2) For each new requirement theme, create:
   - an EPIC
   - one or more FEATURES linked to that EPIC
   - one or more STORIES linked to each FEATURE
3) Emit parent items before children and link with tempId/parentTempId in the same batch.
4) If you create an EPIC, you must also create at least one FEATURE and one STORY.

ATOMIC STORY DEFINITION (REQUIRED):
A STORY is atomic only when it is the smallest valuable slice that:
- includes user-visible UI behavior,
- includes service/API behavior,
- includes data/persistence behavior,
- and is independently testable by an end user in the UI.
If a story is not atomic, split it into smaller stories.

CRITICAL: DISCRIMINATE EXISTING vs NEW:
1) Image naming clues:
   - UAT/PROD/LIVE/DEMO implies existing features.
   - PROTOTYPE/MOCKUP/DESIGN implies new features.
2) Transcript language clues:
   - "Here we have", "As you can see", "This is working" implies demo.
   - "We need to", "It should", "I want" implies new requirement.
3) Action rules:
   - Existing/demoed features: create STORY with criteria met=true, then create TASK/BUG follow-ups as needed.
   - New features: create EPIC/FEATURE/STORY with met=false criteria.
   - Do not create a new to-do STORY for capability already shown as working in UAT/LIVE.

VALIDATION RULES:
- EPIC/FEATURE/STORY require: title, description, criteria[] with { text, met }.
- Criteria text for EPIC/FEATURE/STORY must be Given/When/Then style.
- For EPIC/FEATURE/STORY, provide 3-5 acceptance criteria. Do not return only one criterion unless the transcript is explicitly tiny and single-scope.
- Criteria coverage must include:
  - happy path user outcome,
  - authorization/role or security behavior,
  - validation/error or edge-case behavior,
  - and where relevant data persistence/readback behavior.
- Format each criterion as multiline Gherkin with line breaks:
  - line 1 starts with Given ...
  - line 2 starts with When ...
  - line 3 starts with Then ...
  - optional extra lines can start with And ... or But ...
- BUG requires: title, description, stepsToReproduce[], expectedResult, actualResult.
- TASK requires: title and description.
- Use tempId/parentTempId for same-batch hierarchy links.

OUTPUT RULES:
- Return tool calls only.
- Prefer createWorkItem/updateWorkItem calls over narration.
- If KNOWLEDGE BASE or BOARD CONTEXT is provided, use it to make titles, descriptions, and criteria more specific (domain language, constraints, roles, terminology).
- Do not ignore context: incorporate concrete details from relevant context sources whenever available.

EXISTING BOARD CONTEXT:
${projectContext || "No active board context provided."}

KNOWLEDGE BASE:
${knowledgeBaseText || "No text documentation provided."}

TRANSCRIPT:
"${transcript}"
`.trim();

export const buildDecompositionFollowUpPrompt = (
  transcript: string,
  projectContext: string,
  existingCalls: NormalizedToolCall[],
): string => `
Your previous output under-decomposed the backlog.
Create ADDITIONAL work-item tool calls to complete decomposition.

MANDATORY:
- Ensure every EPIC has at least one FEATURE and at least one STORY.
- Ensure stories are atomic vertical slices with UI + service/API + data/persistence and end-user testability.
- Emit only missing decomposition items. Do not duplicate existing items.
- Use parentTempId/tempId linking and parent-before-child ordering.
- Use Given/When/Then criteria format for EPIC/FEATURE/STORY.
- For newly created EPIC/FEATURE/STORY items, include 3-5 acceptance criteria with coverage of happy path, authorization/security, and validation/error behavior.
- Use BOARD CONTEXT and KNOWLEDGE BASE details to enrich wording and constraints.

EXISTING TOOL CALLS (already produced):
${JSON.stringify(existingCalls, null, 2)}

EXISTING BOARD CONTEXT:
${projectContext || "No active board context provided."}

TRANSCRIPT:
"${transcript}"
`.trim();

export const buildRefinePrompt = (
  rawTranscript: string,
  fieldName: string,
  currentItem: WorkItemInput,
  projectContext: string,
): string => `
Refine the ${fieldName} field for this ${currentItem.type}.

Current Title: ${currentItem.title}
Current Description: ${currentItem.description}
Project Context:
${projectContext || "No additional context."}

Transcript Input:
"${rawTranscript}"

Return only the refined field text.
`.trim();

const readCreateWorkItemType = (call: NormalizedToolCall): string | null => {
  if (call.name !== "createWorkItem") {
    return null;
  }

  const rawType = call.args.type;
  if (typeof rawType !== "string") {
    return null;
  }

  const trimmed = rawType.trim().toUpperCase();
  return trimmed.length > 0 ? trimmed : null;
};

export const needsHierarchicalDecompositionPass = (
  calls: NormalizedToolCall[],
): boolean => {
  const createCalls = calls.filter((call) => call.name === "createWorkItem");
  if (createCalls.length === 0) {
    return false;
  }

  const types = new Set(
    createCalls
      .map((call) => readCreateWorkItemType(call))
      .filter((type): type is string => Boolean(type)),
  );

  if (!types.has("EPIC")) {
    return false;
  }

  return !types.has("FEATURE") || !types.has("STORY");
};

const buildCreateDedupKey = (call: NormalizedToolCall): string => {
  const type = typeof call.args.type === "string" ? call.args.type.trim().toUpperCase() : "";
  const title = typeof call.args.title === "string" ? call.args.title.trim().toLowerCase() : "";
  const parentTempId =
    typeof call.args.parentTempId === "string" ? call.args.parentTempId.trim().toLowerCase() : "";
  const parentId =
    typeof call.args.parentId === "string" ? call.args.parentId.trim().toLowerCase() : "";
  return `create|${type}|${title}|${parentTempId}|${parentId}`;
};

export const mergeNormalizedToolCalls = (
  primary: NormalizedToolCall[],
  secondary: NormalizedToolCall[],
): NormalizedToolCall[] => {
  const merged = [...primary];
  const createKeys = new Set(
    primary
      .filter((call) => call.name === "createWorkItem")
      .map((call) => buildCreateDedupKey(call)),
  );
  const genericKeys = new Set(primary.map((call) => JSON.stringify(call)));

  for (const call of secondary) {
    if (call.name === "createWorkItem") {
      const dedupKey = buildCreateDedupKey(call);
      if (createKeys.has(dedupKey)) {
        continue;
      }
      createKeys.add(dedupKey);
      merged.push(call);
      continue;
    }

    const genericKey = JSON.stringify(call);
    if (genericKeys.has(genericKey)) {
      continue;
    }
    genericKeys.add(genericKey);
    merged.push(call);
  }

  return merged;
};
