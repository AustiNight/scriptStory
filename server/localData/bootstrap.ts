import fs from "node:fs/promises";
import path from "node:path";
import { LOCAL_DATA_DIR } from "../config/paths.ts";

const LOCAL_DATA_FILES = [
  {
    fileName: "mcp-servers.json",
    initialData: {
      schemaVersion: 1,
      servers: [],
    },
  },
  {
    fileName: "mcp-secrets.json",
    initialData: {
      schemaVersion: 1,
      secretsByServerId: {},
    },
  },
  {
    fileName: "defaults.json",
    initialData: {
      schemaVersion: 1,
      providerDefaults: {
        writer: "gemini",
        transcription: "gemini",
      },
      mcpDefaults: {
        policy: "auto-smart",
        enabled: false,
      },
    },
  },
  {
    fileName: "cache-metadata.json",
    initialData: {
      schemaVersion: 1,
      entries: [],
    },
  },
] as const;

export interface LocalDataBootstrapResult {
  localDataDir: string;
  initializedFiles: string[];
}

export const bootstrapLocalData = async (): Promise<LocalDataBootstrapResult> => {
  await fs.mkdir(LOCAL_DATA_DIR, { recursive: true });

  const initializedFiles: string[] = [];

  for (const entry of LOCAL_DATA_FILES) {
    const targetPath = path.join(LOCAL_DATA_DIR, entry.fileName);

    try {
      await fs.access(targetPath);
    } catch {
      await fs.writeFile(targetPath, `${JSON.stringify(entry.initialData, null, 2)}\n`, "utf8");
      initializedFiles.push(entry.fileName);
    }
  }

  return {
    localDataDir: LOCAL_DATA_DIR,
    initializedFiles,
  };
};
