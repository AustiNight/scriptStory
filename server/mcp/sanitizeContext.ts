export interface McpSourceTag {
  serverId: string;
  serverName?: string;
  resource?: string;
}

export interface McpRawContextPayload {
  source: McpSourceTag;
  content: unknown;
}

export interface SanitizedMcpContextSnippet {
  source: McpSourceTag;
  text: string;
  truncated: boolean;
}

const DEFAULT_MAX_CHARS = 4_000;
const MARKUP_PATTERN = /<[^>]*>/g;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/g;
const WHITESPACE_PATTERN = /\s+/g;

const toText = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value === null || value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const normalizeText = (input: string): string => {
  return input
    .replace(MARKUP_PATTERN, " ")
    .replace(CONTROL_CHAR_PATTERN, " ")
    .replace(WHITESPACE_PATTERN, " ")
    .trim();
};

export function sanitizeMcpContext(
  payload: McpRawContextPayload,
  maxChars = DEFAULT_MAX_CHARS,
): SanitizedMcpContextSnippet {
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_MAX_CHARS;
  const normalized = normalizeText(toText(payload.content));
  const bounded = normalized.slice(0, budget);

  return {
    source: payload.source,
    text: bounded,
    truncated: normalized.length > bounded.length,
  };
}
