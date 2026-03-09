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
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: Array<string | number | boolean | null>;
}

interface OpenAiFunctionTool {
  type: "function";
  name: NormalizedToolCallName;
  description: string;
  strict: boolean;
  parameters: JsonSchema;
}

export interface AnthropicTool {
  name: NormalizedToolCallName;
  description: string;
  input_schema: JsonSchema;
}

interface GeminiSchema {
  type?: string;
  description?: string;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  nullable?: boolean;
  enum?: Array<string | number | boolean>;
}

interface GeminiFunctionDeclaration {
  name: NormalizedToolCallName;
  description: string;
  parameters: GeminiSchema;
}

export interface GeminiTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

interface AnalystToolDefinition {
  name: NormalizedToolCallName;
  description: string;
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

const HIERARCHICAL_WORK_ITEM_TYPES = new Set(["EPIC", "FEATURE", "STORY"]);

const isHierarchicalWorkItemType = (type: string): boolean =>
  HIERARCHICAL_WORK_ITEM_TYPES.has(type.trim().toUpperCase());

const toGherkinCriterionText = (value: string): string => {
  const cleaned = value
    .trim()
    .replace(/^[\-\d.)\s]+/, "")
    .replace(/\s+/g, " ");

  const ensureTrailingPeriod = (text: string): string => {
    const trimmed = text.trim();
    if (!trimmed) {
      return trimmed;
    }
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  };

  if (!cleaned) {
    return "Given the user is in the relevant context, when the behavior is executed, then the expected result is visible in the UI.";
  }

  const hasGiven = /\bgiven\b/i.test(cleaned);
  const hasWhen = /\bwhen\b/i.test(cleaned);
  const hasThen = /\bthen\b/i.test(cleaned);
  if (hasGiven && hasWhen && hasThen) {
    return ensureTrailingPeriod(cleaned.replace(/^\s*given\b/i, "Given"));
  }

  const startsWithWhen = /^\s*when\b/i.test(cleaned);
  const startsWithThen = /^\s*then\b/i.test(cleaned);
  const startsWithGiven = /^\s*given\b/i.test(cleaned);
  if (startsWithGiven || startsWithWhen || startsWithThen) {
    return ensureTrailingPeriod(`Given the user is in the relevant context, ${cleaned
      .replace(/^\s*given\b/i, "")
      .replace(/^\s*when\b/i, "when")
      .replace(/^\s*then\b/i, "then")
      .trim()}`);
  }

  const clause = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  return ensureTrailingPeriod(
    `Given the user is in the relevant context, when ${clause}, then the expected result is visible in the UI.`,
  );
};

const ensureHierarchicalCriteria = (
  criteria: Array<{ text: string; met: boolean }> | undefined,
  title: string,
  description: string,
): Array<{ text: string; met: boolean }> => {
  if (criteria && criteria.length > 0) {
    return criteria.map((criterion) => ({
      ...criterion,
      text: toGherkinCriterionText(criterion.text),
    }));
  }

  const seed = description.trim() || title.trim() || "the requested capability";
  return [
    {
      text: toGherkinCriterionText(seed),
      met: false,
    },
  ];
};

const normalizeCreateWorkItem = (args: Record<string, unknown>): Record<string, unknown> | null => {
  const type = readRequiredString(args, "type");
  const title = readRequiredString(args, "title");
  const description = readRequiredString(args, "description");

  if (!type || !title || !description) {
    return null;
  }

  const normalizedType = type.toUpperCase();
  const normalizedCriteria = normalizeCriteria(args);
  const finalCriteria = isHierarchicalWorkItemType(normalizedType)
    ? ensureHierarchicalCriteria(normalizedCriteria, title, description)
    : normalizedCriteria;

  return {
    type: normalizedType,
    title,
    description,
    ...(readOptionalString(args, "parentId") ? { parentId: readOptionalString(args, "parentId") } : {}),
    ...(readOptionalString(args, "priority") ? { priority: readOptionalString(args, "priority") } : {}),
    ...(readOptionalString(args, "risk") ? { risk: readOptionalString(args, "risk") } : {}),
    ...(finalCriteria ? { criteria: finalCriteria } : {}),
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
      ? { addCriteria: toGherkinCriterionText(readOptionalString(args, "addCriteria") || "") }
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

export const ANALYST_TOOL_DEFINITIONS: AnalystToolDefinition[] = [
  {
    name: "createWorkItem",
    description:
      "Create a new work item. For EPIC/FEATURE/STORY include Given/When/Then acceptance criteria. For BUG include reproduction fields.",
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
          description: "Acceptance Criteria in Given/When/Then format. Mandatory for EPIC, FEATURE, STORY.",
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
    name: "updateWorkItem",
    description: "Update an existing work item.",
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
    name: "deleteWorkItem",
    description: "Delete a specific work item permanently.",
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
    name: "navigateFocus",
    description: "Focus on an item, field, or zoom out.",
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
    name: "switchMode",
    description: "Switch application mode between MEETING and GROOMING.",
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
    name: "filterWorkItems",
    description: "Filter or sort visible work items.",
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
    name: "setVisualMode",
    description: "Control visual settings like background blur.",
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

export const OPENAI_ANALYST_TOOLS: OpenAiFunctionTool[] = ANALYST_TOOL_DEFINITIONS.map(
  ({ name, description, parameters }) => ({
    type: "function",
    name,
    description,
    strict: false,
    parameters,
  }),
);

export const ANTHROPIC_ANALYST_TOOLS: AnthropicTool[] = ANALYST_TOOL_DEFINITIONS.map(
  ({ name, description, parameters }) => ({
    name,
    description,
    input_schema: parameters,
  }),
);

const JSON_TO_GEMINI_TYPE: Record<string, string> = {
  object: "OBJECT",
  string: "STRING",
  number: "NUMBER",
  integer: "NUMBER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  null: "NULL",
};

const asGeminiType = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }

  const mapped = JSON_TO_GEMINI_TYPE[value.toLowerCase()];
  return mapped || null;
};

const normalizeGeminiSchema = (schema: JsonSchema): GeminiSchema => {
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const nullable = schema.anyOf.some((entry) => String(entry.type || "").toLowerCase() === "null");
    const preferred =
      schema.anyOf.find((entry) => String(entry.type || "").toLowerCase() !== "null") ||
      schema.anyOf[0];
    const converted = normalizeGeminiSchema(preferred);
    return nullable ? { ...converted, nullable: true } : converted;
  }

  const type = asGeminiType(schema.type) || "OBJECT";
  const normalized: GeminiSchema = {
    type,
    ...(typeof schema.description === "string" ? { description: schema.description } : {}),
    ...(Array.isArray(schema.enum)
      ? {
          enum: schema.enum.filter(
            (value): value is string | number | boolean =>
              typeof value === "string" || typeof value === "number" || typeof value === "boolean",
          ),
        }
      : {}),
  };

  if (type === "OBJECT") {
    const properties = schema.properties || {};
    normalized.properties = Object.fromEntries(
      Object.entries(properties).map(([propertyName, propertySchema]) => [
        propertyName,
        normalizeGeminiSchema(propertySchema),
      ]),
    );
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      normalized.required = [...schema.required];
    }
  }

  if (type === "ARRAY") {
    normalized.items = schema.items ? normalizeGeminiSchema(schema.items) : { type: "STRING" };
  }

  return normalized;
};

export const GEMINI_ANALYST_TOOLS: GeminiTool[] = [
  {
    functionDeclarations: ANALYST_TOOL_DEFINITIONS.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters: normalizeGeminiSchema(parameters),
    })),
  },
];
