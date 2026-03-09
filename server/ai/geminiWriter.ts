import { GoogleGenAI } from "@google/genai";
import {
  PROVIDER_CAPABILITY_MATRIX,
  type WriterProvider,
} from "../../config/providerContracts.ts";
import {
  GEMINI_ANALYST_TOOLS,
  normalizeToolCalls,
  type NormalizedToolCall,
} from "./toolCallContracts.ts";
import type { ContextSourceInput, WorkItemInput } from "./types.ts";
import {
  buildAnalyzePrompt,
  buildDecompositionFollowUpPrompt,
  buildKnowledgeBaseText,
  buildRefinePrompt,
  buildSummarizePrompt,
  isImageSource,
  isTextSource,
  mergeNormalizedToolCalls,
  needsHierarchicalDecompositionPass,
} from "./writerLogic.ts";

interface GeminiRawToolCall {
  name: string;
  arguments: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
};

const extractResponseText = (response: unknown): string => {
  const text =
    response &&
    typeof response === "object" &&
    typeof (response as { text?: unknown }).text === "string"
      ? String((response as { text: string }).text)
      : "";
  return text.trim();
};

const extractToolCalls = (response: unknown): GeminiRawToolCall[] => {
  const responseRecord = asRecord(response);
  if (!responseRecord) {
    return [];
  }

  const functionCalls = Array.isArray(responseRecord.functionCalls)
    ? responseRecord.functionCalls
    : [];

  const calls: GeminiRawToolCall[] = [];
  for (const entry of functionCalls) {
    const record = asRecord(entry);
    if (!record || typeof record.name !== "string") {
      continue;
    }

    calls.push({
      name: record.name,
      arguments: record.args ?? {},
    });
  }

  return calls;
};

export class GeminiWriter
  implements WriterProvider<ContextSourceInput, WorkItemInput, NormalizedToolCall>
{
  private readonly ai: GoogleGenAI;
  public readonly id = "gemini" as const;
  public readonly capabilities = PROVIDER_CAPABILITY_MATRIX.gemini;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  public async summarizeTranscript(transcript: string, _providerConfig?: unknown): Promise<string> {
    const prompt = buildSummarizePrompt(transcript);

    const response = await this.ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    return extractResponseText(response);
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSourceInput[],
    _providerConfig?: unknown,
  ): Promise<NormalizedToolCall[]> {
    if (!transcript.trim()) {
      return [];
    }

    const enabledSources = contextSources.filter((source) => source.enabled !== false);
    const textSources = enabledSources.filter(isTextSource);
    const imageSources = enabledSources.filter(isImageSource);
    const knowledgeBaseText = buildKnowledgeBaseText(textSources);
    const prompt = buildAnalyzePrompt(transcript, projectContext, knowledgeBaseText);

    const runAnalysisPass = async (
      passPrompt: string,
      includeImages: boolean,
    ): Promise<NormalizedToolCall[]> => {
      const parts: Array<Record<string, unknown>> = [{ text: passPrompt }];

      if (includeImages) {
        for (const image of imageSources) {
          if (!image.mimeType || !image.content) {
            continue;
          }

          parts.push({ text: `\n[IMAGE CONTEXT: Filename=\"${image.name}\"]\n` });
          parts.push({
            inlineData: {
              mimeType: image.mimeType,
              data: image.content,
            },
          });
        }
      }

      const response = await this.ai.models.generateContent({
        model: "gemini-3-pro-preview",
        contents: [{ role: "user", parts }],
        config: { tools: GEMINI_ANALYST_TOOLS },
      });

      const rawCalls = extractToolCalls(response);
      return normalizeToolCalls(rawCalls);
    };

    const firstPassCalls = await runAnalysisPass(prompt, true);
    if (!needsHierarchicalDecompositionPass(firstPassCalls)) {
      return firstPassCalls;
    }

    try {
      const decompositionPrompt = buildDecompositionFollowUpPrompt(
        transcript,
        projectContext,
        firstPassCalls,
      );
      const decompositionCalls = await runAnalysisPass(decompositionPrompt, false);
      return mergeNormalizedToolCalls(firstPassCalls, decompositionCalls);
    } catch {
      return firstPassCalls;
    }
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItemInput,
    projectContext: string,
    _providerConfig?: unknown,
  ): Promise<string> {
    const prompt = buildRefinePrompt(rawTranscript, fieldName, currentItem, projectContext);

    const response = await this.ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    return extractResponseText(response);
  }
}
