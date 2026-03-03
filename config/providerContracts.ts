export const WRITER_PROVIDER_IDS = ["gemini", "openai", "anthropic"] as const;
export const TRANSCRIPTION_PROVIDER_IDS = ["gemini"] as const;

export type WriterProviderId = (typeof WRITER_PROVIDER_IDS)[number];
export type TranscriptionProviderId = (typeof TRANSCRIPTION_PROVIDER_IDS)[number];
export type ProviderId = WriterProviderId | TranscriptionProviderId;

export type SessionType = "SCRIBE" | "COMMANDER";

export const GEMINI_LIVE_LOCAL_RUNTIME_UNAVAILABLE_MESSAGE =
  "Real-time transcription is not supported in this browser runtime. Use Import to upload .txt, .docx, or .vtt transcripts.";

export interface ProviderCapabilities {
  realtimeAudio: boolean;
  streamingText: boolean;
  toolCallSupport: boolean;
  strictJsonMode: boolean;
}

export interface ProviderSelection {
  writer: WriterProviderId;
  transcription: TranscriptionProviderId;
}

export interface WriterProvider<
  TContextSource = unknown,
  TWorkItem = unknown,
  TToolCall = unknown,
> {
  readonly id: WriterProviderId;
  readonly capabilities: ProviderCapabilities;
  summarizeTranscript(transcript: string, providerConfig?: unknown): Promise<string>;
  analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: TContextSource[],
    providerConfig?: unknown,
  ): Promise<TToolCall[]>;
  refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: TWorkItem,
    projectContext: string,
    providerConfig?: unknown,
  ): Promise<string>;
  startCommandSession?(sessionType: SessionType): Promise<void>;
}

export interface TranscriptionProvider {
  readonly id: TranscriptionProviderId;
  readonly capabilities: ProviderCapabilities;
  connect(sessionType: SessionType): Promise<void>;
  disconnect(): Promise<void>;
  setMute(muted: boolean): void;
}

export const PROVIDER_CAPABILITY_MATRIX: Record<ProviderId, ProviderCapabilities> = Object.freeze({
  gemini: Object.freeze({
    realtimeAudio: true,
    streamingText: true,
    toolCallSupport: true,
    strictJsonMode: false,
  }),
  openai: Object.freeze({
    realtimeAudio: true,
    streamingText: true,
    toolCallSupport: true,
    strictJsonMode: true,
  }),
  anthropic: Object.freeze({
    realtimeAudio: false,
    streamingText: true,
    toolCallSupport: true,
    strictJsonMode: false,
  }),
});

export const DEFAULT_PROVIDER_SELECTION: ProviderSelection = Object.freeze({
  writer: "gemini",
  transcription: "gemini",
});

const asSet = <T extends string>(values: readonly T[]): Set<string> => new Set(values);
const WRITER_PROVIDER_ID_SET = asSet(WRITER_PROVIDER_IDS);
const TRANSCRIPTION_PROVIDER_ID_SET = asSet(TRANSCRIPTION_PROVIDER_IDS);

export const isWriterProviderId = (value: unknown): value is WriterProviderId =>
  typeof value === "string" && WRITER_PROVIDER_ID_SET.has(value);

export const isTranscriptionProviderId = (value: unknown): value is TranscriptionProviderId =>
  typeof value === "string" && TRANSCRIPTION_PROVIDER_ID_SET.has(value);

export const sanitizeProviderSelection = (value: unknown): ProviderSelection => {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_PROVIDER_SELECTION };
  }

  const candidate = value as Partial<ProviderSelection>;
  return {
    writer: isWriterProviderId(candidate.writer)
      ? candidate.writer
      : DEFAULT_PROVIDER_SELECTION.writer,
    transcription: isTranscriptionProviderId(candidate.transcription)
      ? candidate.transcription
      : DEFAULT_PROVIDER_SELECTION.transcription,
  };
};
