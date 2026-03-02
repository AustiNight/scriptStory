export interface FeatureFlags {
  ENABLE_OPENAI_WRITER: boolean;
  ENABLE_ANTHROPIC_WRITER: boolean;
  ENABLE_MCP_CONTEXT: boolean;
}

const readBooleanFlag = (value: string | undefined, fallback = false): boolean => {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  return value.trim().toLowerCase() === "true";
};

export const featureFlags: FeatureFlags = Object.freeze({
  ENABLE_OPENAI_WRITER: readBooleanFlag(process.env.ENABLE_OPENAI_WRITER, false),
  ENABLE_ANTHROPIC_WRITER: readBooleanFlag(process.env.ENABLE_ANTHROPIC_WRITER, false),
  ENABLE_MCP_CONTEXT: readBooleanFlag(process.env.ENABLE_MCP_CONTEXT, false),
});
