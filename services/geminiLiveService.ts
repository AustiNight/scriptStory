
import {
  GoogleGenAI,
  LiveServerMessage,
  Modality,
  Type,
  Tool,
  FunctionDeclaration
} from '@google/genai';
import { createPcmBlob, SAMPLE_RATE_INPUT } from './audioUtils';
import { WorkItem, WorkItemType, ContextSource } from '../types';

// --- Tool Definitions ---

const createWorkItemFunc: FunctionDeclaration = {
  name: 'createWorkItem',
  description: 'Create a new work item. STRICT validation rules apply based on "type".',
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, description: 'EPIC, FEATURE, STORY, TASK, or BUG.' },
      title: { type: Type.STRING, description: 'Short summary.' },
      description: { type: Type.STRING, description: 'Detailed description.' },
      parentId: { type: Type.STRING, description: 'Parent ID (optional).' },
      priority: { type: Type.STRING, description: 'Optional Priority.' },
      risk: { type: Type.STRING, description: 'Optional Risk.' },
      
      // Conditional Requirements defined in Prompt
      criteria: { 
        type: Type.ARRAY, 
        items: { 
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING, description: 'The Gherkin criteria text.' },
            met: { type: Type.BOOLEAN, description: 'Set to true if this requirement is already observed as working/demoed in UAT.' }
          }
        },
        description: 'Acceptance Criteria. MANDATORY for EPIC, FEATURE, STORY.' 
      },
      stepsToReproduce: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Numbered steps to reproduce the issue. MANDATORY for BUG.'
      },
      expectedResult: { type: Type.STRING, description: 'What should have happened. MANDATORY for BUG.' },
      actualResult: { type: Type.STRING, description: 'What actually happened. MANDATORY for BUG.' },
      
      // Batch linking
      tempId: { type: Type.STRING, description: 'Transactional ID (e.g. "E1") for batch linking.' },
      parentTempId: { type: Type.STRING, description: 'Parent Transactional ID (e.g. "E1") if parent created in same batch.' },
      relatedTempIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List of tempIds for sibling items (e.g. overlapping functionality).' }
    },
    required: ['type', 'title', 'description']
  }
};

const updateWorkItemFunc: FunctionDeclaration = {
  name: 'updateWorkItem',
  description: 'Update an existing work item.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: 'UUID of the item.' },
      title: { type: Type.STRING },
      description: { type: Type.STRING },
      priority: { type: Type.STRING },
      risk: { type: Type.STRING },
      addCriteria: { type: Type.STRING, description: 'Add Gherkin criteria.' },
      addStep: { type: Type.STRING, description: 'Add a step to reproduce.' },
      expectedResult: { type: Type.STRING },
      actualResult: { type: Type.STRING },
      parentId: { type: Type.STRING },
      addRelatedId: { type: Type.STRING, description: 'ID of a related item to link (non-hierarchical).' }
    },
    required: ['id']
  }
};

const deleteWorkItemFunc: FunctionDeclaration = {
  name: 'deleteWorkItem',
  description: 'Delete a specific work item permanently.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      id: { type: Type.STRING, description: 'UUID of the item to delete' }
    },
    required: ['id']
  }
};

const navigateFocusFunc: FunctionDeclaration = {
  name: 'navigateFocus',
  description: 'Focus on a specific item, a specific field within an item, or zoom out.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      targetId: { type: Type.STRING, description: 'ID of the item to focus on. Pass "null" or "board" to zoom out.' },
      targetField: { type: Type.STRING, description: 'Optional field to focus: "title", "description", "criteria", "meta", "risk"' }
    },
    required: ['targetId']
  }
};

const switchModeFunc: FunctionDeclaration = {
  name: 'switchMode',
  description: 'Switch the application view mode between MEETING and GROOMING.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mode: { type: Type.STRING, description: 'Target mode: MEETING or GROOMING' }
    },
    required: ['mode']
  }
};

const filterWorkItemsFunc: FunctionDeclaration = {
  name: 'filterWorkItems',
  description: 'Filter or sort the list of visible work items.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      type: { type: Type.STRING, description: 'WorkItemType to filter by (e.g., BUG, STORY)' },
      priority: { type: Type.STRING, description: 'Priority string' },
      searchQuery: { type: Type.STRING, description: 'Text query to filter or sort items by relevance (e.g. "login", "payment")' },
      clear: { type: Type.BOOLEAN, description: 'Set to true to clear all filters' }
    }
  }
};

const setVisualModeFunc: FunctionDeclaration = {
  name: 'setVisualMode',
  description: 'Control visual settings like background blur.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      enableBlur: { type: Type.BOOLEAN, description: 'True to enable background blur, false to disable it.' }
    },
    required: ['enableBlur']
  }
};

// Tool Sets
const TOOLS_COMMANDER: Tool[] = [{
  functionDeclarations: [
    createWorkItemFunc,
    updateWorkItemFunc,
    deleteWorkItemFunc,
    navigateFocusFunc,
    switchModeFunc,
    filterWorkItemsFunc,
    setVisualModeFunc
  ]
}];

const TOOLS_ANALYST: Tool[] = TOOLS_COMMANDER; // Analyst (batch) uses same tools

// --- Service Class ---

type ToolHandler = (name: string, args: any) => Promise<any>;
type TranscriptHandler = (text: string, isUser: boolean) => void;
export type SessionType = 'SCRIBE' | 'COMMANDER';

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private activeSession: any = null; // Store active session to close it
  
  // Audio Contexts
  private inputAudioContext: AudioContext | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  
  // Handlers
  private onToolCall: ToolHandler | null = null;
  private onTranscript: TranscriptHandler | null = null;

  // State
  private isMuted = true;
  private currentMode: SessionType = 'SCRIBE';

  constructor() {
    const apiKey = process.env.API_KEY || '';
    if (!apiKey) {
      console.error("API_KEY not found in environment variables");
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  public setHandlers(onToolCall: ToolHandler, onTranscript: TranscriptHandler) {
    this.onToolCall = onToolCall;
    this.onTranscript = onTranscript;
  }

  public setMute(muted: boolean) {
    this.isMuted = muted;
  }

  // --- BATCH ANALYSIS METHODS ---

  public async summarizeTranscript(transcript: string): Promise<string> {
    const prompt = `
      Summarize the following meeting transcript into 1 or 2 concise sentences. 
      Focus on the key work items discussed or decisions made.
      
      Transcript: "${transcript}"
    `;
    const response = await this.ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
    });
    return response.text.trim();
  }

  public async analyzeMeetingTranscript(
    transcript: string,
    projectContext: string,
    contextSources: ContextSource[]
  ): Promise<any[]> {
     if (!transcript.trim()) return [];

     const textSources = contextSources.filter(s => !s.mimeType || s.mimeType.startsWith('text/') || s.mimeType === 'application/json');
     const imageSources = contextSources.filter(s => s.mimeType && s.mimeType.startsWith('image/'));

     console.log(`Analyzing transcript with ${textSources.length} text docs and ${imageSources.length} images using Gemini 3 Pro.`);
     
     const knowledgeBaseText = textSources
        .map(src => `\n-- SOURCE: ${src.name} (${src.type}) --\n${src.content.substring(0, 15000)}...`)
        .join('\n');

     const textPrompt = `
        You are an expert Agile Architect and Product Owner (The "Architect").
        
        **YOUR MISSION**: 
        Analyze the "TRANSCRIPT SEGMENT" below and generate a comprehensive set of Work Items.
        You MUST break down large requirements into a proper hierarchy (Epic -> Feature -> Story).
        
        ---------------------------------------------------------
        **CRITICAL: DISCRIMINATE BETWEEN EXISTING vs. NEW**:
        You must determine if a topic is a *Demo of existing software* or a *Discussion of new requirements*.
        
        1. **Check Image Sources**:
           - **'UAT', 'PROD', 'LIVE', 'DEMO'** in filenames: This implies the feature **ALREADY EXISTS**. 
           - **'PROTOTYPE', 'MOCKUP', 'DESIGN'** in filenames: This implies the feature is **NEW / TO BE BUILT**.
           
        2. **Check Transcript Context**:
           - Words like "Here we have...", "As you can see...", "This is working..." indicate a **DEMO**.
           - Words like "We need to...", "It should...", "I want..." indicate a **REQUIREMENT**.
           
        3. **Action Rules**:
           - **EXISTING FEATURE (Demo)**: 
             - If a feature is demoed and working, create a User Story but **MARK ALL CRITERIA AS MET** (met: true).
             - Use this to acknowledge the feature exists and then create **TASKS** or **BUGS** for any follow-up discussed.
             - **DO NOT** create a "To Do" User Story for something already visible in a UAT site.
             
           - **NEW FEATURE (Prototype/Discussion)**:
             - Create standard **EPIC / FEATURE / STORY** items with met: false.

        ---------------------------------------------------------
        **CRITICAL: DATA VALIDATION PROTOCOLS**:
        
        1. **IF TYPE = EPIC, FEATURE, or STORY**:
           - **Title**: Required.
           - **Description**: Required.
           - **Acceptance Criteria**: **MANDATORY**. Provide objects with 'text' and 'met' (boolean).
           
        2. **IF TYPE = BUG**:
           - **Title**: Required.
           - **Description**: Required.
           - **Steps To Reproduce**: **MANDATORY**.
           - **Expected Result**: **MANDATORY**.
           - **Actual Result**: **MANDATORY**.
           
        3. **IF TYPE = TASK**:
           - **Title**: Required.
           - **Description**: Required.

        ---------------------------------------------------------
        **HIERARCHY & LINKING RULES**:
           - Link using 'tempId' and 'parentTempId'.
           
        **KNOWLEDGE BASE UTILIZATION**: 
           - Use provided documentation and images for technical specifics.
        ---------------------------------------------------------
        
        /// EXISTING BOARD CONTEXT (Active Items) ///
        ${projectContext}
        
        /// KNOWLEDGE BASE (Reference Material) ///
        ${knowledgeBaseText || "No text documentation provided."}
        
        /// TRANSCRIPT SEGMENT (The Requirement Source) ///
        "${transcript}"
     `;

     const parts: any[] = [{ text: textPrompt }];
     for (const img of imageSources) {
         if (img.mimeType && img.content) {
             parts.push({ text: `\n[IMAGE CONTEXT: Filename="${img.name}"]\n` });
             parts.push({
                 inlineData: {
                     mimeType: img.mimeType,
                     data: img.content 
                 }
             });
         }
     }

     const response = await this.ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: [{ role: 'user', parts: parts }],
        config: { tools: TOOLS_ANALYST }
     });
     return response.functionCalls || [];
  }

  public async refineFieldContent(
    rawTranscript: string,
    fieldName: string,
    currentItem: WorkItem,
    projectContext: string
  ): Promise<string> {
    const prompt = `
      Refine this field content. Field: ${fieldName}. Item: ${currentItem.type}.
      Context: ${projectContext}
      Input: "${rawTranscript}"
    `;
    const response = await this.ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt
    });
    return response.text.trim();
  }

  public async connect(mode: SessionType) {
    await this.disconnect();
    this.currentMode = mode;
    if (!this.inputAudioContext) {
        this.inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE_INPUT });
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    let config: any = {
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
    };
    if (mode === 'SCRIBE') {
        config.systemInstruction = `You are a passive scribe. Listen and transcribe.`;
    } else if (mode === 'COMMANDER') {
        config.systemInstruction = `Voice interface controller. Execute user commands.`;
        config.tools = TOOLS_COMMANDER;
    }
    this.sessionPromise = this.ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: config,
      callbacks: {
        onopen: () => {
          this.startAudioStream(stream);
        },
        onmessage: async (msg: LiveServerMessage) => {
          this.handleMessage(msg);
        },
        onclose: () => {
          this.activeSession = null;
        },
        onerror: (err) => console.error("Gemini Live Error", err)
      }
    });
    this.activeSession = await this.sessionPromise;
  }

  public async disconnect() {
    if (this.inputSource) {
        this.inputSource.disconnect();
        this.inputSource = null;
    }
    if (this.processor) {
        this.processor.disconnect();
        this.processor = null;
    }
    if (this.activeSession) {
      try {
        this.activeSession.close();
      } catch (e) {
        console.warn("Error closing session", e);
      }
      this.activeSession = null;
    }
    this.sessionPromise = null;
  }

  private startAudioStream(stream: MediaStream) {
    if (!this.inputAudioContext) return;
    this.inputSource = this.inputAudioContext.createMediaStreamSource(stream);
    this.processor = this.inputAudioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      if (!this.sessionPromise || this.isMuted) return;
      const inputData = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      if (rms < 0.002) inputData.fill(0); 
      const pcmBlob = createPcmBlob(inputData);
      this.sessionPromise!.then(session => {
        session.sendRealtimeInput({ media: pcmBlob });
      });
    };
    this.inputSource.connect(this.processor);
    this.processor.connect(this.inputAudioContext.destination);
  }

  private async handleMessage(message: LiveServerMessage) {
    const text = message.serverContent?.inputTranscription?.text;
    if (text && this.onTranscript) this.onTranscript(text, true);
    if (message.toolCall && this.onToolCall) {
        for (const call of message.toolCall.functionCalls) {
            try {
                const result = await this.onToolCall(call.name, call.args);
                this.sessionPromise?.then(session => {
                    session.sendToolResponse({
                        functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { result: JSON.stringify(result) }
                        }]
                    });
                });
            } catch (e: any) {
                this.sessionPromise?.then(session => {
                     session.sendToolResponse({
                         functionResponses: [{ id: call.id, name: call.name, response: { error: e.message } }]
                     });
                 });
            }
        }
    }
  }
}

export const geminiLive = new GeminiLiveService();
