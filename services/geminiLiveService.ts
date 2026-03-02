import { ContextSource, WorkItem } from "../types";

type ToolHandler = (name: string, args: any) => Promise<any>;
type TranscriptHandler = (text: string, isUser: boolean) => void;

export type SessionType = "SCRIBE" | "COMMANDER";

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

export class GeminiLiveService {
  private onToolCall: ToolHandler | null = null;
  private onTranscript: TranscriptHandler | null = null;
  private isMuted = true;

  public setHandlers(onToolCall: ToolHandler, onTranscript: TranscriptHandler) {
    this.onToolCall = onToolCall;
    this.onTranscript = onTranscript;
  }

  public setMute(muted: boolean) {
    this.isMuted = muted;
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
    const data = await this.post<{ summary: string }>("/api/ai/gemini/summarize", { transcript });
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

    const data = await this.post<{ toolCalls: any[] }>("/api/ai/gemini/analyze", {
      transcript,
      projectContext,
      contextSources,
    });

    return data.toolCalls || [];
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItem,
    projectContext: string,
  ): Promise<string> {
    const data = await this.post<{ refinedText: string }>("/api/ai/gemini/refine", {
      rawTranscript,
      fieldName,
      currentItem,
      projectContext,
    });

    return data.refinedText;
  }

  public async connect(_: SessionType) {
    throw new Error(
      "Real-time Gemini Live sessions are not available in the local API runtime yet. Use transcript import or wait for provider runtime completion.",
    );
  }

  public async disconnect() {
    this.isMuted = true;
  }
}

export const geminiLive = new GeminiLiveService();
