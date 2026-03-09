import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./paths.ts";

type ParsedEnv = Record<string, string>;
interface LoadLocalEnvOptions {
  overrideProcessEnv?: boolean;
}

const ENV_LINE_PATTERN = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

const parseEnvFile = (raw: string): ParsedEnv => {
  const parsed: ParsedEnv = {};
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = line.match(ENV_LINE_PATTERN);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2];

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value.replace(/\\n/g, "\n");
  }

  return parsed;
};

const getEnvFileLoadOrder = (): string[] => {
  const nodeEnv = process.env.NODE_ENV?.trim() || "development";
  return [
    ".env",
    `.env.${nodeEnv}`,
    ".env.local",
    `.env.${nodeEnv}.local`,
  ];
};

let loaded = false;
const shouldOverrideExistingEnv = (): boolean =>
  (process.env.NODE_ENV?.trim().toLowerCase() || "development") !== "production";

export const loadLocalEnv = (options: LoadLocalEnvOptions = {}): string[] => {
  if (loaded) {
    return [];
  }

  const loadedFiles: string[] = [];
  const mergedFromFiles: ParsedEnv = {};

  for (const relativePath of getEnvFileLoadOrder()) {
    const fullPath = path.join(PROJECT_ROOT, relativePath);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const raw = fs.readFileSync(fullPath, "utf8");
    Object.assign(mergedFromFiles, parseEnvFile(raw));
    loadedFiles.push(relativePath);
  }

  const overrideProcessEnv = options.overrideProcessEnv ?? shouldOverrideExistingEnv();
  for (const [key, value] of Object.entries(mergedFromFiles)) {
    if (overrideProcessEnv || process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  loaded = true;
  return loadedFiles;
};
