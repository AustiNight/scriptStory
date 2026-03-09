import {
  DEFAULT_PROVIDER_SELECTION,
  GEMINI_LIVE_LOCAL_RUNTIME_UNAVAILABLE_MESSAGE,
  PROVIDER_CAPABILITY_MATRIX,
  sanitizeProviderSelection,
  type ProviderSelection,
  type SessionType as SharedSessionType,
  type TranscriptionProvider,
  type WriterProvider,
  type WriterProviderId,
} from "../config/providerContracts";
import {
  DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG,
  getWriterProviderRuntimeConfig,
  sanitizeWriterProviderRuntimeConfig,
  type WriterProviderRuntimeConfig,
} from "../config/providerRuntimeConfig";
import { ContextSource, WorkItem } from "../types";

type ToolHandler = (name: string, args: any) => Promise<any>;
type TranscriptHandler = (text: string, isUser: boolean) => void;

export type SessionType = SharedSessionType;

interface ApiSuccessEnvelope<T> {
  ok: true;
  data: T;
}

interface ApiErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export type ContextPolicyMode = "auto-smart" | "manual-enrich";

export interface ContextPolicyConfig {
  mode: ContextPolicyMode;
  globalTokenBudget: number;
  perServerTokenBudget: number;
  maxSnippetCount: number;
  maxSnippetChars: number;
  cacheTtlMs: number;
}

export interface AiWriterProviderStatus {
  id: WriterProviderId;
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  available: boolean;
  capabilities: {
    realtimeAudio: boolean;
    streamingText: boolean;
    toolCallSupport: boolean;
    strictJsonMode: boolean;
  };
}

export interface AiTranscriptionProviderStatus {
  id: ProviderSelection["transcription"];
  enabled: boolean;
  configured: boolean;
  implemented: boolean;
  available: boolean;
  unavailableReason?: string;
  capabilities: {
    realtimeAudio: boolean;
    streamingText: boolean;
    toolCallSupport: boolean;
    strictJsonMode: boolean;
  };
}

export interface AiProviderCatalog {
  defaults: ProviderSelection;
  capabilities: typeof PROVIDER_CAPABILITY_MATRIX;
  writers: AiWriterProviderStatus[];
  transcriptions: AiTranscriptionProviderStatus[];
}

export interface AiTelemetryAggregateBucket {
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

export interface AiTelemetryEvent {
  id: string;
  timestamp: string;
  provider: string;
  operation: "summarize" | "analyze" | "refine";
  success: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  retrievalTokens: number;
  totalTokens: number;
  errorCode?: string;
  contextMode?: "auto-smart" | "manual-enrich";
  serverUsage?: Array<{
    serverId: string;
    serverName: string;
    tokens: number;
    reachable: boolean;
    fromCache: boolean;
    latencyMs: number;
    errorCode?: string;
  }>;
}

export interface AiDiagnosticsSnapshot {
  generatedAt: string;
  totals: AiTelemetryAggregateBucket;
  byProvider: Record<string, AiTelemetryAggregateBucket>;
  byOperation: Record<"summarize" | "analyze" | "refine", AiTelemetryAggregateBucket>;
  byServer: Record<string, AiServerTelemetryAggregate>;
  recent: AiTelemetryEvent[];
}

export const DEFAULT_CONTEXT_POLICY_CONFIG: ContextPolicyConfig = Object.freeze({
  mode: "auto-smart",
  globalTokenBudget: 900,
  perServerTokenBudget: 300,
  maxSnippetCount: 5,
  maxSnippetChars: 900,
  cacheTtlMs: 90_000,
});

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

export const sanitizeContextPolicyConfig = (value: unknown): ContextPolicyConfig => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_CONTEXT_POLICY_CONFIG };
  }

  const candidate = value as Record<string, unknown>;
  return {
    mode: candidate.mode === "manual-enrich" ? "manual-enrich" : "auto-smart",
    globalTokenBudget: clampInteger(
      candidate.globalTokenBudget,
      DEFAULT_CONTEXT_POLICY_CONFIG.globalTokenBudget,
      200,
      6_000,
    ),
    perServerTokenBudget: clampInteger(
      candidate.perServerTokenBudget,
      DEFAULT_CONTEXT_POLICY_CONFIG.perServerTokenBudget,
      120,
      3_000,
    ),
    maxSnippetCount: clampInteger(
      candidate.maxSnippetCount,
      DEFAULT_CONTEXT_POLICY_CONFIG.maxSnippetCount,
      1,
      20,
    ),
    maxSnippetChars: clampInteger(
      candidate.maxSnippetChars,
      DEFAULT_CONTEXT_POLICY_CONFIG.maxSnippetChars,
      80,
      8_000,
    ),
    cacheTtlMs: clampInteger(
      candidate.cacheTtlMs,
      DEFAULT_CONTEXT_POLICY_CONFIG.cacheTtlMs,
      10_000,
      600_000,
    ),
  };
};

class ApiWriterProviderAdapter
  implements WriterProvider<ContextSource, WorkItem, any>
{
  public readonly id: WriterProviderId;
  public readonly capabilities: (typeof PROVIDER_CAPABILITY_MATRIX)[WriterProviderId];
  private readonly post: <T>(path: string, payload: unknown) => Promise<T>;
  private readonly getProviderConfig: (providerId: WriterProviderId) => unknown;
  private readonly getContextPolicyConfig: () => ContextPolicyConfig;

  constructor(
    id: WriterProviderId,
    post: <T>(path: string, payload: unknown) => Promise<T>,
    getProviderConfig: (providerId: WriterProviderId) => unknown,
    getContextPolicyConfig: () => ContextPolicyConfig,
  ) {
    this.id = id;
    this.capabilities = PROVIDER_CAPABILITY_MATRIX[id];
    this.post = post;
    this.getProviderConfig = getProviderConfig;
    this.getContextPolicyConfig = getContextPolicyConfig;
  }

  public async summarizeTranscript(transcript: string): Promise<string> {
    const data = await this.post<{ summary: string }>(
      "/api/ai/summarize",
      {
        provider: this.id,
        transcript,
        providerConfig: this.getProviderConfig(this.id),
      },
    );
    return data.summary;
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSource[],
  ): Promise<any[]> {
    if (!transcript.trim()) {
      return [];
    }

    const data = await this.post<{ toolCalls: any[] }>(
      "/api/ai/analyze",
      {
        provider: this.id,
        transcript,
        projectContext,
        contextSources,
        contextPolicy: this.getContextPolicyConfig(),
        providerConfig: this.getProviderConfig(this.id),
      },
    );

    return data.toolCalls || [];
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItem,
    projectContext: string,
  ): Promise<string> {
    const data = await this.post<{ refinedText: string }>(
      "/api/ai/refine",
      {
        provider: this.id,
        rawTranscript,
        fieldName,
        currentItem,
        projectContext,
        providerConfig: this.getProviderConfig(this.id),
      },
    );

    return data.refinedText;
  }
}

class BrowserTranscriptionProviderAdapter implements TranscriptionProvider {
  public readonly id = "browser" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.browser;
  private readonly onTranscript: TranscriptHandler;
  private isMuted = true;
  private recognition: {
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    lang: string;
    onstart: (() => void) | null;
    onend: (() => void) | null;
    onerror: ((event: { error?: string; message?: string }) => void) | null;
    onresult: ((event: { resultIndex: number; results: any }) => void) | null;
    start: () => void;
    stop: () => void;
    abort: () => void;
  } | null = null;
  private shouldReconnect = false;
  private isListening = false;

  constructor(onTranscript: TranscriptHandler) {
    this.onTranscript = onTranscript;
  }

  private getSpeechRecognitionConstructor():
    | (new () => {
        continuous: boolean;
        interimResults: boolean;
        maxAlternatives: number;
        lang: string;
        onstart: (() => void) | null;
        onend: (() => void) | null;
        onerror: ((event: { error?: string; message?: string }) => void) | null;
        onresult: ((event: { resultIndex: number; results: any }) => void) | null;
        start: () => void;
        stop: () => void;
        abort: () => void;
      })
    | null {
    if (typeof window === "undefined") {
      return null;
    }

    const speechWindow = window as Window & {
      SpeechRecognition?: new () => any;
      webkitSpeechRecognition?: new () => any;
    };

    return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
  }

  private initializeRecognition() {
    if (this.recognition) {
      return;
    }

    const SpeechRecognitionCtor = this.getSpeechRecognitionConstructor();
    if (!SpeechRecognitionCtor) {
      throw new Error(GEMINI_LIVE_LOCAL_RUNTIME_UNAVAILABLE_MESSAGE);
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      this.isListening = true;
    };

    recognition.onend = () => {
      this.isListening = false;
      if (this.shouldReconnect && !this.isMuted) {
        window.setTimeout(() => {
          this.startRecognition();
        }, 200);
      }
    };

    recognition.onerror = (event) => {
      const errorCode = (event?.error || "").toLowerCase();
      if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
        this.shouldReconnect = false;
      }
    };

    recognition.onresult = (event) => {
      const results = event?.results;
      if (!results) {
        return;
      }

      for (let index = event.resultIndex; index < results.length; index += 1) {
        const result = results[index];
        const transcript = result?.[0]?.transcript;
        if (typeof transcript !== "string") {
          continue;
        }

        const normalized = transcript.trim();
        if (!normalized) {
          continue;
        }

        this.onTranscript(`${normalized} `, true);
      }
    };

    this.recognition = recognition;
  }

  private startRecognition() {
    if (!this.recognition || this.isMuted || this.isListening || !this.shouldReconnect) {
      return;
    }

    try {
      this.recognition.start();
    } catch {
      // SpeechRecognition can throw InvalidStateError if start is called while active.
    }
  }

  private stopRecognition() {
    if (!this.recognition || !this.isListening) {
      return;
    }

    try {
      this.recognition.stop();
    } catch {
      // Safe no-op; adapter will reset on disconnect.
    }
  }

  public setMute(muted: boolean) {
    this.isMuted = muted;
    if (this.isMuted) {
      this.stopRecognition();
      return;
    }

    this.startRecognition();
  }

  public async connect(_: SharedSessionType) {
    this.shouldReconnect = true;
    this.initializeRecognition();
    if (!this.isMuted) {
      this.startRecognition();
    }
  }

  public async disconnect() {
    this.shouldReconnect = false;
    this.stopRecognition();
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // Ignore browser-specific teardown errors.
      }
    }
    this.recognition = null;
    this.isListening = false;
    this.isMuted = true;
  }
}

export class GeminiLiveService {
  private onToolCall: ToolHandler | null = null;
  private onTranscript: TranscriptHandler | null = null;
  private isMuted = true;
  private providerSelection: ProviderSelection = {
    ...DEFAULT_PROVIDER_SELECTION,
  };
  private writerProviderRuntimeConfig: WriterProviderRuntimeConfig = {
    ...DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG,
  };
  private contextPolicyConfig: ContextPolicyConfig = {
    ...DEFAULT_CONTEXT_POLICY_CONFIG,
  };
  private readonly writerProviders: Record<WriterProviderId, ApiWriterProviderAdapter>;
  private readonly transcriptionProviders: Record<
    ProviderSelection["transcription"],
    TranscriptionProvider
  >;

  constructor() {
    this.writerProviders = {
      gemini: new ApiWriterProviderAdapter(
        "gemini",
        this.post.bind(this),
        this.getWriterProviderConfig.bind(this),
        this.getContextPolicyConfig.bind(this),
      ),
      openai: new ApiWriterProviderAdapter(
        "openai",
        this.post.bind(this),
        this.getWriterProviderConfig.bind(this),
        this.getContextPolicyConfig.bind(this),
      ),
      anthropic: new ApiWriterProviderAdapter(
        "anthropic",
        this.post.bind(this),
        this.getWriterProviderConfig.bind(this),
        this.getContextPolicyConfig.bind(this),
      ),
    };

    this.transcriptionProviders = {
      browser: new BrowserTranscriptionProviderAdapter((text, isUser) => {
        if (this.onTranscript) {
          this.onTranscript(text, isUser);
        }
      }),
    };
  }

  public setHandlers(onToolCall: ToolHandler, onTranscript: TranscriptHandler) {
    this.onToolCall = onToolCall;
    this.onTranscript = onTranscript;
  }

  public setMute(muted: boolean) {
    this.isMuted = muted;
    this.getSelectedTranscriptionProvider().setMute(muted);
  }

  public setProviderSelection(selection: unknown) {
    this.providerSelection = sanitizeProviderSelection(selection);
    this.getSelectedTranscriptionProvider().setMute(this.isMuted);
  }

  public setWriterProviderRuntimeConfig(config: unknown) {
    this.writerProviderRuntimeConfig = sanitizeWriterProviderRuntimeConfig(config);
  }

  public setContextPolicyConfig(config: unknown) {
    this.contextPolicyConfig = sanitizeContextPolicyConfig(config);
  }

  public getWriterProviderRuntimeConfig(): WriterProviderRuntimeConfig {
    return { ...this.writerProviderRuntimeConfig };
  }

  public getContextPolicyConfig(): ContextPolicyConfig {
    return { ...this.contextPolicyConfig };
  }

  public getProviderSelection(): ProviderSelection {
    return { ...this.providerSelection };
  }

  public getProviderCapabilities() {
    return PROVIDER_CAPABILITY_MATRIX;
  }

  private async parseEnvelope<T>(
    response: Response,
  ): Promise<{ envelope: ApiEnvelope<T> | null; rawBody: string }> {
    const rawBody = await response.text();
    if (!rawBody.trim()) {
      return { envelope: null, rawBody };
    }

    try {
      return {
        envelope: JSON.parse(rawBody) as ApiEnvelope<T>,
        rawBody,
      };
    } catch {
      return { envelope: null, rawBody };
    }
  }

  private buildRequestFailureMessage<T>(
    response: Response,
    envelope: ApiEnvelope<T> | null,
    rawBody: string,
  ): string {
    if (envelope && !envelope.ok && envelope.error?.message) {
      return envelope.error.message;
    }

    if (!rawBody.trim()) {
      if (response.status >= 500) {
        return `Request failed (${response.status}): API server may be unavailable or restarting.`;
      }
      return `Request failed (${response.status}): empty response body.`;
    }

    return `Request failed (${response.status}): server returned a non-JSON response.`;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const { envelope, rawBody } = await this.parseEnvelope<T>(response);

    if (!response.ok || !envelope || !envelope.ok) {
      throw new Error(this.buildRequestFailureMessage(response, envelope, rawBody));
    }

    return envelope.data;
  }

  private async get<T>(path: string): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(path);
        const { envelope, rawBody } = await this.parseEnvelope<T>(response);

        if (!response.ok || !envelope || !envelope.ok) {
          const isTransientEmptyServerError =
            response.status >= 500 && !rawBody.trim();
          if (isTransientEmptyServerError && attempt < 1) {
            await this.sleep(200);
            continue;
          }
          throw new Error(this.buildRequestFailureMessage(response, envelope, rawBody));
        }

        return envelope.data;
      } catch (error) {
        const normalized =
          error instanceof Error
            ? error
            : new Error(String(error));
        lastError = normalized;

        const isNetworkFailure =
          /fetch failed|failed to fetch|networkerror|network request failed/i.test(
            normalized.message,
          );
        if (isNetworkFailure && attempt < 1) {
          await this.sleep(200);
          continue;
        }
        break;
      }
    }

    if (lastError) {
      const isNetworkFailure =
        /fetch failed|failed to fetch|networkerror|network request failed/i.test(
          lastError.message,
        );
      if (isNetworkFailure) {
        throw new Error(
          "API request failed before receiving a response. Ensure the local API server is running.",
        );
      }
      throw lastError;
    }

    throw new Error("Request failed: unknown API error.");
  }

  public async summarizeTranscript(transcript: string): Promise<string> {
    return this.getSelectedWriterProvider().summarizeTranscript(transcript);
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSource[],
  ): Promise<any[]> {
    return this.getSelectedWriterProvider().analyzeMeetingTranscript(
      transcript,
      projectContext,
      contextSources,
    );
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItem,
    projectContext: string,
  ): Promise<string> {
    return this.getSelectedWriterProvider().refineFieldContent(
      rawTranscript,
      fieldName,
      currentItem,
      projectContext,
    );
  }

  public async fetchProviderCatalog(): Promise<AiProviderCatalog> {
    return this.get<AiProviderCatalog>("/api/ai/providers");
  }

  public async fetchDiagnostics(): Promise<AiDiagnosticsSnapshot> {
    return this.get<AiDiagnosticsSnapshot>("/api/ai/telemetry");
  }

  private getSelectedWriterProvider(): ApiWriterProviderAdapter {
    const selected = this.writerProviders[this.providerSelection.writer];
    return selected || this.writerProviders[DEFAULT_PROVIDER_SELECTION.writer];
  }

  private getSelectedTranscriptionProvider(): TranscriptionProvider {
    const selected = this.transcriptionProviders[this.providerSelection.transcription];
    return selected || this.transcriptionProviders[DEFAULT_PROVIDER_SELECTION.transcription];
  }

  public async connect(sessionType: SessionType) {
    await this.getSelectedTranscriptionProvider().connect(sessionType);
  }

  public async disconnect() {
    await this.getSelectedTranscriptionProvider().disconnect();
    this.isMuted = true;
  }

  private getWriterProviderConfig(providerId: WriterProviderId): unknown {
    return getWriterProviderRuntimeConfig(this.writerProviderRuntimeConfig, providerId);
  }
}

export const geminiLive = new GeminiLiveService();
