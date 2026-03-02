import {
  GoogleGenAI,
  Type,
} from "@google/genai";
import type { FunctionDeclaration, Tool } from "@google/genai";
import {
  PROVIDER_CAPABILITY_MATRIX,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";

const createWorkItemFunc: FunctionDeclaration = {
  name: "createWorkItem",
  description: "Create a new work item. STRICT validation rules apply based on \"type\".",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, description: "EPIC, FEATURE, STORY, TASK, or BUG." },
      title: { type: Type.STRING, description: "Short summary." },
      description: { type: Type.STRING, description: "Detailed description." },
      parentId: { type: Type.STRING, description: "Parent ID (optional)." },
      priority: { type: Type.STRING, description: "Optional Priority." },
      risk: { type: Type.STRING, description: "Optional Risk." },
      criteria: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: "The Gherkin criteria text." },
            met: {
              type: Type.BOOLEAN,
              description: "Set to true if this requirement is already observed as working/demoed in UAT.",
            },
          },
        },
        description: "Acceptance Criteria. MANDATORY for EPIC, FEATURE, STORY.",
      },
      stepsToReproduce: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Numbered steps to reproduce the issue. MANDATORY for BUG.",
      },
      expectedResult: { type: Type.STRING, description: "What should have happened. MANDATORY for BUG." },
      actualResult: { type: Type.STRING, description: "What actually happened. MANDATORY for BUG." },
      tempId: { type: Type.STRING, description: "Transactional ID (e.g. \"E1\") for batch linking." },
      parentTempId: { type: Type.STRING, description: "Parent Transactional ID (e.g. \"E1\") if parent created in same batch." },
      relatedTempIds: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "List of tempIds for sibling items (e.g. overlapping functionality).",
      },
    },
    required: ["type", "title", "description"],
  },
};

const updateWorkItemFunc: FunctionDeclaration = {
  name: "updateWorkItem",
  description: "Update an existing work item.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "UUID of the item." },
      title: { type: Type.STRING },
      description: { type: Type.STRING },
      priority: { type: Type.STRING },
      risk: { type: Type.STRING },
      addCriteria: { type: Type.STRING, description: "Add Gherkin criteria." },
      addStep: { type: Type.STRING, description: "Add a step to reproduce." },
      expectedResult: { type: Type.STRING },
      actualResult: { type: Type.STRING },
      parentId: { type: Type.STRING },
      addRelatedId: { type: Type.STRING, description: "ID of a related item to link (non-hierarchical)." },
    },
    required: ["id"],
  },
};

const deleteWorkItemFunc: FunctionDeclaration = {
  name: "deleteWorkItem",
  description: "Delete a specific work item permanently.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: "UUID of the item to delete" },
    },
    required: ["id"],
  },
};

const navigateFocusFunc: FunctionDeclaration = {
  name: "navigateFocus",
  description: "Focus on a specific item, a specific field within an item, or zoom out.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetId: {
        type: Type.STRING,
        description: "ID of the item to focus on. Pass \"null\" or \"board\" to zoom out.",
      },
      targetField: {
        type: Type.STRING,
        description: "Optional field to focus: \"title\", \"description\", \"criteria\", \"meta\", \"risk\"",
      },
    },
    required: ["targetId"],
  },
};

const switchModeFunc: FunctionDeclaration = {
  name: "switchMode",
  description: "Switch the application view mode between MEETING and GROOMING.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      mode: { type: Type.STRING, description: "Target mode: MEETING or GROOMING" },
    },
    required: ["mode"],
  },
};

const filterWorkItemsFunc: FunctionDeclaration = {
  name: "filterWorkItems",
  description: "Filter or sort the list of visible work items.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, description: "WorkItemType to filter by (e.g., BUG, STORY)" },
      priority: { type: Type.STRING, description: "Priority string" },
      searchQuery: {
        type: Type.STRING,
        description: "Text query to filter or sort items by relevance (e.g. \"login\", \"payment\")",
      },
      clear: { type: Type.BOOLEAN, description: "Set to true to clear all filters" },
    },
  },
};

const setVisualModeFunc: FunctionDeclaration = {
  name: "setVisualMode",
  description: "Control visual settings like background blur.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      enableBlur: { type: Type.BOOLEAN, description: "True to enable background blur, false to disable it." },
    },
    required: ["enableBlur"],
  },
};

const TOOLS_ANALYST: Tool[] = [
  {
    functionDeclarations: [
      createWorkItemFunc,
      updateWorkItemFunc,
      deleteWorkItemFunc,
      navigateFocusFunc,
      switchModeFunc,
      filterWorkItemsFunc,
      setVisualModeFunc,
    ],
  },
];

const isTextSource = (source: ContextSourceInput): boolean =>
  !source.mimeType || source.mimeType.startsWith("text/") || source.mimeType === "application/json";

const isImageSource = (source: ContextSourceInput): boolean =>
  Boolean(source.mimeType && source.mimeType.startsWith("image/"));

export class GeminiWriter
  implements WriterProvider<ContextSourceInput, WorkItemInput, any>
{
  private readonly ai: GoogleGenAI;
  public readonly id = "gemini" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.gemini;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  public async summarizeTranscript(transcript: string, _providerConfig?: unknown): Promise<string> {
    const prompt = `
      Summarize the following meeting transcript into 1 or 2 concise sentences.
      Focus on the key work items discussed or decisions made.

      Transcript: "${transcript}"
    `;

    const response = await this.ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    return response.text.trim();
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSourceInput[],
    _providerConfig?: unknown,
  ): Promise<any[]> {
    if (!transcript.trim()) {
      return [];
    }

    const enabledSources = contextSources.filter((source) => source.enabled !== false);
    const textSources = enabledSources.filter(isTextSource);
    const imageSources = enabledSources.filter(isImageSource);

    const knowledgeBaseText = textSources
      .map(
        (src) =>
          `\n-- SOURCE: ${src.name} (${src.type}) --\n${src.content.substring(0, 15000)}...`,
      )
      .join("\n");

    const textPrompt = `
        You are an expert Agile Architect and Product Owner (The "Architect").

        **YOUR MISSION**:
        Analyze the "TRANSCRIPT SEGMENT" below and generate a comprehensive set of Work Items.
        You MUST break down large requirements into a proper hierarchy (Epic -> Feature -> Story).

        ---------------------------------------------------------
        **CRITICAL: DISCRIMINATE BETWEEN EXISTING vs. NEW**:
        You must determine if a topic is a *Demo of existing software* or a *Discussion of new requirements*.

        1. **Check Image Sources**:
           - **'UAT', 'PROD', 'LIVE', 'DEMO'** in filenames: This implies the feature **ALREADY EXISTS**.
           - **'PROTOTYPE', 'MOCKUP', 'DESIGN'** in filenames: This implies the feature is **NEW / TO BE BUILT**.

        2. **Check Transcript Context**:
           - Words like "Here we have...", "As you can see...", "This is working..." indicate a **DEMO**.
           - Words like "We need to...", "It should...", "I want..." indicate a **REQUIREMENT**.

        3. **Action Rules**:
           - **EXISTING FEATURE (Demo)**:
             - If a feature is demoed and working, create a User Story but **MARK ALL CRITERIA AS MET** (met: true).
             - Use this to acknowledge the feature exists and then create **TASKS** or **BUGS** for any follow-up discussed.
             - **DO NOT** create a "To Do" User Story for something already visible in a UAT site.

           - **NEW FEATURE (Prototype/Discussion)**:
             - Create standard **EPIC / FEATURE / STORY** items with met: false.

        ---------------------------------------------------------
        **CRITICAL: DATA VALIDATION PROTOCOLS**:

        1. **IF TYPE = EPIC, FEATURE, or STORY**:
           - **Title**: Required.
           - **Description**: Required.
           - **Acceptance Criteria**: **MANDATORY**. Provide objects with 'text' and 'met' (boolean).

        2. **IF TYPE = BUG**:
           - **Title**: Required.
           - **Description**: Required.
           - **Steps To Reproduce**: **MANDATORY**.
           - **Expected Result**: **MANDATORY**.
           - **Actual Result**: **MANDATORY**.

        3. **IF TYPE = TASK**:
           - **Title**: Required.
           - **Description**: Required.

        ---------------------------------------------------------
        **HIERARCHY & LINKING RULES**:
           - Link using 'tempId' and 'parentTempId'.

        **KNOWLEDGE BASE UTILIZATION**:
           - Use provided documentation and images for technical specifics.
        ---------------------------------------------------------

        /// EXISTING BOARD CONTEXT (Active Items) ///
        ${projectContext}

        /// KNOWLEDGE BASE (Reference Material) ///
        ${knowledgeBaseText || "No text documentation provided."}

        /// TRANSCRIPT SEGMENT (The Requirement Source) ///
        "${transcript}"
     `;

    const parts: any[] = [{ text: textPrompt }];
    for (const image of imageSources) {
      if (image.mimeType && image.content) {
        parts.push({ text: `\n[IMAGE CONTEXT: Filename="${image.name}"]\n` });
        parts.push({
          inlineData: {
            mimeType: image.mimeType,
            data: image.content,
          },
        });
      }
    }

    const response = await this.ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: [{ role: "user", parts }],
      config: { tools: TOOLS_ANALYST },
    });

    return response.functionCalls || [];
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItemInput,
    projectContext: string,
    _providerConfig?: unknown,
  ): Promise<string> {
    const prompt = `
      Refine this field content. Field: ${fieldName}. Item: ${currentItem.type}.
      Context: ${projectContext}
      Input: "${rawTranscript}"
    `;

    const response = await this.ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    return response.text.trim();
  }
}
