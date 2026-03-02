export type NormalizedToolCallName =
  | "createWorkItem"
  | "updateWorkItem"
  | "deleteWorkItem"
  | "navigateFocus"
  | "switchMode"
  | "filterWorkItems"
  | "setVisualMode";

export interface NormalizedToolCall {
  name: NormalizedToolCallName;
  args: Record<string, unknown>;
}

interface RawToolCall {
  name: string;
  arguments: unknown;
}

interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

interface OpenAiFunctionTool {
  type: "function";
  name: NormalizedToolCallName;
  description: string;
  strict: boolean;
  parameters: JsonSchema;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const parseArguments = (value: unknown): Record<string, unknown> | null => {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return asRecord(value);
};

const readRequiredString = (
  source: Record<string, unknown>,
  key: string,
): string | null => {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const readOptionalString = (
  source: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const readOptionalBoolean = (
  source: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
};

const readOptionalFiniteNumber = (
  source: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const readOptionalStringArray = (
  source: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const value = source[key];
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return normalized.length > 0 ? normalized : undefined;
};

const normalizeCriteria = (
  source: Record<string, unknown>,
): Array<{ text: string; met: boolean }> | undefined => {
  const value = source.criteria;
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) {
        return null;
      }

      const text = readRequiredString(record, "text");
      const met = readOptionalBoolean(record, "met");
      if (!text || met === undefined) {
        return null;
      }

      return { text, met };
    })
    .filter((entry): entry is { text: string; met: boolean } => Boolean(entry));

  return normalized.length > 0 ? normalized : undefined;
};

const normalizeCreateWorkItem = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const type = readRequiredString(args, "type");
  const title = readRequiredString(args, "title");
  const description = readRequiredString(args, "description");

  if (!type || !title || !description) {
    return null;
  }

  return {
    type,
    title,
    description,
    ...(readOptionalString(args, "parentId") ? { parentId: readOptionalString(args, "parentId") } : {}),
    ...(readOptionalString(args, "priority") ? { priority: readOptionalString(args, "priority") } : {}),
    ...(readOptionalString(args, "risk") ? { risk: readOptionalString(args, "risk") } : {}),
    ...(normalizeCriteria(args) ? { criteria: normalizeCriteria(args) } : {}),
    ...(readOptionalStringArray(args, "stepsToReproduce")
      ? { stepsToReproduce: readOptionalStringArray(args, "stepsToReproduce") }
      : {}),
    ...(readOptionalString(args, "expectedResult")
      ? { expectedResult: readOptionalString(args, "expectedResult") }
      : {}),
    ...(readOptionalString(args, "actualResult")
      ? { actualResult: readOptionalString(args, "actualResult") }
      : {}),
    ...(readOptionalString(args, "tempId") ? { tempId: readOptionalString(args, "tempId") } : {}),
    ...(readOptionalString(args, "parentTempId")
      ? { parentTempId: readOptionalString(args, "parentTempId") }
      : {}),
    ...(readOptionalStringArray(args, "relatedTempIds")
      ? { relatedTempIds: readOptionalStringArray(args, "relatedTempIds") }
      : {}),
  };
};

const normalizeUpdateWorkItem = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const id = readRequiredString(args, "id");
  if (!id) {
    return null;
  }

  return {
    id,
    ...(readOptionalString(args, "title") ? { title: readOptionalString(args, "title") } : {}),
    ...(readOptionalString(args, "description")
      ? { description: readOptionalString(args, "description") }
      : {}),
    ...(readOptionalString(args, "priority")
      ? { priority: readOptionalString(args, "priority") }
      : {}),
    ...(readOptionalString(args, "risk") ? { risk: readOptionalString(args, "risk") } : {}),
    ...(readOptionalFiniteNumber(args, "storyPoints") !== undefined
      ? { storyPoints: readOptionalFiniteNumber(args, "storyPoints") }
      : {}),
    ...(readOptionalString(args, "addCriteria")
      ? { addCriteria: readOptionalString(args, "addCriteria") }
      : {}),
    ...(readOptionalString(args, "addStep")
      ? { addStep: readOptionalString(args, "addStep") }
      : {}),
    ...(readOptionalString(args, "expectedResult")
      ? { expectedResult: readOptionalString(args, "expectedResult") }
      : {}),
    ...(readOptionalString(args, "actualResult")
      ? { actualResult: readOptionalString(args, "actualResult") }
      : {}),
    ...(readOptionalString(args, "parentId") ? { parentId: readOptionalString(args, "parentId") } : {}),
    ...(readOptionalString(args, "addRelatedId")
      ? { addRelatedId: readOptionalString(args, "addRelatedId") }
      : {}),
  };
};

const normalizeDeleteWorkItem = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const id = readRequiredString(args, "id");
  if (!id) {
    return null;
  }

  return { id };
};

const normalizeNavigateFocus = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const targetIdValue = args.targetId;
  const targetId =
    targetIdValue === null
      ? null
      : typeof targetIdValue === "string" && targetIdValue.trim()
        ? targetIdValue.trim()
        : null;

  if (targetIdValue !== null && targetId === null) {
    return null;
  }

  return {
    targetId,
    ...(readOptionalString(args, "targetField")
      ? { targetField: readOptionalString(args, "targetField") }
      : {}),
  };
};

const normalizeSwitchMode = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const mode = readRequiredString(args, "mode");
  if (!mode) {
    return null;
  }

  return { mode };
};

const normalizeFilterWorkItems = (args: Record<string, unknown>): Record<string, unknown> | null => {
  return {
    ...(readOptionalString(args, "type") ? { type: readOptionalString(args, "type") } : {}),
    ...(readOptionalString(args, "priority")
      ? { priority: readOptionalString(args, "priority") }
      : {}),
    ...(readOptionalFiniteNumber(args, "storyPoints") !== undefined
      ? { storyPoints: readOptionalFiniteNumber(args, "storyPoints") }
      : {}),
    ...(readOptionalString(args, "searchQuery")
      ? { searchQuery: readOptionalString(args, "searchQuery") }
      : {}),
    ...(readOptionalBoolean(args, "clear") !== undefined
      ? { clear: readOptionalBoolean(args, "clear") }
      : {}),
  };
};

const normalizeSetVisualMode = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const enableBlur = readOptionalBoolean(args, "enableBlur");
  if (enableBlur === undefined) {
    return null;
  }

  return { enableBlur };
};

const TOOL_NORMALIZERS: Record<
  NormalizedToolCallName,
  (args: Record<string, unknown>) => Record<string, unknown> | null
> = {
  createWorkItem: normalizeCreateWorkItem,
  updateWorkItem: normalizeUpdateWorkItem,
  deleteWorkItem: normalizeDeleteWorkItem,
  navigateFocus: normalizeNavigateFocus,
  switchMode: normalizeSwitchMode,
  filterWorkItems: normalizeFilterWorkItems,
  setVisualMode: normalizeSetVisualMode,
};

export const normalizeToolCall = (
  callName: string,
  rawArguments: unknown,
): NormalizedToolCall | null => {
  if (!(callName in TOOL_NORMALIZERS)) {
    return null;
  }

  const normalizer = TOOL_NORMALIZERS[callName as NormalizedToolCallName];
  const parsed = parseArguments(rawArguments);
  if (!parsed) {
    return null;
  }

  const normalizedArgs = normalizer(parsed);
  if (!normalizedArgs) {
    return null;
  }

  return {
    name: callName as NormalizedToolCallName,
    args: normalizedArgs,
  };
};

export const normalizeToolCalls = (calls: RawToolCall[]): NormalizedToolCall[] =>
  calls
    .map((call) => normalizeToolCall(call.name, call.arguments))
    .filter((call): call is NormalizedToolCall => Boolean(call));

export const OPENAI_ANALYST_TOOLS: OpenAiFunctionTool[] = [
  {
    type: "function",
    name: "createWorkItem",
    description:
      "Create a new work item. Use criteria for EPIC/FEATURE/STORY and bug reproduction fields for BUG.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["type", "title", "description"],
      properties: {
        type: { type: "string", description: "EPIC, FEATURE, STORY, TASK, or BUG." },
        title: { type: "string", description: "Short summary." },
        description: { type: "string", description: "Detailed description." },
        parentId: { type: "string", description: "Parent ID (optional)." },
        priority: { type: "string", description: "Optional Priority." },
        risk: { type: "string", description: "Optional Risk." },
        criteria: {
          type: "array",
          description: "Acceptance Criteria. Mandatory for EPIC, FEATURE, STORY.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text", "met"],
            properties: {
              text: { type: "string", description: "The Gherkin criteria text." },
              met: { type: "boolean", description: "True if requirement is already observed in UAT/demo." },
            },
          },
        },
        stepsToReproduce: {
          type: "array",
          description: "Steps to reproduce. Mandatory for BUG.",
          items: { type: "string" },
        },
        expectedResult: { type: "string", description: "Expected result. Mandatory for BUG." },
        actualResult: { type: "string", description: "Actual result. Mandatory for BUG." },
        tempId: { type: "string", description: "Transactional temporary ID for same-batch linking." },
        parentTempId: { type: "string", description: "Parent temp ID for same-batch linking." },
        relatedTempIds: {
          type: "array",
          items: { type: "string" },
          description: "List of sibling/dependency temp IDs.",
        },
      },
    },
  },
  {
    type: "function",
    name: "updateWorkItem",
    description: "Update an existing work item.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "Work item ID." },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string" },
        risk: { type: "string" },
        storyPoints: { type: "number" },
        addCriteria: { type: "string", description: "Add a criteria line." },
        addStep: { type: "string", description: "Add a bug reproduction step." },
        expectedResult: { type: "string" },
        actualResult: { type: "string" },
        parentId: { type: "string" },
        addRelatedId: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "deleteWorkItem",
    description: "Delete a specific work item permanently.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: { type: "string", description: "ID of the item to delete." },
      },
    },
  },
  {
    type: "function",
    name: "navigateFocus",
    description: "Focus on an item, field, or zoom out.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["targetId"],
      properties: {
        targetId: {
          anyOf: [{ type: "string" }, { type: "null" }],
          description: "ID of item to focus, or null/\"board\" to zoom out.",
        },
        targetField: { type: "string", description: "title, description, criteria, meta, or risk" },
      },
    },
  },
  {
    type: "function",
    name: "switchMode",
    description: "Switch application mode between MEETING and GROOMING.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string" },
      },
    },
  },
  {
    type: "function",
    name: "filterWorkItems",
    description: "Filter or sort visible work items.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string" },
        priority: { type: "string" },
        storyPoints: { type: "number" },
        searchQuery: { type: "string" },
        clear: { type: "boolean" },
      },
    },
  },
  {
    type: "function",
    name: "setVisualMode",
    description: "Control visual settings like background blur.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["enableBlur"],
      properties: {
        enableBlur: { type: "boolean" },
      },
    },
  },
];
