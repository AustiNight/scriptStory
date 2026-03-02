import type { ContextSourceInput } from "./types.ts";
import type { McpServerRecord } from "../mcp/schema.ts";
import type { SanitizedMcpContextSnippet } from "../mcp/sanitizeContext.ts";
import { McpGateway, type McpGatewayQueryResult } from "../mcp/gateway.ts";
import { McpRegistryStore } from "../mcp/registryStore.ts";
import { McpRetrievalCache, hashRetrievalQuery } from "../mcp/retrievalCache.ts";

export type ContextRetrievalMode = "auto-smart" | "manual-enrich";

export interface ContextPolicyInput {
  mode?: ContextRetrievalMode | string;
  globalTokenBudget?: number;
  perServerTokenBudget?: number;
  maxSnippetCount?: number;
  maxSnippetChars?: number;
  cacheTtlMs?: number;
}

export interface ContextPolicyConfig {
  mode: ContextRetrievalMode;
  globalTokenBudget: number;
  perServerTokenBudget: number;
  maxSnippetCount: number;
  maxSnippetChars: number;
  cacheTtlMs: number;
}

export interface ContextCitation {
  id: string;
  sourceId: string;
  serverId: string;
  serverName: string;
  resource?: string;
  queryHash: string;
  score: number;
  estimatedTokens: number;
  truncated: boolean;
  excerpt: string;
}

export interface ContextRetrievalServerTrace {
  serverId: string;
  serverName: string;
  reachable: boolean;
  fromCache: boolean;
  latencyMs: number;
  snippetCount: number;
  errorCode?: string;
}

export interface ContextRetrievalTrace {
  policy: ContextPolicyConfig;
  stage1: {
    needsExternalContext: boolean;
    reason: string;
    query: string;
    queryHash: string;
    keywordCount: number;
  };
  budgets: {
    globalTokenBudget: number;
    perServerTokenBudget: number;
    maxSnippetCount: number;
    maxSnippetChars: number;
    usedGlobalTokens: number;
    usedSnippetCount: number;
    perServerUsageTokens: Record<string, number>;
  };
  cache: {
    hits: number;
    misses: number;
    size: number;
  };
  servers: ContextRetrievalServerTrace[];
}

export interface PreparedContextResult {
  retrievedSources: ContextSourceInput[];
  citations: ContextCitation[];
  trace: ContextRetrievalTrace;
}

export interface AnalysisConfidence {
  score: number;
  threshold: number;
  isLowConfidence: boolean;
  reasons: string[];
}

export interface ToolCallContextMetadata {
  citations: ContextCitation[];
  retrieval: ContextRetrievalTrace;
  confidence: AnalysisConfidence;
}

interface RetrievalCandidate {
  sourceId: string;
  serverId: string;
  serverName: string;
  resource?: string;
  queryHash: string;
  text: string;
  truncated: boolean;
  score: number;
  estimatedTokens: number;
  serverPriorityRank: number;
}

interface Stage1IntentDecision {
  needsExternalContext: boolean;
  reason: string;
  query: string;
  queryHash: string;
  keywords: string[];
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "against",
  "also",
  "because",
  "between",
  "could",
  "did",
  "does",
  "from",
  "have",
  "into",
  "just",
  "like",
  "make",
  "need",
  "that",
  "their",
  "them",
  "there",
  "these",
  "this",
  "those",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
  "your",
]);

const CONTEXT_HINT_PATTERN =
  /\b(api|schema|contract|integration|dependency|version|documentation|doc|runbook|incident|error|stacktrace|security|permission|policy|migration|database|endpoint|auth|oauth|token|sso|availability|latency)\b/i;
const REQUIREMENT_HINT_PATTERN =
  /\b(epic|feature|story|task|bug|fix|implement|build|create|acceptance criteria|requirement|scope)\b/i;

const DEFAULT_AUTO_POLICY: ContextPolicyConfig = Object.freeze({
  mode: "auto-smart",
  globalTokenBudget: 900,
  perServerTokenBudget: 300,
  maxSnippetCount: 5,
  maxSnippetChars: 900,
  cacheTtlMs: 90_000,
});

const DEFAULT_MANUAL_POLICY: ContextPolicyConfig = Object.freeze({
  mode: "manual-enrich",
  globalTokenBudget: 1_800,
  perServerTokenBudget: 700,
  maxSnippetCount: 10,
  maxSnippetChars: 1_600,
  cacheTtlMs: 180_000,
});

const CONFIDENCE_THRESHOLD = 0.58;

const clampInteger = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const rounded = Math.round(parsed);
  if (rounded < min) {
    return min;
  }

  if (rounded > max) {
    return max;
  }

  return rounded;
};

const toNormalizedText = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();

const tokenize = (value: string): string[] => {
  const matches = toNormalizedText(value).match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  return matches.filter((token) => !STOP_WORDS.has(token));
};

const estimateTokens = (value: string): number => {
  if (!value) {
    return 0;
  }

  return Math.max(1, Math.ceil(value.length / 4));
};

const dedupePreserveOrder = (values: string[]): string[] => {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      output.push(value);
    }
  }
  return output;
};

const sanitizeContextPolicy = (input: unknown): ContextPolicyConfig => {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const mode = record.mode === "manual-enrich" ? "manual-enrich" : "auto-smart";
  const defaults = mode === "manual-enrich" ? DEFAULT_MANUAL_POLICY : DEFAULT_AUTO_POLICY;

  return {
    mode,
    globalTokenBudget: clampInteger(record.globalTokenBudget, defaults.globalTokenBudget, 200, 6_000),
    perServerTokenBudget: clampInteger(record.perServerTokenBudget, defaults.perServerTokenBudget, 120, 3_000),
    maxSnippetCount: clampInteger(record.maxSnippetCount, defaults.maxSnippetCount, 1, 20),
    maxSnippetChars: clampInteger(record.maxSnippetChars, defaults.maxSnippetChars, 80, 8_000),
    cacheTtlMs: clampInteger(record.cacheTtlMs, defaults.cacheTtlMs, 10_000, 600_000),
  };
};

const pickTopKeywords = (transcript: string, projectContext: string): string[] => {
  const transcriptTokens = tokenize(transcript);
  const projectTokens = tokenize(projectContext).slice(0, 40);
  const combined = [...transcriptTokens, ...projectTokens];
  const frequencies = new Map<string, number>();

  for (const token of combined) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }

  return dedupePreserveOrder(
    Array.from(frequencies.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([token]) => token)
      .slice(0, 12),
  );
};

const buildStage1IntentDecision = (
  transcript: string,
  projectContext: string,
  policy: ContextPolicyConfig,
  enabledServerCount: number,
): Stage1IntentDecision => {
  const trimmedTranscript = transcript.trim();
  const keywords = pickTopKeywords(trimmedTranscript, projectContext);
  const querySeed = `${trimmedTranscript.slice(0, 1_400)}\n${projectContext.slice(0, 500)}`.trim();
  const query = querySeed.length > 0 ? querySeed : trimmedTranscript.slice(0, 1_400);
  const queryHash = hashRetrievalQuery(query);

  if (enabledServerCount === 0) {
    return {
      needsExternalContext: false,
      reason: "No enabled MCP servers available.",
      query,
      queryHash,
      keywords,
    };
  }

  if (policy.mode === "manual-enrich") {
    return {
      needsExternalContext: true,
      reason: "Manual enrich mode forces external retrieval.",
      query,
      queryHash,
      keywords,
    };
  }

  if (trimmedTranscript.length < 120 && !CONTEXT_HINT_PATTERN.test(trimmedTranscript)) {
    return {
      needsExternalContext: false,
      reason: "Short transcript without external context signals.",
      query,
      queryHash,
      keywords,
    };
  }

  if (CONTEXT_HINT_PATTERN.test(trimmedTranscript)) {
    return {
      needsExternalContext: true,
      reason: "Detected external knowledge hints (API/docs/integration/security/etc).",
      query,
      queryHash,
      keywords,
    };
  }

  if (/\?/.test(trimmedTranscript) && keywords.length >= 4) {
    return {
      needsExternalContext: true,
      reason: "Question-heavy transcript with meaningful keywords.",
      query,
      queryHash,
      keywords,
    };
  }

  return {
    needsExternalContext: false,
    reason: "Auto-smart classifier determined local context is sufficient.",
    query,
    queryHash,
    keywords,
  };
};

const rankSnippet = (
  snippet: SanitizedMcpContextSnippet,
  keywords: string[],
  serverPriorityRank: number,
): number => {
  const snippetTokens = new Set(tokenize(snippet.text));
  const overlap = keywords.filter((token) => snippetTokens.has(token)).length;
  const lexical = keywords.length > 0 ? overlap / keywords.length : 0;
  const priorityBoost = Math.max(0.05, 0.2 - serverPriorityRank * 0.02);
  const truncationPenalty = snippet.truncated ? 0.03 : 0;
  const densityBonus = Math.min(0.1, Math.max(0, estimateTokens(snippet.text) / 600));
  return lexical * 0.75 + priorityBoost + densityBonus - truncationPenalty;
};

const toContextSourceName = (serverName: string, resource?: string): string =>
  resource ? `MCP:${serverName}:${resource}` : `MCP:${serverName}`;

const buildContextSource = (candidate: RetrievalCandidate): ContextSourceInput => ({
  id: candidate.sourceId,
  name: toContextSourceName(candidate.serverName, candidate.resource),
  type: "PASTE",
  mimeType: "text/plain",
  content: candidate.text,
  enabled: true,
});

const buildCitation = (candidate: RetrievalCandidate): ContextCitation => ({
  id: `cit_${hashRetrievalQuery(`${candidate.sourceId}:${candidate.queryHash}`).slice(0, 16)}`,
  sourceId: candidate.sourceId,
  serverId: candidate.serverId,
  serverName: candidate.serverName,
  ...(candidate.resource ? { resource: candidate.resource } : {}),
  queryHash: candidate.queryHash,
  score: Number(candidate.score.toFixed(3)),
  estimatedTokens: candidate.estimatedTokens,
  truncated: candidate.truncated,
  excerpt: candidate.text.slice(0, 280),
});

const hasToolCallsThatCreateOrUpdateItems = (toolCalls: unknown[]): boolean =>
  toolCalls.some((call) => {
    if (!call || typeof call !== "object") {
      return false;
    }
    const record = call as Record<string, unknown>;
    return record.name === "createWorkItem" || record.name === "updateWorkItem";
  });

export const assessAnalysisConfidence = (
  toolCalls: unknown[],
  transcript: string,
): AnalysisConfidence => {
  let score = 0.95;
  const reasons: string[] = [];
  const transcriptText = transcript.trim();

  if (toolCalls.length === 0) {
    score -= transcriptText.length > 80 ? 0.75 : 0.35;
    reasons.push("No tool calls were returned.");
  }

  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") {
      score -= 0.1;
      reasons.push("One or more tool calls had invalid structure.");
      continue;
    }

    const record = toolCall as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name : "";
    const args =
      record.args && typeof record.args === "object" && !Array.isArray(record.args)
        ? (record.args as Record<string, unknown>)
        : {};

    if (name === "createWorkItem") {
      const type = typeof args.type === "string" ? args.type.toUpperCase() : "";
      if ((type === "EPIC" || type === "FEATURE" || type === "STORY") && !Array.isArray(args.criteria)) {
        score -= 0.18;
        reasons.push(`Missing criteria for ${type || "hierarchical"} work item.`);
      }

      if (type === "BUG") {
        if (!Array.isArray(args.stepsToReproduce)) {
          score -= 0.24;
          reasons.push("BUG item missing stepsToReproduce.");
        }
        if (typeof args.expectedResult !== "string") {
          score -= 0.18;
          reasons.push("BUG item missing expectedResult.");
        }
        if (typeof args.actualResult !== "string") {
          score -= 0.18;
          reasons.push("BUG item missing actualResult.");
        }
      }
    }
  }

  if (
    REQUIREMENT_HINT_PATTERN.test(transcriptText) &&
    !hasToolCallsThatCreateOrUpdateItems(toolCalls)
  ) {
    score -= 0.25;
    reasons.push("Transcript looks like requirement discussion but no create/update work-item calls were produced.");
  }

  const boundedScore = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  return {
    score: boundedScore,
    threshold: CONFIDENCE_THRESHOLD,
    isLowConfidence: boundedScore < CONFIDENCE_THRESHOLD,
    reasons,
  };
};

const chooseCitationsForToolCall = (
  call: unknown,
  citations: ContextCitation[],
): ContextCitation[] => {
  if (!call || typeof call !== "object" || citations.length === 0) {
    return [];
  }

  const callRecord = call as Record<string, unknown>;
  const args = callRecord.args ?? {};
  const callText = typeof args === "string" ? args : JSON.stringify(args);
  const callTokenSet = new Set(tokenize(callText));
  if (callTokenSet.size === 0) {
    return citations.slice(0, 2);
  }

  const ranked = citations
    .map((citation) => {
      const citationTokens = new Set(tokenize(citation.excerpt));
      const overlap = Array.from(callTokenSet).filter((token) => citationTokens.has(token)).length;
      return {
        citation,
        score: overlap * 0.6 + citation.score,
      };
    })
    .sort((left, right) => right.score - left.score);

  const selected = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, 3)
    .map((entry) => entry.citation);

  return selected.length > 0 ? selected : citations.slice(0, 1);
};

export const attachToolCallContextMetadata = (
  toolCalls: unknown[],
  citations: ContextCitation[],
  trace: ContextRetrievalTrace,
  confidence: AnalysisConfidence,
): unknown[] =>
  toolCalls.map((call) => {
    if (!call || typeof call !== "object") {
      return call;
    }

    const metadata: ToolCallContextMetadata = {
      citations: chooseCitationsForToolCall(call, citations),
      retrieval: trace,
      confidence,
    };

    return {
      ...(call as Record<string, unknown>),
      metadata,
    };
  });

export interface ContextRetrievalStrategyOptions {
  featureEnabled: boolean;
  registryStore: McpRegistryStore;
  gateway: McpGateway;
  cache: McpRetrievalCache;
}

export class ContextRetrievalStrategy {
  private readonly featureEnabled: boolean;
  private readonly registryStore: McpRegistryStore;
  private readonly gateway: McpGateway;
  private readonly cache: McpRetrievalCache;

  constructor(options: ContextRetrievalStrategyOptions) {
    this.featureEnabled = options.featureEnabled;
    this.registryStore = options.registryStore;
    this.gateway = options.gateway;
    this.cache = options.cache;
  }

  public async prepare(
    transcript: string,
    projectContext: string,
    policyInput?: unknown,
  ): Promise<PreparedContextResult> {
    const policy = sanitizeContextPolicy(policyInput);
    const emptyTrace: ContextRetrievalTrace = {
      policy,
      stage1: {
        needsExternalContext: false,
        reason: "MCP context feature disabled.",
        query: transcript.slice(0, 1_400),
        queryHash: hashRetrievalQuery(transcript.slice(0, 1_400)),
        keywordCount: 0,
      },
      budgets: {
        globalTokenBudget: policy.globalTokenBudget,
        perServerTokenBudget: policy.perServerTokenBudget,
        maxSnippetCount: policy.maxSnippetCount,
        maxSnippetChars: policy.maxSnippetChars,
        usedGlobalTokens: 0,
        usedSnippetCount: 0,
        perServerUsageTokens: {},
      },
      cache: {
        hits: 0,
        misses: 0,
        size: this.cache.getSize(),
      },
      servers: [],
    };

    if (!this.featureEnabled) {
      return {
        retrievedSources: [],
        citations: [],
        trace: emptyTrace,
      };
    }

    const enabledServers = (await this.registryStore.listServers())
      .filter((server) => server.enabled)
      .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name));

    const stage1 = buildStage1IntentDecision(
      transcript,
      projectContext,
      policy,
      enabledServers.length,
    );
    emptyTrace.stage1 = {
      needsExternalContext: stage1.needsExternalContext,
      reason: stage1.reason,
      query: stage1.query,
      queryHash: stage1.queryHash,
      keywordCount: stage1.keywords.length,
    };

    if (!stage1.needsExternalContext) {
      return {
        retrievedSources: [],
        citations: [],
        trace: emptyTrace,
      };
    }

    let cacheHits = 0;
    let cacheMisses = 0;
    const serverTraces: ContextRetrievalServerTrace[] = [];
    const allCandidates: RetrievalCandidate[] = [];

    const maxSnippetsPerServer = Math.max(
      1,
      Math.min(
        policy.maxSnippetCount,
        Math.floor(policy.perServerTokenBudget / Math.max(1, estimateTokens("x".repeat(policy.maxSnippetChars)))),
      ),
    );

    for (let serverIndex = 0; serverIndex < enabledServers.length; serverIndex += 1) {
      const server = enabledServers[serverIndex];
      const queryHash = hashRetrievalQuery(
        `${stage1.queryHash}:${server.id}:${policy.maxSnippetChars}:${maxSnippetsPerServer}:${policy.mode}`,
      );
      const cacheKey = this.cache.makeKey(server.id, queryHash, maxSnippetsPerServer, policy.maxSnippetChars);
      const cached = this.cache.get(cacheKey);

      if (cached) {
        cacheHits += 1;
        const candidates = this.toCandidates(
          cached.snippets,
          server,
          stage1.keywords,
          serverIndex,
          queryHash,
        );
        allCandidates.push(...candidates);
        serverTraces.push({
          serverId: server.id,
          serverName: server.name,
          reachable: true,
          fromCache: true,
          latencyMs: 0,
          snippetCount: cached.snippets.length,
        });
        continue;
      }

      cacheMisses += 1;
      const queryResult = await this.gateway.queryServer(server.id, {
        query: stage1.query,
        intent: stage1.reason,
        maxSnippets: maxSnippetsPerServer,
        maxSnippetChars: policy.maxSnippetChars,
        allowedResources: server.allowedResources,
      });

      serverTraces.push({
        serverId: server.id,
        serverName: server.name,
        reachable: queryResult.reachable,
        fromCache: false,
        latencyMs: queryResult.latencyMs,
        snippetCount: queryResult.snippets.length,
        ...(queryResult.errorCode ? { errorCode: queryResult.errorCode } : {}),
      });

      if (!queryResult.reachable || queryResult.snippets.length === 0) {
        continue;
      }

      this.cache.set(
        cacheKey,
        {
          serverId: server.id,
          queryHash,
          snippets: queryResult.snippets,
        },
        policy.cacheTtlMs,
      );

      const candidates = this.toCandidates(
        queryResult.snippets,
        server,
        stage1.keywords,
        serverIndex,
        queryHash,
      );
      allCandidates.push(...candidates);
    }

    const selected = this.applyBudgetSelection(allCandidates, policy);
    const retrievedSources = selected.items.map(buildContextSource);
    const citations = selected.items.map(buildCitation);

    return {
      retrievedSources,
      citations,
      trace: {
        policy,
        stage1: {
          needsExternalContext: stage1.needsExternalContext,
          reason: stage1.reason,
          query: stage1.query,
          queryHash: stage1.queryHash,
          keywordCount: stage1.keywords.length,
        },
        budgets: {
          globalTokenBudget: policy.globalTokenBudget,
          perServerTokenBudget: policy.perServerTokenBudget,
          maxSnippetCount: policy.maxSnippetCount,
          maxSnippetChars: policy.maxSnippetChars,
          usedGlobalTokens: selected.usedGlobalTokens,
          usedSnippetCount: selected.items.length,
          perServerUsageTokens: selected.perServerUsageTokens,
        },
        cache: {
          hits: cacheHits,
          misses: cacheMisses,
          size: this.cache.getSize(),
        },
        servers: serverTraces,
      },
    };
  }

  private toCandidates(
    snippets: SanitizedMcpContextSnippet[],
    server: McpServerRecord,
    keywords: string[],
    serverPriorityRank: number,
    queryHash: string,
  ): RetrievalCandidate[] {
    return snippets
      .map((snippet, index) => {
        const text = snippet.text.slice(0, 8_000).trim();
        if (!text) {
          return null;
        }

        const estimatedTokens = estimateTokens(text);
        const sourceId = `mcp_${server.id}_${queryHash.slice(0, 8)}_${index + 1}`;
        const score = rankSnippet(snippet, keywords, serverPriorityRank);

        return {
          sourceId,
          serverId: server.id,
          serverName: server.name,
          resource: snippet.source.resource,
          queryHash,
          text,
          truncated: snippet.truncated,
          score,
          estimatedTokens,
          serverPriorityRank,
        } satisfies RetrievalCandidate;
      })
      .filter((entry): entry is RetrievalCandidate => Boolean(entry));
  }

  private applyBudgetSelection(
    candidates: RetrievalCandidate[],
    policy: ContextPolicyConfig,
  ): {
    items: RetrievalCandidate[];
    usedGlobalTokens: number;
    perServerUsageTokens: Record<string, number>;
  } {
    const ranked = [...candidates].sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      if (left.serverPriorityRank !== right.serverPriorityRank) {
        return left.serverPriorityRank - right.serverPriorityRank;
      }

      return left.estimatedTokens - right.estimatedTokens;
    });

    let usedGlobalTokens = 0;
    const perServerUsageTokens: Record<string, number> = {};
    const selected: RetrievalCandidate[] = [];

    for (const candidate of ranked) {
      if (selected.length >= policy.maxSnippetCount) {
        break;
      }

      const currentServerTokens = perServerUsageTokens[candidate.serverId] || 0;
      if (currentServerTokens + candidate.estimatedTokens > policy.perServerTokenBudget) {
        continue;
      }

      if (usedGlobalTokens + candidate.estimatedTokens > policy.globalTokenBudget) {
        continue;
      }

      selected.push(candidate);
      usedGlobalTokens += candidate.estimatedTokens;
      perServerUsageTokens[candidate.serverId] = currentServerTokens + candidate.estimatedTokens;
    }

    return {
      items: selected,
      usedGlobalTokens,
      perServerUsageTokens,
    };
  }
}
