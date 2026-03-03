export const LOCAL_DATA_DOCUMENTS = Object.freeze({
  mcpRegistry: "mcp-servers.json",
  mcpSecrets: "mcp-secrets.json",
  defaults: "defaults.json",
  cacheMetadata: "cache-metadata.json",
});

export type LocalDataDocumentName =
  (typeof LOCAL_DATA_DOCUMENTS)[keyof typeof LOCAL_DATA_DOCUMENTS];
