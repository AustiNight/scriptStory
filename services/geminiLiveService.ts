import {
  DEFAULT_PROVIDER_SELECTION,
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

class ApiWriterProviderAdapter
  implements WriterProvider<ContextSource, WorkItem, any>
{
  public readonly id: WriterProviderId;
  public readonly capabilities: (typeof PROVIDER_CAPABILITY_MATRIX)[WriterProviderId];
  private readonly post: <T>(path: string, payload: unknown) => Promise<T>;
  private readonly getProviderConfig: (providerId: WriterProviderId) => unknown;

  constructor(
    id: WriterProviderId,
    post: <T>(path: string, payload: unknown) => Promise<T>,
    getProviderConfig: (providerId: WriterProviderId) => unknown,
  ) {
    this.id = id;
    this.capabilities = PROVIDER_CAPABILITY_MATRIX[id];
    this.post = post;
    this.getProviderConfig = getProviderConfig;
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

class GeminiTranscriptionProviderAdapter implements TranscriptionProvider {
  public readonly id = "gemini" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.gemini;
  private isMuted = true;

  public setMute(muted: boolean) {
    this.isMuted = muted;
  }

  public async connect(_: SharedSessionType) {
    throw new Error(
      "Real-time Gemini Live sessions are not available in the local API runtime yet. Use transcript import or wait for provider runtime completion.",
    );
  }

  public async disconnect() {
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
      ),
      openai: new ApiWriterProviderAdapter(
        "openai",
        this.post.bind(this),
        this.getWriterProviderConfig.bind(this),
      ),
      anthropic: new ApiWriterProviderAdapter(
        "anthropic",
        this.post.bind(this),
        this.getWriterProviderConfig.bind(this),
      ),
    };

    this.transcriptionProviders = {
      gemini: new GeminiTranscriptionProviderAdapter(),
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

  public getWriterProviderRuntimeConfig(): WriterProviderRuntimeConfig {
    return { ...this.writerProviderRuntimeConfig };
  }

  public getProviderSelection(): ProviderSelection {
    return { ...this.providerSelection };
  }

  public getProviderCapabilities() {
    return PROVIDER_CAPABILITY_MATRIX;
  }

  private async post<T>(path: string, payload: unknown): Promise<T> {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const envelope = (await response.json()) as ApiEnvelope<T>;

    if (!response.ok || !envelope.ok) {
      const message =
        !envelope.ok && envelope.error?.message
          ? envelope.error.message
          : `Request failed (${response.status})`;
      throw new Error(message);
    }

    return envelope.data;
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
