import { MCP_REGISTRY_SCHEMA_VERSION, MCP_SECRETS_SCHEMA_VERSION } from "../mcp/schema.ts";
import { MVP_LOCAL_SINGLE_USER_SCOPE } from "../config/configOwnership.ts";
import { LOCAL_DATA_DIR } from "../config/paths.ts";
import { LOCAL_DATA_DOCUMENTS } from "./documents.ts";
import { FileLocalDataStorageAdapter } from "./storage.ts";

const LOCAL_DATA_FILES = [
  {
    documentName: LOCAL_DATA_DOCUMENTS.mcpRegistry,
    initialData: {
      schemaVersion: MCP_REGISTRY_SCHEMA_VERSION,
      servers: [],
    },
  },
  {
    documentName: LOCAL_DATA_DOCUMENTS.mcpSecrets,
    initialData: {
      schemaVersion: MCP_SECRETS_SCHEMA_VERSION,
      secretsByServerId: {},
    },
  },
  {
    documentName: LOCAL_DATA_DOCUMENTS.defaults,
    initialData: {
      schemaVersion: 1,
      ...MVP_LOCAL_SINGLE_USER_SCOPE,
      providerDefaults: {
        writer: "gemini",
        transcription: "browser",
      },
      mcpDefaults: {
        policy: "auto-smart",
        enabled: false,
      },
    },
  },
  {
    documentName: LOCAL_DATA_DOCUMENTS.cacheMetadata,
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
  const storage = new FileLocalDataStorageAdapter();
  const initializedFiles: string[] = [];

  for (const entry of LOCAL_DATA_FILES) {
    const created = await storage.ensureDocument(entry.documentName, entry.initialData);
    if (created) {
      initializedFiles.push(entry.documentName);
    }
  }

  return {
    localDataDir: LOCAL_DATA_DIR,
    initializedFiles,
  };
};
