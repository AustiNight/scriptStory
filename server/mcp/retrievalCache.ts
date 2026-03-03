import { createHash } from "node:crypto";
import { LOCAL_DATA_DOCUMENTS } from "../localData/documents.ts";
import {
  FileLocalDataStorageAdapter,
  type LocalDataStorageAdapter,
} from "../localData/storage.ts";
import type { SanitizedMcpContextSnippet } from "./sanitizeContext.ts";

export interface McpRetrievalCacheOptions {
  metadataFilePath?: string;
  storage?: LocalDataStorageAdapter;
  now?: () => number;
}

export interface McpRetrievalCacheEntry {
  key: string;
  queryHash: string;
  serverId: string;
  createdAtMs: number;
  expiresAtMs: number;
  hitCount: number;
  snippets: SanitizedMcpContextSnippet[];
}

interface McpRetrievalCacheMetadataFile {
  schemaVersion: number;
  entries: Array<{
    key: string;
    queryHash: string;
    serverId: string;
    createdAt: string;
    expiresAt: string;
    hitCount: number;
    snippetCount: number;
  }>;
}

const cloneSnippets = (
  snippets: SanitizedMcpContextSnippet[],
): SanitizedMcpContextSnippet[] => snippets.map((snippet) => ({ ...snippet, source: { ...snippet.source } }));

export const hashRetrievalQuery = (query: string): string =>
  createHash("sha256").update(query).digest("hex");

export class McpRetrievalCache {
  private readonly now: () => number;
  private readonly storage: LocalDataStorageAdapter;
  private readonly metadataDocumentName: string;
  private readonly entries = new Map<string, McpRetrievalCacheEntry>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: McpRetrievalCacheOptions = {}) {
    this.now = options.now || (() => Date.now());
    this.storage =
      options.storage ||
      new FileLocalDataStorageAdapter({
        ...(options.metadataFilePath
          ? {
              documentPaths: {
                [LOCAL_DATA_DOCUMENTS.cacheMetadata]: options.metadataFilePath,
              },
            }
          : {}),
      });
    this.metadataDocumentName = LOCAL_DATA_DOCUMENTS.cacheMetadata;
  }

  public makeKey(serverId: string, queryHash: string, maxSnippets: number, maxSnippetChars: number): string {
    return `${serverId}:${queryHash}:${maxSnippets}:${maxSnippetChars}`;
  }

  public get(key: string): McpRetrievalCacheEntry | null {
    this.pruneExpired();
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      this.scheduleMetadataWrite();
      return null;
    }

    entry.hitCount += 1;
    this.scheduleMetadataWrite();
    return {
      ...entry,
      snippets: cloneSnippets(entry.snippets),
    };
  }

  public set(
    key: string,
    value: {
      queryHash: string;
      serverId: string;
      snippets: SanitizedMcpContextSnippet[];
    },
    ttlMs: number,
  ): McpRetrievalCacheEntry {
    const now = this.now();
    const boundedTtlMs = Number.isFinite(ttlMs) ? Math.max(1_000, Math.round(ttlMs)) : 120_000;
    const entry: McpRetrievalCacheEntry = {
      key,
      queryHash: value.queryHash,
      serverId: value.serverId,
      createdAtMs: now,
      expiresAtMs: now + boundedTtlMs,
      hitCount: 0,
      snippets: cloneSnippets(value.snippets),
    };
    this.entries.set(key, entry);
    this.pruneExpired();
    this.scheduleMetadataWrite();
    return {
      ...entry,
      snippets: cloneSnippets(entry.snippets),
    };
  }

  public getSize(): number {
    this.pruneExpired();
    return this.entries.size;
  }

  private pruneExpired(): void {
    const now = this.now();
    let removed = false;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        removed = true;
      }
    }

    if (removed) {
      this.scheduleMetadataWrite();
    }
  }

  private scheduleMetadataWrite(): void {
    this.writeQueue = this.writeQueue
      .then(() => this.flushMetadataFile())
      .catch(() => undefined);
  }

  private async flushMetadataFile(): Promise<void> {
    const fileData: McpRetrievalCacheMetadataFile = {
      schemaVersion: 1,
      entries: Array.from(this.entries.values())
        .sort((left, right) => right.createdAtMs - left.createdAtMs)
        .map((entry) => ({
          key: entry.key,
          queryHash: entry.queryHash,
          serverId: entry.serverId,
          createdAt: new Date(entry.createdAtMs).toISOString(),
          expiresAt: new Date(entry.expiresAtMs).toISOString(),
          hitCount: entry.hitCount,
          snippetCount: entry.snippets.length,
        })),
    };

    try {
      await this.storage.writeDocument(this.metadataDocumentName, fileData);
    } catch {
      // Cache metadata write failures should not break request flow.
    }
  }
}
