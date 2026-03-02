import { randomUUID } from "node:crypto";

export type AiOperation = "summarize" | "analyze" | "refine";

export interface AiServerUsageEvent {
  serverId: string;
  serverName: string;
  tokens: number;
  reachable: boolean;
  fromCache: boolean;
  latencyMs: number;
  errorCode?: string;
}

export interface AiTelemetryRecordInput {
  provider: string;
  operation: AiOperation;
  success: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  retrievalTokens: number;
  errorCode?: string;
  contextMode?: "auto-smart" | "manual-enrich";
  serverUsage?: AiServerUsageEvent[];
}

export interface AiTelemetryEvent extends AiTelemetryRecordInput {
  id: string;
  timestamp: string;
  totalTokens: number;
}

interface AggregateBucket {
  requests: number;
  successes: number;
  failures: number;
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  retrievalTokens: number;
  totalTokens: number;
  lastRequestAt?: string;
}

export interface AiServerTelemetryAggregate {
  requests: number;
  reachableRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  retrievalTokens: number;
  lastUsedAt?: string;
}

export interface AiTelemetrySnapshot {
  generatedAt: string;
  totals: AggregateBucket;
  byProvider: Record<string, AggregateBucket>;
  byOperation: Record<AiOperation, AggregateBucket>;
  byServer: Record<string, AiServerTelemetryAggregate>;
  recent: AiTelemetryEvent[];
}

const createBucket = (): AggregateBucket => ({
  requests: 0,
  successes: 0,
  failures: 0,
  avgDurationMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  retrievalTokens: 0,
  totalTokens: 0,
});

const toSafeInteger = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.round(value));
};

const updateBucket = (
  bucket: AggregateBucket,
  event: AiTelemetryEvent,
): void => {
  const nextRequests = bucket.requests + 1;
  bucket.avgDurationMs = Number(
    ((bucket.avgDurationMs * bucket.requests + event.durationMs) / nextRequests).toFixed(2),
  );
  bucket.requests = nextRequests;
  bucket.successes += event.success ? 1 : 0;
  bucket.failures += event.success ? 0 : 1;
  bucket.inputTokens += event.inputTokens;
  bucket.outputTokens += event.outputTokens;
  bucket.retrievalTokens += event.retrievalTokens;
  bucket.totalTokens += event.totalTokens;
  bucket.lastRequestAt = event.timestamp;
};

export const estimateTokens = (value: unknown): number => {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value === "string") {
    return Math.max(0, Math.ceil(value.length / 4));
  }

  try {
    return Math.max(0, Math.ceil(JSON.stringify(value).length / 4));
  } catch {
    return 0;
  }
};

export class AiTelemetryStore {
  private readonly maxEvents: number;
  private readonly events: AiTelemetryEvent[];

  constructor(maxEvents = 400) {
    this.maxEvents = Math.max(1, Math.round(maxEvents));
    this.events = [];
  }

  public record(input: AiTelemetryRecordInput): AiTelemetryEvent {
    const inputTokens = toSafeInteger(input.inputTokens);
    const outputTokens = toSafeInteger(input.outputTokens);
    const retrievalTokens = toSafeInteger(input.retrievalTokens);
    const totalTokens = inputTokens + outputTokens + retrievalTokens;
    const event: AiTelemetryEvent = {
      ...input,
      durationMs: toSafeInteger(input.durationMs),
      inputTokens,
      outputTokens,
      retrievalTokens,
      totalTokens,
      id: `ai_tm_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      serverUsage: Array.isArray(input.serverUsage)
        ? input.serverUsage.map((entry) => ({
            ...entry,
            tokens: toSafeInteger(entry.tokens),
            latencyMs: toSafeInteger(entry.latencyMs),
          }))
        : [],
    };

    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    return event;
  }

  public getSnapshot(recentLimit = 30): AiTelemetrySnapshot {
    const totals = createBucket();
    const byProvider: Record<string, AggregateBucket> = {};
    const byOperation: Record<AiOperation, AggregateBucket> = {
      summarize: createBucket(),
      analyze: createBucket(),
      refine: createBucket(),
    };
    const byServer: Record<string, AiServerTelemetryAggregate> = {};

    for (const event of this.events) {
      updateBucket(totals, event);
      const providerBucket =
        byProvider[event.provider] || (byProvider[event.provider] = createBucket());
      updateBucket(providerBucket, event);
      updateBucket(byOperation[event.operation], event);

      for (const server of event.serverUsage || []) {
        const serverKey = `${server.serverId}:${server.serverName}`;
        const existing = byServer[serverKey] || {
          requests: 0,
          reachableRequests: 0,
          failedRequests: 0,
          avgLatencyMs: 0,
          retrievalTokens: 0,
          lastUsedAt: undefined,
        };
        const nextRequests = existing.requests + 1;
        existing.avgLatencyMs = Number(
          ((existing.avgLatencyMs * existing.requests + server.latencyMs) / nextRequests).toFixed(2),
        );
        existing.requests = nextRequests;
        existing.reachableRequests += server.reachable ? 1 : 0;
        existing.failedRequests += server.reachable ? 0 : 1;
        existing.retrievalTokens += server.tokens;
        existing.lastUsedAt = event.timestamp;
        byServer[serverKey] = existing;
      }
    }

    const recent = [...this.events]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, Math.max(1, Math.round(recentLimit)));

    return {
      generatedAt: new Date().toISOString(),
      totals,
      byProvider,
      byOperation,
      byServer,
      recent,
    };
  }
}
