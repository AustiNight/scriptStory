
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { WorkItem, WorkItemType, Priority, Risk, CreateWorkItemArgs, UpdateWorkItemArgs, AppMode, SavedTranscript, ADOConfig, FilterState, FilterArgs, VisualArgs, DeleteArgs, SwitchModeArgs, FIBONACCI_SEQUENCE, SearchMode, PushedItemLog, ContextSource, WorkItemContextTrace } from './types';
import { geminiLive, SessionType, DEFAULT_CONTEXT_POLICY_CONFIG, sanitizeContextPolicyConfig, type AiDiagnosticsSnapshot, type AiProviderCatalog, type ContextPolicyConfig } from './services/geminiLiveService';
import { DEFAULT_PROVIDER_SELECTION, sanitizeProviderSelection, type ProviderSelection, type TranscriptionProviderId, type WriterProviderId } from './config/providerContracts';
import { DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG, sanitizeWriterProviderRuntimeConfig, type AnthropicWriterRuntimeConfig, type OpenAIWriterRuntimeConfig, type WriterProviderRuntimeConfig } from './config/providerRuntimeConfig';
import { pushToADO } from './services/adoService';
import { parseDocument } from './services/documentUtils';
import Visualizer from './components/Visualizer';
import { WorkItemCard, Relationship } from './components/WorkItemCard';

// Simple UUID generator
const generateId = () => Math.random().toString(36).substring(2, 15);

// --- Initial Mock Data ---
const INITIAL_ITEMS: WorkItem[] = [
  {
    id: '1',
    type: WorkItemType.EPIC,
    title: 'Voice-First Requirements Engine',
    description: 'The system should allow users to define software specs entirely through voice conversation.',
    priority: Priority.MUST_DO,
    risk: Risk.HIGH,
    storyPoints: 13,
    criteria: [],
    aiNotes: 'Ensure latency is under 500ms for voice feedback.'
  },
  {
    id: '2',
    type: WorkItemType.FEATURE,
    title: 'Spatial Backlog View',
    description: 'A 3D carousel interface that allows "focusing" on items rather than a flat grid. It should use a Lens metaphor.',
    priority: Priority.HIGH_VALUE,
    risk: Risk.MEDIUM,
    storyPoints: 8,
    criteria: [
        { id: 'c1', text: 'Given the user is on the board, When they select an item, Then background items blur', met: true },
        { id: 'c2', text: 'Given a focused item, When the user looks at the description, Then it warps to center', met: true }
    ],
    parentId: '1'
  },
  {
    id: '3',
    type: WorkItemType.STORY,
    title: 'Gemini Live Integration',
    description: 'As a developer, I want to stream audio to Gemini so that it can update the backlog in real-time.',
    priority: Priority.MUST_DO,
    risk: Risk.HIGH,
    storyPoints: 5,
    criteria: [],
    parentId: '1'
  }
];

type SettingsTab = 'ADO' | 'KNOWLEDGE' | 'AI_PROVIDERS' | 'MCP_SERVERS' | 'CONTEXT_POLICY' | 'DIAGNOSTICS';
type McpTransport = 'http' | 'command';
type McpAuthType = 'none' | 'bearer' | 'basic' | 'header';

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

interface McpServerHealthState {
  state: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  lastFailureAt?: string;
  lastFailureReason?: string;
  lastSuccessAt?: string;
  lastLatencyMs?: number;
  retryAfterMs: number;
}

interface McpServerAuthView {
  type: McpAuthType;
  envVar?: string;
  username?: string;
  passwordEnvVar?: string;
  headerName?: string;
  valueEnvVar?: string;
  hasSecret?: boolean;
}

interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  endpointOrCommand: string;
  auth: McpServerAuthView;
  enabled: boolean;
  priority: number;
  timeouts: {
    requestMs: number;
    cooldownMs: number;
    failureThreshold: number;
  };
  maxPayload: number;
  allowedResources: string[];
  createdAt: string;
  updatedAt: string;
  health: McpServerHealthState;
}

interface McpServerFormState {
  id: string;
  name: string;
  transport: McpTransport;
  endpointOrCommand: string;
  enabled: boolean;
  priority: number;
  requestMs: number;
  cooldownMs: number;
  failureThreshold: number;
  maxPayload: number;
  allowedResourcesText: string;
  authType: McpAuthType;
  bearerToken: string;
  bearerEnvVar: string;
  basicUsername: string;
  basicPassword: string;
  basicPasswordEnvVar: string;
  headerName: string;
  headerValue: string;
  headerValueEnvVar: string;
  preserveExistingSecret: boolean;
}

interface McpServerTestResult {
  serverId: string;
  serverName: string;
  transport: McpTransport;
  reachable: boolean;
  latencyMs: number;
  statusCode?: number;
  errorCode?: string;
  errorMessage?: string;
}

const createDefaultMcpServerForm = (): McpServerFormState => ({
  id: '',
  name: '',
  transport: 'http',
  endpointOrCommand: '',
  enabled: true,
  priority: 100,
  requestMs: 12000,
  cooldownMs: 30000,
  failureThreshold: 3,
  maxPayload: 16000,
  allowedResourcesText: '',
  authType: 'none',
  bearerToken: '',
  bearerEnvVar: '',
  basicUsername: '',
  basicPassword: '',
  basicPasswordEnvVar: '',
  headerName: '',
  headerValue: '',
  headerValueEnvVar: '',
  preserveExistingSecret: false,
});

const toApiErrorMessage = <T,>(envelope: ApiEnvelope<T>, status: number): string => {
  if (!envelope.ok && envelope.error?.message) {
    return envelope.error.message;
  }
  return `Request failed (${status})`;
};

export default function App() {
  // -- State --
  const [items, setItems] = useState<WorkItem[]>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_items');
          return saved ? JSON.parse(saved) : INITIAL_ITEMS;
      } catch (e) {
          console.error("Failed to load items from storage", e);
          return INITIAL_ITEMS;
      }
  });

  const [mode, setMode] = useState<AppMode>(AppMode.MEETING);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [filterState, setFilterState] = useState<FilterState>({ searchMode: 'TEXT' });
  const [blurEnabled, setBlurEnabled] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [isMeetingRunning, setIsMeetingRunning] = useState(false);
  const [isCommanding, setIsCommanding] = useState(false);
  const [activeSessionType, setActiveSessionType] = useState<SessionType | null>(null);
  const [transcript, setTranscript] = useState<{role: string, text: string}[]>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_active_transcript');
          return saved ? JSON.parse(saved) : [];
      } catch { return []; }
  });
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzingMeeting, setIsAnalyzingMeeting] = useState(false); 
  const [savedTranscripts, setSavedTranscripts] = useState<SavedTranscript[]>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_saved_transcripts');
          return saved ? JSON.parse(saved) : [];
      } catch { return []; }
  });
  const [pushedLogs, setPushedLogs] = useState<PushedItemLog[]>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_pushed_logs');
          return saved ? JSON.parse(saved) : [];
      } catch { return []; }
  });
  const [showTranscripts, setShowTranscripts] = useState(false);
  const [adoConfig, setAdoConfig] = useState<ADOConfig>(() => {
      try {
          const savedSecure = localStorage.getItem('semantic_lens_ado_config_secure');
          if (savedSecure) return JSON.parse(decodeURIComponent(atob(savedSecure)));
          const savedLegacy = localStorage.getItem('semantic_lens_ado_config');
          return savedLegacy ? JSON.parse(savedLegacy) : { organization: 'towne-park', project: 'Towne Park Billing', pat: '' };
      } catch (e) {
          return { organization: 'towne-park', project: 'Towne Park Billing', pat: '' };
      }
  });
  const [contextSources, setContextSources] = useState<ContextSource[]>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_context_sources');
          return saved ? JSON.parse(saved) : [];
      } catch { return []; }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('AI_PROVIDERS');
  const [providerSelection, setProviderSelection] = useState<ProviderSelection>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_provider_selection');
          if (!saved) return { ...DEFAULT_PROVIDER_SELECTION };
          return sanitizeProviderSelection(JSON.parse(saved));
      } catch {
          return { ...DEFAULT_PROVIDER_SELECTION };
      }
  });
  const [writerProviderRuntimeConfig, setWriterProviderRuntimeConfig] = useState<WriterProviderRuntimeConfig>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_writer_provider_runtime_config');
          if (!saved) return { ...DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG };
          return sanitizeWriterProviderRuntimeConfig(JSON.parse(saved));
      } catch {
          return { ...DEFAULT_WRITER_PROVIDER_RUNTIME_CONFIG };
      }
  });
  const [contextPolicyConfig, setContextPolicyConfig] = useState<ContextPolicyConfig>(() => {
      try {
          const saved = localStorage.getItem('semantic_lens_context_policy');
          if (!saved) return { ...DEFAULT_CONTEXT_POLICY_CONFIG };
          return sanitizeContextPolicyConfig(JSON.parse(saved));
      } catch {
          return { ...DEFAULT_CONTEXT_POLICY_CONFIG };
      }
  });
  const [manualEnrichPending, setManualEnrichPending] = useState(false);
  const [providerCatalog, setProviderCatalog] = useState<AiProviderCatalog | null>(null);
  const [providerCatalogError, setProviderCatalogError] = useState<string | null>(null);
  const [isProviderCatalogLoading, setIsProviderCatalogLoading] = useState(false);
  const [diagnosticsSnapshot, setDiagnosticsSnapshot] = useState<AiDiagnosticsSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [isDiagnosticsLoading, setIsDiagnosticsLoading] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerView[]>([]);
  const [isMcpLoading, setIsMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpEditor, setMcpEditor] = useState<McpServerFormState>(() => createDefaultMcpServerForm());
  const [editingMcpServerId, setEditingMcpServerId] = useState<string | null>(null);
  const [isSavingMcpServer, setIsSavingMcpServer] = useState(false);
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, McpServerTestResult>>({});
  const [mcpTestingById, setMcpTestingById] = useState<Record<string, boolean>>({});
  const [newSourceText, setNewSourceText] = useState('');
  const [newSourceTitle, setNewSourceTitle] = useState('');
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [isPushingToADO, setIsPushingToADO] = useState(false);

  // -- Refs --
  const prevMeetingState = useRef(false);
  const burstTranscript = useRef<string>(""); 
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextFileInputRef = useRef<HTMLInputElement>(null);
  const transcriptBufferRef = useRef<string>("");
  const transcriptScrollRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  const contextSourcesRef = useRef(contextSources);
  const providerSelectionRef = useRef(providerSelection);
  const contextPolicyRef = useRef(contextPolicyConfig);
  const manualEnrichPendingRef = useRef(manualEnrichPending);
  
  // Persistence Effects
  useEffect(() => {
      localStorage.setItem('semantic_lens_items', JSON.stringify(items));
      itemsRef.current = items;
  }, [items]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_active_transcript', JSON.stringify(transcript));
  }, [transcript]);
  useEffect(() => {
      if (adoConfig.organization || adoConfig.project || adoConfig.pat) {
        try {
            const encoded = btoa(encodeURIComponent(JSON.stringify(adoConfig)));
            localStorage.setItem('semantic_lens_ado_config_secure', encoded);
            localStorage.removeItem('semantic_lens_ado_config');
        } catch (e) { console.error("Failed to save ADO config securely", e); }
      }
  }, [adoConfig]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_saved_transcripts', JSON.stringify(savedTranscripts));
  }, [savedTranscripts]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_pushed_logs', JSON.stringify(pushedLogs));
  }, [pushedLogs]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_context_sources', JSON.stringify(contextSources));
      contextSourcesRef.current = contextSources;
  }, [contextSources]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_provider_selection', JSON.stringify(providerSelection));
      geminiLive.setProviderSelection(providerSelection);
      providerSelectionRef.current = providerSelection;
  }, [providerSelection]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_writer_provider_runtime_config', JSON.stringify(writerProviderRuntimeConfig));
      geminiLive.setWriterProviderRuntimeConfig(writerProviderRuntimeConfig);
  }, [writerProviderRuntimeConfig]);
  useEffect(() => {
      localStorage.setItem('semantic_lens_context_policy', JSON.stringify(contextPolicyConfig));
      geminiLive.setContextPolicyConfig(contextPolicyConfig);
      contextPolicyRef.current = contextPolicyConfig;
  }, [contextPolicyConfig]);
  useEffect(() => {
      manualEnrichPendingRef.current = manualEnrichPending;
  }, [manualEnrichPending]);

  // -- Helper: Search Logic --
  const checkMatch = useCallback((text: string | undefined, query: string, mode: SearchMode): boolean => {
      if (!text || !query) return false;
      if (mode === 'TEXT') return text.toLowerCase().includes(query.toLowerCase());
      if (mode === 'WILDCARD') {
          const escaped = query.toLowerCase().split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
          return new RegExp(escaped, 'i').test(text);
      }
      if (mode === 'REGEX') {
          try { return new RegExp(query, 'i').test(text); } catch { return false; }
      }
      return false;
  }, []);

  const itemMatchesFilter = useCallback((item: WorkItem) => {
    if (filterState.type && item.type !== filterState.type) return false;
    if (filterState.priority && item.priority !== filterState.priority) return false;
    if (filterState.storyPoints !== undefined && item.storyPoints !== filterState.storyPoints) return false;
    if (filterState.search) {
        const q = filterState.search;
        const m = filterState.searchMode || 'TEXT';
        if (!checkMatch(item.title, q, m) && !checkMatch(item.description, q, m) && 
            !checkMatch(item.priority, q, m) && !checkMatch(item.risk, q, m) && 
            !checkMatch(item.storyPoints?.toString(), q, m) && !item.criteria.some(c => checkMatch(c.text, q, m))) return false;
    }
    return true;
  }, [filterState, checkMatch]);

  const performReplace = () => {
      if (!findText || !replaceText) return;
      setItems(prev => prev.map(item => {
          if (!itemMatchesFilter(item)) return item;
          let newItem = { ...item };
          let hasChange = false;
          const applyReplace = (val: string) => {
             if (filterState.searchMode === 'REGEX') {
                 try { return val.replace(new RegExp(findText, 'gi'), replaceText); } catch { return val; }
             }
             return val.split(findText).join(replaceText);
          };
          const newTitle = applyReplace(item.title);
          if (newTitle !== item.title) { newItem.title = newTitle; hasChange = true; }
          const newDesc = applyReplace(item.description);
          if (newDesc !== item.description) { newItem.description = newDesc; hasChange = true; }
          const newCriteria = item.criteria.map(c => ({ ...c, text: applyReplace(c.text) }));
          if (JSON.stringify(newCriteria) !== JSON.stringify(item.criteria)) { newItem.criteria = newCriteria; hasChange = true; }
          return hasChange ? newItem : item;
      }));
  };

  const handleManualUpdate = useCallback((id: string, updates: Partial<WorkItem>) => {
      setItems(prev => prev.map(item => item.id === id ? { ...item, ...updates } : item));
  }, []);

  const buildContextTrace = useCallback(
      (
          callName: string,
          provider: WriterProviderId,
          metadata: unknown,
      ): WorkItemContextTrace | undefined => {
          if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
              return undefined;
          }

          const candidate = metadata as Record<string, unknown>;
          const citations = Array.isArray(candidate.citations) ? candidate.citations : [];
          const retrieval = candidate.retrieval;
          const confidence = candidate.confidence;
          if (!retrieval || typeof retrieval !== 'object' || !confidence || typeof confidence !== 'object') {
              return undefined;
          }

          return {
              callName,
              provider,
              recordedAt: Date.now(),
              citations: citations as WorkItemContextTrace['citations'],
              retrieval: retrieval as WorkItemContextTrace['retrieval'],
              confidence: confidence as WorkItemContextTrace['confidence'],
          };
      },
      [],
  );
  
  const createWorkItem = useCallback(async (args: CreateWorkItemArgs, contextTrace?: WorkItemContextTrace) => {
    const tempIdMap: Map<string, string> = (window as any)._batchIdMap || new Map();
    if (!(window as any)._batchIdMap) (window as any)._batchIdMap = tempIdMap;

    const newId = generateId();
    if (args.tempId) tempIdMap.set(args.tempId, newId);

    let finalParentId = args.parentId || null;
    if (args.parentTempId && tempIdMap.has(args.parentTempId)) finalParentId = tempIdMap.get(args.parentTempId)!;
    
    const resolvedRelatedIds: string[] = [];
    if (args.relatedTempIds) args.relatedTempIds.forEach(tid => { if (tempIdMap.has(tid)) resolvedRelatedIds.push(tempIdMap.get(tid)!); });

    const newItem: WorkItem = {
      id: newId,
      type: (args.type?.toUpperCase() as WorkItemType) || WorkItemType.STORY,
      title: args.title,
      description: args.description,
      priority: (args.priority as Priority) || Priority.HIGH_VALUE,
      // Respect 'met' status from AI if provided
      criteria: args.criteria ? args.criteria.map(c => ({ id: generateId(), text: c.text, met: !!c.met })) : [],
      parentId: finalParentId,
      relatedIds: resolvedRelatedIds.length > 0 ? resolvedRelatedIds : undefined,
      stepsToReproduce: args.stepsToReproduce,
      expectedResult: args.expectedResult,
      actualResult: args.actualResult,
      contextTrace,
    };
    
    setItems(prev => [...prev, newItem]);
    if (mode === AppMode.GROOMING) { setFocusedItemId(newItem.id); setFocusedField('description'); }
    return `Created ${newItem.type} titled "${newItem.title}"`;
  }, [mode]);

  const updateWorkItem = useCallback(async (args: UpdateWorkItemArgs, contextTrace?: WorkItemContextTrace) => {
    let updatedTitle = '';
    setItems(prev => prev.map(item => {
      if (item.id === args.id || (focusedItemId === item.id && !args.id)) {
        updatedTitle = args.title || item.title;
        const updatedItem = { ...item };
        if (args.title) updatedItem.title = args.title;
        if (args.description) updatedItem.description = args.description;
        if (args.priority) updatedItem.priority = (args.priority as Priority);
        if (args.risk) updatedItem.risk = (args.risk as Risk);
        if (args.parentId) updatedItem.parentId = args.parentId;
        if (args.storyPoints !== undefined) updatedItem.storyPoints = args.storyPoints;
        if (args.addCriteria) updatedItem.criteria = [...updatedItem.criteria, { id: generateId(), text: args.addCriteria, met: false }];
        if (args.addStep && updatedItem.type === WorkItemType.BUG) updatedItem.stepsToReproduce = [...(updatedItem.stepsToReproduce || []), args.addStep];
        if (args.expectedResult) updatedItem.expectedResult = args.expectedResult;
        if (args.actualResult) updatedItem.actualResult = args.actualResult;
        if (args.addRelatedId) {
             const existingRelated = updatedItem.relatedIds || [];
             if (!existingRelated.includes(args.addRelatedId)) updatedItem.relatedIds = [...existingRelated, args.addRelatedId];
        }
        if (contextTrace) updatedItem.contextTrace = contextTrace;
        return updatedItem;
      }
      return item;
    }));
    return `Updated item ${updatedTitle}`;
  }, [focusedItemId]);

  const deleteWorkItem = useCallback(async (args: DeleteArgs) => {
      setItems(prev => prev.filter(i => i.id !== args.id));
      if (focusedItemId === args.id) setFocusedItemId(null);
      return `Deleted item`;
  }, [focusedItemId]);

  const navigateFocus = useCallback(async (args: { targetId: string | null, targetField?: string }) => {
    if (mode === AppMode.MEETING && args.targetId) setMode(AppMode.GROOMING);
    if (!args.targetId || args.targetId === 'board' || args.targetId === 'null') {
      setFocusedItemId(null); setFocusedField(null); return "Zoomed out.";
    }
    const target = items.find(i => i.id === args.targetId || i.title.toLowerCase().includes(args.targetId.toLowerCase()));
    if (target) { setFocusedItemId(target.id); if (args.targetField) setFocusedField(args.targetField); return `Focused on ${target.title}`; }
    return "Not found.";
  }, [items, mode]);

  const handleFilter = useCallback(async (args: FilterArgs) => {
      if (args.clear) { setFilterState({ searchMode: 'TEXT' }); return "Cleared."; }
      setFilterState(prev => ({ ...prev, type: args.type as WorkItemType, priority: args.priority as Priority, storyPoints: args.storyPoints, search: args.searchQuery }));
      return `Filtered.`;
  }, []);

  const handleVisuals = useCallback(async (args: VisualArgs) => { setBlurEnabled(args.enableBlur); return `Blur ${args.enableBlur}.`; }, []);
  const handleSwitchMode = useCallback(async (args: SwitchModeArgs) => { setMode(args.mode.toUpperCase() === 'MEETING' ? AppMode.MEETING : AppMode.GROOMING); return `Switched.`; }, []);

  const requestApi = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const response = await fetch(path, init);
      const envelope = await response.json() as ApiEnvelope<T>;
      if (!response.ok || !envelope.ok) {
          throw new Error(toApiErrorMessage(envelope, response.status));
      }
      return envelope.data;
  }, []);

  const refreshProviderCatalog = useCallback(async () => {
      setIsProviderCatalogLoading(true);
      setProviderCatalogError(null);
      try {
          const data = await geminiLive.fetchProviderCatalog();
          setProviderCatalog(data);
      } catch (e: any) {
          setProviderCatalogError(e.message || 'Failed to load AI provider status.');
      } finally {
          setIsProviderCatalogLoading(false);
      }
  }, []);

  const refreshDiagnostics = useCallback(async () => {
      setIsDiagnosticsLoading(true);
      setDiagnosticsError(null);
      try {
          const data = await geminiLive.fetchDiagnostics();
          setDiagnosticsSnapshot(data);
      } catch (e: any) {
          setDiagnosticsError(e.message || 'Failed to load diagnostics telemetry.');
      } finally {
          setIsDiagnosticsLoading(false);
      }
  }, []);

  const refreshMcpServers = useCallback(async () => {
      setIsMcpLoading(true);
      setMcpError(null);
      try {
          const data = await requestApi<{ schemaVersion: number; servers: McpServerView[] }>('/api/mcp/servers');
          const sorted = [...data.servers].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
          setMcpServers(sorted);
      } catch (e: any) {
          setMcpError(e.message || 'Failed to load MCP servers.');
      } finally {
          setIsMcpLoading(false);
      }
  }, [requestApi]);

  const resetMcpEditor = () => {
      setEditingMcpServerId(null);
      setMcpEditor(createDefaultMcpServerForm());
  };

  const loadMcpServerIntoEditor = (server: McpServerView) => {
      setEditingMcpServerId(server.id);
      setMcpEditor({
          id: server.id,
          name: server.name,
          transport: server.transport,
          endpointOrCommand: server.endpointOrCommand,
          enabled: server.enabled,
          priority: server.priority,
          requestMs: server.timeouts.requestMs,
          cooldownMs: server.timeouts.cooldownMs,
          failureThreshold: server.timeouts.failureThreshold,
          maxPayload: server.maxPayload,
          allowedResourcesText: (server.allowedResources || []).join('\n'),
          authType: (server.auth?.type || 'none') as McpAuthType,
          bearerToken: '',
          bearerEnvVar: server.auth?.type === 'bearer' ? (server.auth.envVar || '') : '',
          basicUsername: server.auth?.type === 'basic' ? (server.auth.username || '') : '',
          basicPassword: '',
          basicPasswordEnvVar: server.auth?.type === 'basic' ? (server.auth.passwordEnvVar || '') : '',
          headerName: server.auth?.type === 'header' ? (server.auth.headerName || '') : '',
          headerValue: '',
          headerValueEnvVar: server.auth?.type === 'header' ? (server.auth.valueEnvVar || '') : '',
          preserveExistingSecret: Boolean(server.auth?.hasSecret),
      });
  };

  const buildMcpAuthPayload = (form: McpServerFormState) => {
      if (form.authType === 'none') {
          return { type: 'none' as const };
      }

      if (form.authType === 'bearer') {
          const token = form.bearerToken.trim();
          const envVar = form.bearerEnvVar.trim();
          return {
              type: 'bearer' as const,
              ...(token ? { token } : {}),
              ...(envVar ? { envVar } : {}),
              ...(!token && !envVar && form.preserveExistingSecret ? { hasSecret: true } : {}),
          };
      }

      if (form.authType === 'basic') {
          const password = form.basicPassword.trim();
          const passwordEnvVar = form.basicPasswordEnvVar.trim();
          return {
              type: 'basic' as const,
              username: form.basicUsername.trim(),
              ...(password ? { password } : {}),
              ...(passwordEnvVar ? { passwordEnvVar } : {}),
              ...(!password && !passwordEnvVar && form.preserveExistingSecret ? { hasSecret: true } : {}),
          };
      }

      const headerValue = form.headerValue.trim();
      const valueEnvVar = form.headerValueEnvVar.trim();
      return {
          type: 'header' as const,
          headerName: form.headerName.trim(),
          ...(headerValue ? { headerValue } : {}),
          ...(valueEnvVar ? { valueEnvVar } : {}),
          ...(!headerValue && !valueEnvVar && form.preserveExistingSecret ? { hasSecret: true } : {}),
      };
  };

  const saveMcpServer = async () => {
      setIsSavingMcpServer(true);
      setMcpError(null);
      try {
          const payload = {
              ...(editingMcpServerId ? {} : { id: mcpEditor.id.trim() || undefined }),
              name: mcpEditor.name.trim(),
              transport: mcpEditor.transport,
              endpointOrCommand: mcpEditor.endpointOrCommand.trim(),
              auth: buildMcpAuthPayload(mcpEditor),
              enabled: mcpEditor.enabled,
              priority: mcpEditor.priority,
              timeouts: {
                  requestMs: mcpEditor.requestMs,
                  cooldownMs: mcpEditor.cooldownMs,
                  failureThreshold: mcpEditor.failureThreshold,
              },
              maxPayload: mcpEditor.maxPayload,
              allowedResources: mcpEditor.allowedResourcesText
                  .split('\n')
                  .map(line => line.trim())
                  .filter(Boolean),
          };

          if (editingMcpServerId) {
              await requestApi<{ server: McpServerView }>(
                  `/api/mcp/servers/${encodeURIComponent(editingMcpServerId)}`,
                  {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(payload),
                  },
              );
          } else {
              await requestApi<{ server: McpServerView }>('/api/mcp/servers', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(payload),
              });
          }

          resetMcpEditor();
          await refreshMcpServers();
      } catch (e: any) {
          setMcpError(e.message || 'Failed to save MCP server.');
      } finally {
          setIsSavingMcpServer(false);
      }
  };

  const deleteMcpServer = async (serverId: string) => {
      if (!window.confirm(`Delete MCP server "${serverId}"?`)) return;
      setMcpError(null);
      try {
          await requestApi<{ deleted: boolean; id: string }>(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
              method: 'DELETE',
          });
          if (editingMcpServerId === serverId) resetMcpEditor();
          await refreshMcpServers();
      } catch (e: any) {
          setMcpError(e.message || 'Failed to delete MCP server.');
      }
  };

  const toggleMcpServerEnabled = async (serverId: string, enabled: boolean) => {
      setMcpError(null);
      try {
          await requestApi<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(serverId)}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled }),
          });
          await refreshMcpServers();
      } catch (e: any) {
          setMcpError(e.message || 'Failed to update enabled state.');
      }
  };

  const testMcpServerConnection = async (serverId: string) => {
      setMcpTestingById(prev => ({ ...prev, [serverId]: true }));
      try {
          const data = await requestApi<{ result: McpServerTestResult }>(
              `/api/mcp/servers/${encodeURIComponent(serverId)}/test`,
              {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({}),
              },
          );
          setMcpTestResults(prev => ({ ...prev, [serverId]: data.result }));
          await refreshMcpServers();
      } catch (e: any) {
          setMcpTestResults(prev => ({
              ...prev,
              [serverId]: {
                  serverId,
                  serverName: serverId,
                  transport: 'http',
                  reachable: false,
                  latencyMs: 0,
                  errorCode: 'MCP_TEST_FAILED',
                  errorMessage: e.message || 'Connection test failed.',
              },
          }));
      } finally {
          setMcpTestingById(prev => ({ ...prev, [serverId]: false }));
      }
  };

  const moveMcpServerPriority = async (serverId: string, direction: -1 | 1) => {
      const sorted = [...mcpServers].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
      const index = sorted.findIndex(entry => entry.id === serverId);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= sorted.length) return;

      const current = sorted[index];
      const adjacent = sorted[targetIndex];
      try {
          await Promise.all([
              requestApi<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(current.id)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ priority: adjacent.priority }),
              }),
              requestApi<{ server: McpServerView }>(`/api/mcp/servers/${encodeURIComponent(adjacent.id)}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ priority: current.priority }),
              }),
          ]);
          await refreshMcpServers();
      } catch (e: any) {
          setMcpError(e.message || 'Failed to update MCP priority.');
      }
  };

  useEffect(() => {
      if (showSettings && settingsTab === 'AI_PROVIDERS') {
          refreshProviderCatalog();
      }
  }, [showSettings, settingsTab, refreshProviderCatalog]);

  useEffect(() => {
      if (showSettings && settingsTab === 'MCP_SERVERS') {
          refreshMcpServers();
      }
  }, [showSettings, settingsTab, refreshMcpServers]);

  useEffect(() => {
      if (showSettings && settingsTab === 'DIAGNOSTICS') {
          refreshDiagnostics();
      }
  }, [showSettings, settingsTab, refreshDiagnostics]);

  const toggleSelection = (id: string) => {
    const newSet = new Set(selectedItemIds);
    if (newSet.has(id)) newSet.delete(id); else newSet.add(id);
    setSelectedItemIds(newSet);
  };

  const handlePushToADO = async () => {
      if (selectedItemIds.size === 0) return;
      setIsPushingToADO(true);
      setError(null);
      let successCount = 0;
      let failCount = 0;
      try {
          const itemsToPush = items.filter(i => selectedItemIds.has(i.id));
          for (const item of itemsToPush) {
              try {
                  const adoId = await pushToADO(adoConfig, item);
                  setItems(prev => prev.map(pi => pi.id === item.id ? { ...pi, adoId, syncedToADO: true } : pi));
                  setPushedLogs(prev => [{ id: generateId(), itemType: item.type, title: item.title, adoId: adoId, timestamp: Date.now() }, ...prev]);
                  successCount++;
              } catch (e) { console.error(e); failCount++; }
          }
          setSelectedItemIds(new Set());
          if (failCount > 0) setError(`Pushed ${successCount}. Failed ${failCount}.`);
      } catch (e: any) { setError(e.message); } finally { setIsPushingToADO(false); }
  };

  const handleBulkDelete = useCallback(() => {
      setItems(prev => prev.filter(item => !selectedItemIds.has(item.id)));
      if (focusedItemId && selectedItemIds.has(focusedItemId)) setFocusedItemId(null);
      setSelectedItemIds(new Set());
  }, [selectedItemIds, focusedItemId]);

  const handleClearTranscript = useCallback(() => {
      setTranscript([]); transcriptBufferRef.current = ""; burstTranscript.current = "";
      (window as any)._batchIdMap = new Map();
  }, []);

  const performIncrementalAnalysis = async () => {
      if (!transcriptBufferRef.current.trim()) return;
      const segment = transcriptBufferRef.current;
      transcriptBufferRef.current = ""; 
      setIsAnalyzingMeeting(true);
      (window as any)._batchIdMap = new Map();
      const basePolicy = contextPolicyRef.current;
      const manualOverride = manualEnrichPendingRef.current;
      try {
          const projectContext = itemsRef.current.map(i => `ID:${i.id} Type:${i.type} Title:"${i.title}"`).join('\n');
          const activeSources = contextSourcesRef.current.filter(src => src.enabled);
          const effectivePolicy = manualOverride
              ? { ...basePolicy, mode: 'manual-enrich' as const }
              : basePolicy;
          geminiLive.setContextPolicyConfig(effectivePolicy);
          const toolCalls = await geminiLive.analyzeMeetingTranscript(segment, projectContext, activeSources);
          if (toolCalls && toolCalls.length > 0) {
              const provider = providerSelectionRef.current.writer;
              for (const call of toolCalls) {
                 const tools = latestRef.current;
                 const contextTrace = buildContextTrace(call.name, provider, call.metadata);
                 if (call.name === 'createWorkItem') await tools.createWorkItem(call.args as CreateWorkItemArgs, contextTrace);
                 else if (call.name === 'updateWorkItem') await tools.updateWorkItem(call.args as UpdateWorkItemArgs, contextTrace);
              }
          }
      } catch (e) { console.error(e); } finally { setIsAnalyzingMeeting(false); }
      if (manualOverride) {
          setManualEnrichPending(false);
          geminiLive.setContextPolicyConfig(basePolicy);
      }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
          setIsAnalyzingMeeting(true);
          const text = await parseDocument(file);
          setTranscript(prev => {
              const last = prev[prev.length - 1];
              if (last && last.role === 'user') return [...prev.slice(0, -1), { ...last, text: last.text + `\n[IMPORT: ${file.name}]\n` + text }];
              return [...prev, { role: 'user', text: `\n[IMPORT: ${file.name}]\n` + text }];
          });
          transcriptBufferRef.current = text;
          await performIncrementalAnalysis();
          const summary = await geminiLive.summarizeTranscript(text);
          setSavedTranscripts(prev => [{ id: generateId(), timestamp: Date.now(), fullText: text, summary }, ...prev]);
          if (fileInputRef.current) fileInputRef.current.value = '';
      } catch (err: any) { setError(err.message); setIsAnalyzingMeeting(false); }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
      return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1]);
          reader.onerror = reject;
          reader.readAsDataURL(file);
      });
  };

  const handleContextFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const newSources: ContextSource[] = [];
      for (let i = 0; i < files.length; i++) {
          const file = files[i];
          try {
              let content = '', mimeType = file.type || 'text/plain';
              if (file.type.startsWith('image/')) content = await readFileAsBase64(file);
              else content = await parseDocument(file);
              newSources.push({ id: generateId(), name: file.name, type: 'FILE', content, mimeType, enabled: true });
          } catch (err: any) { console.error(err); }
      }
      setContextSources(prev => [...prev, ...newSources]);
      if (contextFileInputRef.current) contextFileInputRef.current.value = '';
  };

  const addTextSource = () => {
      if (!newSourceTitle || !newSourceText) return;
      setContextSources(prev => [...prev, { id: generateId(), name: newSourceTitle, type: 'PASTE', content: newSourceText, mimeType: 'text/plain', enabled: true }]);
      setNewSourceText(''); setNewSourceTitle('');
  };

  const handleWriterProviderChange = (writer: WriterProviderId) => {
      setProviderSelection(prev => sanitizeProviderSelection({ ...prev, writer }));
  };

  const handleTranscriptionProviderChange = (transcription: TranscriptionProviderId) => {
      setProviderSelection(prev => sanitizeProviderSelection({ ...prev, transcription }));
  };

  const handleOpenAiRuntimeConfigChange = (
      key: keyof OpenAIWriterRuntimeConfig,
      value: OpenAIWriterRuntimeConfig[keyof OpenAIWriterRuntimeConfig],
  ) => {
      setWriterProviderRuntimeConfig(prev => sanitizeWriterProviderRuntimeConfig({
          ...prev,
          openai: {
              ...prev.openai,
              [key]: value,
          },
      }));
  };

  const handleAnthropicRuntimeConfigChange = (
      key: keyof AnthropicWriterRuntimeConfig,
      value: AnthropicWriterRuntimeConfig[keyof AnthropicWriterRuntimeConfig],
  ) => {
      setWriterProviderRuntimeConfig(prev => sanitizeWriterProviderRuntimeConfig({
          ...prev,
          anthropic: {
              ...prev.anthropic,
              [key]: value,
          },
      }));
  };

  const handleContextPolicyConfigChange = (
      key: keyof ContextPolicyConfig,
      value: ContextPolicyConfig[keyof ContextPolicyConfig],
  ) => {
      setContextPolicyConfig(prev => sanitizeContextPolicyConfig({
          ...prev,
          [key]: value,
      }));
  };

  const triggerManualEnrich = () => {
      setManualEnrichPending(true);
  };

  const latestRef = useRef({ createWorkItem, updateWorkItem, deleteWorkItem, navigateFocus, handleFilter, handleVisuals, handleSwitchMode, isMeetingRunning, isCommanding, focusedItemId });
  useEffect(() => { latestRef.current = { createWorkItem, updateWorkItem, deleteWorkItem, navigateFocus, handleFilter, handleVisuals, handleSwitchMode, isMeetingRunning, isCommanding, focusedItemId }; }, [createWorkItem, updateWorkItem, deleteWorkItem, navigateFocus, handleFilter, handleVisuals, handleSwitchMode, isMeetingRunning, isCommanding, focusedItemId]);

  useEffect(() => {
    geminiLive.setHandlers(
      async (name, args) => {
        const tools = latestRef.current;
        if (name === 'updateWorkItem' && !args.id && tools.focusedItemId) args.id = tools.focusedItemId;
        if (name === 'createWorkItem') return await tools.createWorkItem(args);
        if (name === 'updateWorkItem') return await tools.updateWorkItem(args);
        if (name === 'deleteWorkItem') return await tools.deleteWorkItem(args);
        if (name === 'navigateFocus') return await tools.navigateFocus(args);
        if (name === 'filterWorkItems') return await tools.handleFilter(args);
        if (name === 'setVisualMode') return await tools.handleVisuals(args);
        if (name === 'switchMode') return await tools.handleSwitchMode(args);
        return "Unknown.";
      },
      (text, isUser) => {
        const { isMeetingRunning, isCommanding } = latestRef.current;
        if (isUser) {
           if (isMeetingRunning) transcriptBufferRef.current += text;
           if (isCommanding) burstTranscript.current += text;
           setTranscript(prev => {
             if (isMeetingRunning && !isCommanding) {
                 const last = prev[prev.length - 1];
                 if (last && last.role === 'user') return [...prev.slice(0, -1), { ...last, text: last.text + text }];
                 return [...prev, { role: 'user', text }]; 
             }
             if (isCommanding) {
                 const newHistory = [...prev];
                 const last = newHistory[newHistory.length - 1];
                 if (last && last.role === 'user') { last.text = burstTranscript.current; return newHistory; }
                 return [...prev, { role: 'user', text }];
             }
             return [...prev, { role: 'user', text }];
           });
        } else setTranscript(prev => [...prev, { role: 'agent', text }]);
      }
    );
  }, []);

  useEffect(() => {
      let interval: any;
      if (isMeetingRunning) interval = setInterval(performIncrementalAnalysis, 10000);
      return () => clearInterval(interval);
  }, [isMeetingRunning]);

  useEffect(() => { if (transcriptScrollRef.current) transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight; }, [transcript]);

  useEffect(() => {
    const manage = async () => {
        try {
            if (isCommanding) {
                if (activeSessionType !== 'COMMANDER') { await geminiLive.disconnect(); await geminiLive.connect('COMMANDER'); geminiLive.setMute(false); setActiveSessionType('COMMANDER'); }
            } else if (isMeetingRunning) {
                if (activeSessionType !== 'SCRIBE') { await geminiLive.disconnect(); await geminiLive.connect('SCRIBE'); geminiLive.setMute(false); setActiveSessionType('SCRIBE'); }
            } else if (activeSessionType) { await geminiLive.disconnect(); setActiveSessionType(null); }
        } catch (e: any) {
            setError(e.message || 'Unable to start live session.');
            setIsCommanding(false);
            setIsMeetingRunning(false);
            setActiveSessionType(null);
        }
    };
    manage();
  }, [isCommanding, isMeetingRunning]); 

  useEffect(() => {
      if (prevMeetingState.current && !isMeetingRunning) {
          performIncrementalAnalysis();
          const fullLog = transcript.filter(t => t.role === 'user').map(t => t.text).join('\n');
          if (fullLog) geminiLive.summarizeTranscript(fullLog).then(s => setSavedTranscripts(prev => [{ id: generateId(), timestamp: Date.now(), fullText: fullLog, summary: s }, ...prev]));
      }
      prevMeetingState.current = isMeetingRunning;
  }, [isMeetingRunning]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !e.repeat && !['INPUT', 'TEXTAREA'].includes((e.target as any).tagName)) { e.preventDefault(); burstTranscript.current = ""; setIsCommanding(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes((e.target as any).tagName)) setIsCommanding(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const filteredItems = items.filter(itemMatchesFilter);
  const focusedRelationships: Relationship[] = [];
  if (focusedItemId) {
      const current = items.find(i => i.id === focusedItemId);
      if (current) {
          if (current.parentId) { const p = items.find(i => i.id === current.parentId); if (p) focusedRelationships.push({ id: p.id, title: p.title, type: 'Parent' }); }
          items.filter(i => i.parentId === current.id).forEach(c => focusedRelationships.push({ id: c.id, title: c.title, type: 'Child' }));
          if (current.relatedIds) current.relatedIds.forEach(rid => { const r = items.find(i => i.id === rid); if (r) focusedRelationships.push({ id: r.id, title: r.title, type: 'Related' }); });
      }
  }

  return (
    <div className={`relative w-full h-screen overflow-hidden font-sans text-white bg-[#0a0a0c] transition-all duration-300 ${isCommanding ? 'shadow-[inset_0_0_100px_rgba(139,92,246,0.3)]' : ''}`}>
      <div className="absolute inset-0 pointer-events-none">
        <div className={`absolute top-[-20%] left-[-10%] w-[60vw] h-[60vw] bg-purple-900/10 rounded-full transition-all duration-1000 ${blurEnabled ? 'blur-[150px]' : 'blur-none opacity-20'}`} />
        <div className={`absolute bottom-[-20%] right-[-10%] w-[60vw] h-[60vw] bg-blue-900/10 rounded-full transition-all duration-1000 ${blurEnabled ? 'blur-[150px]' : 'blur-none opacity-20'}`} />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:40px_40px]" />
      </div>
      <div className="absolute top-0 left-0 w-full p-6 z-40 flex justify-between items-start pointer-events-none">
        <div className="pointer-events-auto flex gap-6">
          <div>
              <h1 className="text-3xl font-extralight tracking-tighter opacity-90 flex items-center gap-3 font-serif">
                 <span className="text-rose-300 font-medium">TRANSKRIBOIDA</span>
              </h1>
              <div className="text-xs font-mono text-slate-500 mt-2 flex items-center gap-3">
                 <div className={`w-2 h-2 rounded-full ${activeSessionType ? 'bg-emerald-500 shadow-[0_0_10px_#10b981]' : 'bg-red-500'}`} />
                 {activeSessionType ? 'SYSTEM ONLINE' : 'SYSTEM IDLE'}
                 <span className="opacity-30">|</span>
                 <span>{mode} MODE</span>
              </div>
          </div>
          <button onClick={() => setIsMeetingRunning(!isMeetingRunning)} className={`flex items-center gap-3 px-5 py-2 rounded-full border transition-all duration-300 ${isMeetingRunning ? 'bg-red-500/20 border-red-500 text-red-100 animate-pulse' : 'bg-white/5 border-white/10 text-gray-300'}`}>
             <div className={`w-3 h-3 rounded-full ${isMeetingRunning ? 'bg-red-500' : 'bg-gray-400'}`} />
             <span className="text-xs font-bold tracking-widest">{isMeetingRunning ? 'MEETING LIVE' : 'START MEETING'}</span>
          </button>
          <div className="flex gap-2">
            <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-2 px-4 py-2 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-all text-xs font-mono uppercase tracking-widest text-blue-400">Import</button>
            <input type="file" ref={fileInputRef} className="hidden" accept=".docx,.txt,.vtt" onChange={handleFileUpload} />
            <button onClick={() => setShowTranscripts(!showTranscripts)} className="flex items-center gap-2 px-4 py-2 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition-all text-xs font-mono uppercase tracking-widest">Logs</button>
          </div>
        </div>
        <div className="pointer-events-auto flex items-center gap-4">
            {mode === AppMode.GROOMING && (
                <button onClick={() => setShowTools(!showTools)} className={`p-2 rounded-full transition-all border ${showTools ? 'bg-blue-500/20 border-blue-400 text-blue-200' : 'bg-white/5 border-transparent text-gray-400'}`}><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg></button>
            )}
            <button onClick={() => setShowSettings(!showSettings)} className="p-2 rounded-full hover:bg-white/10 transition-all text-gray-400 hover:text-white"><svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></button>
            <div className="flex gap-2 bg-white/5 p-1 rounded-lg backdrop-blur-md border border-white/10 isolate">
                <button onClick={() => setMode(AppMode.MEETING)} className={`px-4 py-2 rounded text-xs font-bold transition-colors ${mode === AppMode.MEETING ? 'bg-white/20 text-white' : 'text-gray-500'}`}>MEETING</button>
                <button onClick={() => setMode(AppMode.GROOMING)} className={`px-4 py-2 rounded text-xs font-bold transition-colors ${mode === AppMode.GROOMING ? 'bg-white/20 text-white' : 'text-gray-500'}`}>GROOMING</button>
            </div>
        </div>
      </div>
      <div className={`absolute left-0 top-24 bottom-24 w-80 z-30 transition-transform duration-500 bg-[#0a0a0c]/95 border-r border-white/10 p-6 flex flex-col gap-8 ${showTranscripts ? 'translate-x-0' : '-translate-x-full'}`}>
         <div className="flex-1 min-h-0 flex flex-col"><h3 className="text-xs font-mono text-blue-400 uppercase mb-4 shrink-0">Meeting Logs</h3><div className="flex-1 relative overflow-y-auto pr-2">{savedTranscripts.map((t, i) => (
                    <div key={t.id} className="p-4 rounded-xl border bg-[#1a1a1e] border-white/10 mb-4 cursor-pointer hover:bg-[#202025]">
                        <div className="flex justify-between items-start mb-2"><span className="text-[10px] font-mono text-blue-400">{new Date(t.timestamp).toLocaleTimeString()}</span></div>
                        <p className="text-xs text-gray-300 line-clamp-3">{t.summary}</p>
                    </div>
                ))}</div></div>
      </div>
      {showSettings && (
          <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm p-8">
              <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-6xl h-[88vh] flex flex-col">
                  <div className="p-6 border-b border-white/10 flex justify-between items-center">
                      <h2 className="text-xl font-light">Project Configuration</h2>
                      <button onClick={() => setShowSettings(false)}>✕</button>
                  </div>
                  <div className="flex border-b border-white/5 px-4 overflow-x-auto">
                      <button onClick={() => setSettingsTab('AI_PROVIDERS')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'AI_PROVIDERS' ? 'border-b-2 border-cyan-400 text-white' : 'text-gray-500'}`}>AI Providers</button>
                      <button onClick={() => setSettingsTab('MCP_SERVERS')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'MCP_SERVERS' ? 'border-b-2 border-emerald-400 text-white' : 'text-gray-500'}`}>MCP Servers</button>
                      <button onClick={() => setSettingsTab('CONTEXT_POLICY')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'CONTEXT_POLICY' ? 'border-b-2 border-orange-400 text-white' : 'text-gray-500'}`}>Context Policy</button>
                      <button onClick={() => setSettingsTab('DIAGNOSTICS')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'DIAGNOSTICS' ? 'border-b-2 border-lime-400 text-white' : 'text-gray-500'}`}>Diagnostics</button>
                      <button onClick={() => setSettingsTab('ADO')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'ADO' ? 'border-b-2 border-blue-500 text-white' : 'text-gray-500'}`}>Integrations</button>
                      <button onClick={() => setSettingsTab('KNOWLEDGE')} className={`px-4 py-3 text-xs font-bold whitespace-nowrap ${settingsTab === 'KNOWLEDGE' ? 'border-b-2 border-purple-500 text-white' : 'text-gray-500'}`}>Knowledge Base</button>
                  </div>
                  <div className="p-6 overflow-y-auto flex-1">
                      {settingsTab === 'AI_PROVIDERS' && (
                          <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                  <h3 className="text-sm font-mono uppercase tracking-wider text-cyan-300">Provider Routing</h3>
                                  <button
                                      onClick={refreshProviderCatalog}
                                      disabled={isProviderCatalogLoading}
                                      className="px-3 py-1 rounded border border-white/15 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"
                                  >
                                      {isProviderCatalogLoading ? 'Refreshing...' : 'Refresh Status'}
                                  </button>
                              </div>
                              {providerCatalogError && (
                                  <div className="text-xs text-rose-300 bg-rose-900/20 border border-rose-500/30 rounded p-3">{providerCatalogError}</div>
                              )}
                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                  <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                      <div className="text-xs font-mono uppercase tracking-wider text-slate-400">Writer Provider</div>
                                      <select
                                          className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm"
                                          value={providerSelection.writer}
                                          onChange={e => handleWriterProviderChange(e.target.value as WriterProviderId)}
                                      >
                                          <option value="gemini">Gemini</option>
                                          <option value="openai">OpenAI</option>
                                          <option value="anthropic">Anthropic</option>
                                      </select>
                                      <div className="text-[11px] text-slate-500">
                                          Controls summarization, extraction, and refinement output.
                                      </div>
                                  </div>
                                  <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                      <div className="text-xs font-mono uppercase tracking-wider text-slate-400">Transcription Provider</div>
                                      <select
                                          className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm"
                                          value={providerSelection.transcription}
                                          onChange={e => handleTranscriptionProviderChange(e.target.value as TranscriptionProviderId)}
                                      >
                                          <option value="gemini">Gemini</option>
                                      </select>
                                      <div className="text-[11px] text-slate-500">
                                          Real-time transcription currently uses Gemini in this runtime.
                                      </div>
                                  </div>
                              </div>
                              <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                  <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">Backend Provider Availability</div>
                                  {!providerCatalog && !isProviderCatalogLoading && (
                                      <div className="text-xs text-slate-500">No status loaded yet.</div>
                                  )}
                                  {providerCatalog && (
                                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                          {providerCatalog.writers.map(writer => (
                                              <div key={writer.id} className="border border-white/10 rounded-lg p-3 bg-black/20">
                                                  <div className="flex justify-between items-center">
                                                      <span className="text-sm font-semibold uppercase">{writer.id}</span>
                                                      <span className={`text-[10px] px-2 py-1 rounded ${writer.available ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-600/40 text-slate-300'}`}>
                                                          {writer.available ? 'Available' : 'Unavailable'}
                                                      </span>
                                                  </div>
                                                  <div className="text-[11px] text-slate-400 mt-2 space-y-1">
                                                      <div>Enabled: {writer.enabled ? 'yes' : 'no'}</div>
                                                      <div>Configured: {writer.configured ? 'yes' : 'no'}</div>
                                                      <div>Tool calls: {writer.capabilities.toolCallSupport ? 'yes' : 'no'}</div>
                                                  </div>
                                              </div>
                                          ))}
                                      </div>
                                  )}
                              </div>
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                  <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                      <div className="text-xs font-mono uppercase tracking-wider text-slate-400">OpenAI Writer Runtime</div>
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Summary model" value={writerProviderRuntimeConfig.openai.summaryModel} onChange={e => handleOpenAiRuntimeConfigChange('summaryModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Analysis model" value={writerProviderRuntimeConfig.openai.analysisModel} onChange={e => handleOpenAiRuntimeConfigChange('analysisModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Refine model" value={writerProviderRuntimeConfig.openai.refineModel} onChange={e => handleOpenAiRuntimeConfigChange('refineModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Fallback model" value={writerProviderRuntimeConfig.openai.fallbackModel} onChange={e => handleOpenAiRuntimeConfigChange('fallbackModel', e.target.value)} />
                                      <div className="grid grid-cols-2 gap-3">
                                          <input type="number" min={0} max={2} step={0.1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Temperature" value={writerProviderRuntimeConfig.openai.temperature} onChange={e => handleOpenAiRuntimeConfigChange('temperature', Number(e.target.value))} />
                                          <input type="number" min={64} max={4096} step={1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Max output tokens" value={writerProviderRuntimeConfig.openai.maxOutputTokens} onChange={e => handleOpenAiRuntimeConfigChange('maxOutputTokens', Number(e.target.value))} />
                                      </div>
                                      <div className="grid grid-cols-2 gap-3">
                                          <input type="number" min={5000} max={60000} step={1000} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Timeout ms" value={writerProviderRuntimeConfig.openai.requestTimeoutMs} onChange={e => handleOpenAiRuntimeConfigChange('requestTimeoutMs', Number(e.target.value))} />
                                          <input type="number" min={0} max={4} step={1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Retries" value={writerProviderRuntimeConfig.openai.maxRetries} onChange={e => handleOpenAiRuntimeConfigChange('maxRetries', Number(e.target.value))} />
                                      </div>
                                  </div>
                                  <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                      <div className="text-xs font-mono uppercase tracking-wider text-slate-400">Anthropic Writer Runtime</div>
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Summary model" value={writerProviderRuntimeConfig.anthropic.summaryModel} onChange={e => handleAnthropicRuntimeConfigChange('summaryModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Analysis model" value={writerProviderRuntimeConfig.anthropic.analysisModel} onChange={e => handleAnthropicRuntimeConfigChange('analysisModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Refine model" value={writerProviderRuntimeConfig.anthropic.refineModel} onChange={e => handleAnthropicRuntimeConfigChange('refineModel', e.target.value)} />
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Fallback model" value={writerProviderRuntimeConfig.anthropic.fallbackModel} onChange={e => handleAnthropicRuntimeConfigChange('fallbackModel', e.target.value)} />
                                      <div className="grid grid-cols-2 gap-3">
                                          <input type="number" min={0} max={2} step={0.1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Temperature" value={writerProviderRuntimeConfig.anthropic.temperature} onChange={e => handleAnthropicRuntimeConfigChange('temperature', Number(e.target.value))} />
                                          <input type="number" min={64} max={4096} step={1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Max output tokens" value={writerProviderRuntimeConfig.anthropic.maxOutputTokens} onChange={e => handleAnthropicRuntimeConfigChange('maxOutputTokens', Number(e.target.value))} />
                                      </div>
                                      <div className="grid grid-cols-2 gap-3">
                                          <input type="number" min={5000} max={60000} step={1000} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Timeout ms" value={writerProviderRuntimeConfig.anthropic.requestTimeoutMs} onChange={e => handleAnthropicRuntimeConfigChange('requestTimeoutMs', Number(e.target.value))} />
                                          <input type="number" min={0} max={4} step={1} className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Retries" value={writerProviderRuntimeConfig.anthropic.maxRetries} onChange={e => handleAnthropicRuntimeConfigChange('maxRetries', Number(e.target.value))} />
                                      </div>
                                  </div>
                              </div>
                          </div>
                      )}
                      {settingsTab === 'MCP_SERVERS' && (
                          <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                  <h3 className="text-sm font-mono uppercase tracking-wider text-emerald-300">MCP Registry</h3>
                                  <div className="flex items-center gap-2">
                                      <button onClick={resetMcpEditor} className="px-3 py-1 rounded border border-white/15 text-xs text-slate-300 hover:bg-white/5">New Server</button>
                                      <button onClick={refreshMcpServers} disabled={isMcpLoading} className="px-3 py-1 rounded border border-white/15 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50">
                                          {isMcpLoading ? 'Refreshing...' : 'Refresh'}
                                      </button>
                                  </div>
                              </div>
                              {mcpError && <div className="text-xs text-rose-300 bg-rose-900/20 border border-rose-500/30 rounded p-3">{mcpError}</div>}
                              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                  <div className="space-y-3 max-h-[58vh] overflow-y-auto pr-1">
                                      {mcpServers.length === 0 && (
                                          <div className="text-xs text-slate-500 border border-dashed border-white/10 rounded-xl p-6 text-center">
                                              No MCP servers configured.
                                          </div>
                                      )}
                                      {mcpServers.map((server, index) => (
                                          <div key={server.id} className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                              <div className="flex justify-between items-start gap-3">
                                                  <div>
                                                      <div className="text-sm font-semibold">{server.name}</div>
                                                      <div className="text-[11px] text-slate-400 font-mono">{server.id} • {server.transport}</div>
                                                      <div className="text-xs text-slate-500 mt-1 break-all">{server.endpointOrCommand}</div>
                                                  </div>
                                                  <span className={`text-[10px] px-2 py-1 rounded ${server.health.state === 'closed' ? 'bg-emerald-500/20 text-emerald-300' : server.health.state === 'half-open' ? 'bg-amber-500/20 text-amber-300' : 'bg-rose-500/20 text-rose-300'}`}>
                                                      {server.health.state}
                                                  </span>
                                              </div>
                                              <div className="text-[11px] text-slate-400 grid grid-cols-2 gap-2">
                                                  <div>Priority: {server.priority}</div>
                                                  <div>Enabled: {server.enabled ? 'yes' : 'no'}</div>
                                                  <div>Req timeout: {server.timeouts.requestMs} ms</div>
                                                  <div>Failures: {server.health.consecutiveFailures}</div>
                                              </div>
                                              <div className="flex flex-wrap gap-2">
                                                  <button onClick={() => moveMcpServerPriority(server.id, -1)} disabled={index === 0} className="px-2 py-1 text-[11px] rounded border border-white/10 disabled:opacity-40">↑</button>
                                                  <button onClick={() => moveMcpServerPriority(server.id, 1)} disabled={index === mcpServers.length - 1} className="px-2 py-1 text-[11px] rounded border border-white/10 disabled:opacity-40">↓</button>
                                                  <button onClick={() => toggleMcpServerEnabled(server.id, !server.enabled)} className={`px-2 py-1 text-[11px] rounded border ${server.enabled ? 'border-emerald-400/40 text-emerald-300' : 'border-slate-500/40 text-slate-300'}`}>{server.enabled ? 'Disable' : 'Enable'}</button>
                                                  <button onClick={() => loadMcpServerIntoEditor(server)} className="px-2 py-1 text-[11px] rounded border border-blue-400/40 text-blue-300">Edit</button>
                                                  <button onClick={() => deleteMcpServer(server.id)} className="px-2 py-1 text-[11px] rounded border border-rose-400/40 text-rose-300">Delete</button>
                                                  <button onClick={() => testMcpServerConnection(server.id)} disabled={Boolean(mcpTestingById[server.id])} className="px-2 py-1 text-[11px] rounded border border-cyan-400/40 text-cyan-300 disabled:opacity-50">
                                                      {mcpTestingById[server.id] ? 'Testing...' : 'Test'}
                                                  </button>
                                              </div>
                                              {mcpTestResults[server.id] && (
                                                  <div className={`text-[11px] rounded border p-2 ${mcpTestResults[server.id].reachable ? 'bg-emerald-900/20 border-emerald-500/30 text-emerald-200' : 'bg-rose-900/20 border-rose-500/30 text-rose-200'}`}>
                                                      {mcpTestResults[server.id].reachable
                                                          ? `Reachable in ${mcpTestResults[server.id].latencyMs} ms`
                                                          : `${mcpTestResults[server.id].errorCode || 'MCP_TEST_FAILED'}: ${mcpTestResults[server.id].errorMessage || 'Request failed'}`}
                                                  </div>
                                              )}
                                          </div>
                                      ))}
                                  </div>
                                  <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-3">
                                      <div className="text-xs font-mono uppercase tracking-wider text-slate-400">{editingMcpServerId ? `Edit Server: ${editingMcpServerId}` : 'Create MCP Server'}</div>
                                      <div className="grid grid-cols-2 gap-2">
                                          <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Server ID" value={mcpEditor.id} disabled={Boolean(editingMcpServerId)} onChange={e => setMcpEditor(prev => ({ ...prev, id: e.target.value }))} />
                                          <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Name" value={mcpEditor.name} onChange={e => setMcpEditor(prev => ({ ...prev, name: e.target.value }))} />
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                          <select className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.transport} onChange={e => setMcpEditor(prev => ({ ...prev, transport: e.target.value as McpTransport }))}>
                                              <option value="http">http</option>
                                              <option value="command">command</option>
                                          </select>
                                          <input type="number" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.priority} onChange={e => setMcpEditor(prev => ({ ...prev, priority: Number(e.target.value) }))} placeholder="Priority" />
                                      </div>
                                      <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Endpoint URL or command" value={mcpEditor.endpointOrCommand} onChange={e => setMcpEditor(prev => ({ ...prev, endpointOrCommand: e.target.value }))} />
                                      <div className="grid grid-cols-2 gap-2">
                                          <input type="number" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.requestMs} onChange={e => setMcpEditor(prev => ({ ...prev, requestMs: Number(e.target.value) }))} placeholder="Request ms" />
                                          <input type="number" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.cooldownMs} onChange={e => setMcpEditor(prev => ({ ...prev, cooldownMs: Number(e.target.value) }))} placeholder="Cooldown ms" />
                                      </div>
                                      <div className="grid grid-cols-2 gap-2">
                                          <input type="number" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.failureThreshold} onChange={e => setMcpEditor(prev => ({ ...prev, failureThreshold: Number(e.target.value) }))} placeholder="Failure threshold" />
                                          <input type="number" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.maxPayload} onChange={e => setMcpEditor(prev => ({ ...prev, maxPayload: Number(e.target.value) }))} placeholder="Max payload chars" />
                                      </div>
                                      <label className="flex items-center gap-2 text-xs text-slate-300">
                                          <input type="checkbox" checked={mcpEditor.enabled} onChange={e => setMcpEditor(prev => ({ ...prev, enabled: e.target.checked }))} />
                                          Enabled
                                      </label>
                                      <textarea className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm min-h-[72px]" placeholder="Allowed resources (one per line)" value={mcpEditor.allowedResourcesText} onChange={e => setMcpEditor(prev => ({ ...prev, allowedResourcesText: e.target.value }))} />
                                      <div className="pt-2 border-t border-white/10 space-y-2">
                                          <select className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" value={mcpEditor.authType} onChange={e => setMcpEditor(prev => ({ ...prev, authType: e.target.value as McpAuthType }))}>
                                              <option value="none">Auth: none</option>
                                              <option value="bearer">Auth: bearer</option>
                                              <option value="basic">Auth: basic</option>
                                              <option value="header">Auth: custom header</option>
                                          </select>
                                          {mcpEditor.authType === 'bearer' && (
                                              <div className="grid grid-cols-2 gap-2">
                                                  <input type="password" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Bearer token" value={mcpEditor.bearerToken} onChange={e => setMcpEditor(prev => ({ ...prev, bearerToken: e.target.value }))} />
                                                  <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Env var (optional)" value={mcpEditor.bearerEnvVar} onChange={e => setMcpEditor(prev => ({ ...prev, bearerEnvVar: e.target.value }))} />
                                              </div>
                                          )}
                                          {mcpEditor.authType === 'basic' && (
                                              <div className="grid grid-cols-2 gap-2">
                                                  <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Username" value={mcpEditor.basicUsername} onChange={e => setMcpEditor(prev => ({ ...prev, basicUsername: e.target.value }))} />
                                                  <input type="password" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Password" value={mcpEditor.basicPassword} onChange={e => setMcpEditor(prev => ({ ...prev, basicPassword: e.target.value }))} />
                                                  <input type="text" className="col-span-2 bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Password env var (optional)" value={mcpEditor.basicPasswordEnvVar} onChange={e => setMcpEditor(prev => ({ ...prev, basicPasswordEnvVar: e.target.value }))} />
                                              </div>
                                          )}
                                          {mcpEditor.authType === 'header' && (
                                              <div className="grid grid-cols-2 gap-2">
                                                  <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Header name" value={mcpEditor.headerName} onChange={e => setMcpEditor(prev => ({ ...prev, headerName: e.target.value }))} />
                                                  <input type="password" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Header value" value={mcpEditor.headerValue} onChange={e => setMcpEditor(prev => ({ ...prev, headerValue: e.target.value }))} />
                                                  <input type="text" className="col-span-2 bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Header value env var (optional)" value={mcpEditor.headerValueEnvVar} onChange={e => setMcpEditor(prev => ({ ...prev, headerValueEnvVar: e.target.value }))} />
                                              </div>
                                          )}
                                          {mcpEditor.authType !== 'none' && (
                                              <label className="flex items-center gap-2 text-xs text-slate-300">
                                                  <input type="checkbox" checked={mcpEditor.preserveExistingSecret} onChange={e => setMcpEditor(prev => ({ ...prev, preserveExistingSecret: e.target.checked }))} />
                                                  Preserve existing secret when secret input is blank
                                              </label>
                                          )}
                                      </div>
                                      <div className="flex gap-2 pt-2">
                                          <button onClick={saveMcpServer} disabled={isSavingMcpServer} className="px-4 py-2 rounded bg-emerald-600/80 hover:bg-emerald-500 text-xs font-bold disabled:opacity-50">
                                              {isSavingMcpServer ? 'Saving...' : editingMcpServerId ? 'Save Changes' : 'Create Server'}
                                          </button>
                                          <button onClick={resetMcpEditor} className="px-4 py-2 rounded border border-white/15 text-xs">Reset</button>
                                      </div>
                                  </div>
                              </div>
                          </div>
                      )}
                      {settingsTab === 'CONTEXT_POLICY' && (
                          <div className="space-y-6 max-w-3xl">
                              <div className="flex items-center justify-between">
                                  <h3 className="text-sm font-mono uppercase tracking-wider text-orange-300">Auto-Smart Retrieval Policy</h3>
                                  <div className="flex items-center gap-2">
                                      <button onClick={() => setContextPolicyConfig({ ...DEFAULT_CONTEXT_POLICY_CONFIG })} className="px-3 py-1 rounded border border-white/15 text-xs text-slate-300 hover:bg-white/5">Reset Defaults</button>
                                      <button onClick={triggerManualEnrich} className="px-3 py-1 rounded bg-orange-600/80 hover:bg-orange-500 text-xs font-bold">Manual Enrich Next Analysis</button>
                                  </div>
                              </div>
                              {manualEnrichPending && (
                                  <div className="text-xs text-orange-200 bg-orange-900/20 border border-orange-500/40 rounded p-3">
                                      Manual enrich is armed and will run on the next analysis pass.
                                  </div>
                              )}
                              <div className="bg-black/30 border border-white/10 rounded-xl p-4 space-y-4">
                                  <div>
                                      <label className="block text-xs font-mono uppercase tracking-wider text-slate-400 mb-2">Default Mode</label>
                                      <select
                                          className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm"
                                          value={contextPolicyConfig.mode}
                                          onChange={e => handleContextPolicyConfigChange('mode', e.target.value as ContextPolicyConfig['mode'])}
                                      >
                                          <option value="auto-smart">Auto-Smart (default)</option>
                                          <option value="manual-enrich">Manual Enrich (always)</option>
                                      </select>
                                  </div>
                                  <div>
                                      <label className="block text-xs text-slate-400 mb-1">Global Token Budget</label>
                                      <div className="flex items-center gap-3">
                                          <input type="range" min={200} max={6000} step={50} className="flex-1" value={contextPolicyConfig.globalTokenBudget} onChange={e => handleContextPolicyConfigChange('globalTokenBudget', Number(e.target.value))} />
                                          <input type="number" min={200} max={6000} className="w-28 bg-black/50 border border-white/10 rounded px-2 py-1 text-sm" value={contextPolicyConfig.globalTokenBudget} onChange={e => handleContextPolicyConfigChange('globalTokenBudget', Number(e.target.value))} />
                                      </div>
                                  </div>
                                  <div>
                                      <label className="block text-xs text-slate-400 mb-1">Per-Server Token Budget</label>
                                      <div className="flex items-center gap-3">
                                          <input type="range" min={120} max={3000} step={20} className="flex-1" value={contextPolicyConfig.perServerTokenBudget} onChange={e => handleContextPolicyConfigChange('perServerTokenBudget', Number(e.target.value))} />
                                          <input type="number" min={120} max={3000} className="w-28 bg-black/50 border border-white/10 rounded px-2 py-1 text-sm" value={contextPolicyConfig.perServerTokenBudget} onChange={e => handleContextPolicyConfigChange('perServerTokenBudget', Number(e.target.value))} />
                                      </div>
                                  </div>
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <div>
                                          <label className="block text-xs text-slate-400 mb-1">Max Snippets</label>
                                          <input type="number" min={1} max={20} className="w-full bg-black/50 border border-white/10 rounded px-2 py-2 text-sm" value={contextPolicyConfig.maxSnippetCount} onChange={e => handleContextPolicyConfigChange('maxSnippetCount', Number(e.target.value))} />
                                      </div>
                                      <div>
                                          <label className="block text-xs text-slate-400 mb-1">Max Snippet Chars</label>
                                          <input type="number" min={80} max={8000} className="w-full bg-black/50 border border-white/10 rounded px-2 py-2 text-sm" value={contextPolicyConfig.maxSnippetChars} onChange={e => handleContextPolicyConfigChange('maxSnippetChars', Number(e.target.value))} />
                                      </div>
                                      <div>
                                          <label className="block text-xs text-slate-400 mb-1">Cache TTL (ms)</label>
                                          <input type="number" min={10000} max={600000} step={1000} className="w-full bg-black/50 border border-white/10 rounded px-2 py-2 text-sm" value={contextPolicyConfig.cacheTtlMs} onChange={e => handleContextPolicyConfigChange('cacheTtlMs', Number(e.target.value))} />
                                      </div>
                                  </div>
                              </div>
                          </div>
                      )}
                      {settingsTab === 'DIAGNOSTICS' && (
                          <div className="space-y-6">
                              <div className="flex items-center justify-between">
                                  <h3 className="text-sm font-mono uppercase tracking-wider text-lime-300">Token + Request Diagnostics</h3>
                                  <button
                                      onClick={refreshDiagnostics}
                                      disabled={isDiagnosticsLoading}
                                      className="px-3 py-1 rounded border border-white/15 text-xs text-slate-300 hover:bg-white/5 disabled:opacity-50"
                                  >
                                      {isDiagnosticsLoading ? 'Refreshing...' : 'Refresh Diagnostics'}
                                  </button>
                              </div>
                              {diagnosticsError && (
                                  <div className="text-xs text-rose-300 bg-rose-900/20 border border-rose-500/30 rounded p-3">{diagnosticsError}</div>
                              )}
                              {!diagnosticsSnapshot && !isDiagnosticsLoading && !diagnosticsError && (
                                  <div className="text-xs text-slate-500">No telemetry data yet. Run summarize/analyze/refine requests to populate diagnostics.</div>
                              )}
                              {diagnosticsSnapshot && (
                                  <div className="space-y-4">
                                      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Requests</div>
                                              <div className="text-2xl font-semibold text-white">{diagnosticsSnapshot.totals.requests}</div>
                                          </div>
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Success</div>
                                              <div className="text-2xl font-semibold text-emerald-300">{diagnosticsSnapshot.totals.successes}</div>
                                          </div>
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Failures</div>
                                              <div className="text-2xl font-semibold text-rose-300">{diagnosticsSnapshot.totals.failures}</div>
                                          </div>
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Total Tokens</div>
                                              <div className="text-2xl font-semibold text-cyan-200">{diagnosticsSnapshot.totals.totalTokens}</div>
                                          </div>
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-[10px] font-mono uppercase tracking-wider text-slate-500">Avg Duration</div>
                                              <div className="text-2xl font-semibold text-amber-200">{diagnosticsSnapshot.totals.avgDurationMs}ms</div>
                                          </div>
                                      </div>
                                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">By Provider</div>
                                              <div className="space-y-2">
                                                  {Object.entries(diagnosticsSnapshot.byProvider).length === 0 && (
                                                      <div className="text-xs text-slate-500">No provider activity yet.</div>
                                                  )}
                                                  {Object.entries(diagnosticsSnapshot.byProvider).map(([provider, bucket]) => (
                                                      <div key={provider} className="flex items-center justify-between border border-white/10 rounded-lg px-3 py-2 bg-black/20">
                                                          <div>
                                                              <div className="text-sm uppercase">{provider}</div>
                                                              <div className="text-[11px] text-slate-500">Req: {bucket.requests} • Fail: {bucket.failures}</div>
                                                          </div>
                                                          <div className="text-right">
                                                              <div className="text-sm text-cyan-200">{bucket.totalTokens} tokens</div>
                                                              <div className="text-[11px] text-slate-500">{bucket.avgDurationMs}ms avg</div>
                                                          </div>
                                                      </div>
                                                  ))}
                                              </div>
                                          </div>
                                          <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                              <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">By MCP Server</div>
                                              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                                                  {Object.entries(diagnosticsSnapshot.byServer).length === 0 && (
                                                      <div className="text-xs text-slate-500">No MCP retrieval telemetry yet.</div>
                                                  )}
                                                  {Object.entries(diagnosticsSnapshot.byServer).map(([serverKey, bucket]) => (
                                                      <div key={serverKey} className="border border-white/10 rounded-lg px-3 py-2 bg-black/20">
                                                          <div className="text-sm">{serverKey}</div>
                                                          <div className="text-[11px] text-slate-500 mt-1">
                                                              Requests: {bucket.requests} • Reachable: {bucket.reachableRequests} • Failed: {bucket.failedRequests} • Tokens: {bucket.retrievalTokens}
                                                          </div>
                                                      </div>
                                                  ))}
                                              </div>
                                          </div>
                                      </div>
                                      <div className="bg-black/30 border border-white/10 rounded-xl p-4">
                                          <div className="text-xs font-mono uppercase tracking-wider text-slate-400 mb-3">Recent Requests</div>
                                          <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                                              {diagnosticsSnapshot.recent.length === 0 && (
                                                  <div className="text-xs text-slate-500">No requests recorded yet.</div>
                                              )}
                                              {diagnosticsSnapshot.recent.map(event => (
                                                  <div key={event.id} className="border border-white/10 rounded-lg px-3 py-2 bg-black/20">
                                                      <div className="flex items-center justify-between">
                                                          <div className="text-sm uppercase">{event.provider} • {event.operation}</div>
                                                          <div className={`text-[10px] px-2 py-1 rounded ${event.success ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'}`}>
                                                              {event.success ? 'SUCCESS' : 'FAILED'}
                                                          </div>
                                                      </div>
                                                      <div className="text-[11px] text-slate-500 mt-1">
                                                          {new Date(event.timestamp).toLocaleString()} • {event.durationMs}ms • in:{event.inputTokens} out:{event.outputTokens} retrieval:{event.retrievalTokens} total:{event.totalTokens}
                                                          {event.errorCode ? ` • ${event.errorCode}` : ''}
                                                      </div>
                                                  </div>
                                              ))}
                                          </div>
                                      </div>
                                  </div>
                              )}
                          </div>
                      )}
                      {settingsTab === 'ADO' && (
                          <div className="space-y-4 max-w-md">
                              <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Org" value={adoConfig.organization} onChange={e => setAdoConfig({ ...adoConfig, organization: e.target.value })} />
                              <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Project" value={adoConfig.project} onChange={e => setAdoConfig({ ...adoConfig, project: e.target.value })} />
                              <input type="password" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="PAT" value={adoConfig.pat} onChange={e => setAdoConfig({ ...adoConfig, pat: e.target.value })} />
                          </div>
                      )}
                      {settingsTab === 'KNOWLEDGE' && (
                          <div className="space-y-6">
                              <div onClick={() => contextFileInputRef.current?.click()} className="border-2 border-dashed border-white/10 rounded-xl h-[120px] flex items-center justify-center cursor-pointer text-gray-500">Upload Context Files (Multiple)</div>
                              <input type="file" ref={contextFileInputRef} className="hidden" onChange={handleContextFileUpload} multiple />
                              <div className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2">
                                  <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Source title" value={newSourceTitle} onChange={e => setNewSourceTitle(e.target.value)} />
                                  <input type="text" className="bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Pasted context text" value={newSourceText} onChange={e => setNewSourceText(e.target.value)} />
                                  <button onClick={addTextSource} className="px-3 py-2 rounded bg-purple-600/80 text-xs font-bold">Add Text</button>
                              </div>
                              <div className="space-y-2">
                                  {contextSources.map(src => (
                                      <div key={src.id} className="flex items-center justify-between bg-white/5 p-3 rounded-lg border border-white/10">
                                          <label className="flex items-center gap-2">
                                              <input type="checkbox" checked={src.enabled} onChange={e => setContextSources(prev => prev.map(entry => entry.id === src.id ? { ...entry, enabled: e.target.checked } : entry))} />
                                              <span className="text-sm">{src.name}</span>
                                          </label>
                                          <button onClick={() => setContextSources(prev => prev.filter(s => s.id !== src.id))} className="text-red-500 text-xs">Remove</button>
                                      </div>
                                  ))}
                              </div>
                          </div>
                      )}
                  </div>
              </div>
          </div>
      )}
      {mode === AppMode.MEETING && (
        <div className={`absolute inset-0 flex pt-24 pb-24 px-12 gap-8 ${showTranscripts ? 'pl-80' : ''}`}>
            <div className="w-1/3 h-full flex flex-col">
                <div className="flex justify-between items-center mb-4"><h3 className="text-xs font-mono text-blue-400">Live Transcript</h3><button onClick={handleClearTranscript} className="text-[10px] text-red-400">Clear</button></div>
                <div className="flex-1 relative bg-[#0f0f11] border border-white/10 rounded-2xl p-8 overflow-hidden">
                    <div ref={transcriptScrollRef} className="h-full overflow-y-auto space-y-2 text-sm text-gray-300">{transcript.map((t, i) => (<div key={i} className={t.role === 'agent' ? "text-blue-400 italic" : ""}>{t.text}</div>))}</div>
                </div>
            </div>
            <div className="flex-1 h-full flex flex-col relative">
                <div className="flex justify-between items-center mb-4"><h3 className="text-xs font-mono text-purple-400">Identified Items</h3>{selectedItemIds.size > 0 && (<button onClick={handlePushToADO} disabled={isPushingToADO} className="bg-blue-600 px-3 py-1 rounded text-[10px] font-bold">Push {selectedItemIds.size}</button>)}</div>
                <div className="flex-1 bg-black/20 border border-white/5 rounded-2xl p-6 overflow-y-auto grid grid-cols-2 gap-4 content-start">
                    {items.map((item) => (
                         <div key={item.id} className={`p-4 border rounded-lg cursor-pointer ${selectedItemIds.has(item.id) ? 'border-blue-500 bg-blue-900/10' : 'border-white/10'}`} onClick={(e) => { if (!(e.target as any).closest('.chk')) { setFocusedItemId(item.id); setMode(AppMode.GROOMING); } }}>
                             <div className="flex justify-between mb-2"><div className="flex items-center gap-2"><div className="chk w-4 h-4 rounded border" onClick={(e) => { e.stopPropagation(); toggleSelection(item.id); }}>{selectedItemIds.has(item.id) && '✓'}</div><span className="text-[10px] font-mono">{item.type}</span></div></div>
                             <h4 className="font-medium text-gray-200">{item.title}</h4>
                             <p className="text-xs text-gray-400 line-clamp-2">{item.description}</p>
                         </div>
                    ))}
                </div>
            </div>
        </div>
      )}
      {mode === AppMode.GROOMING && (
        <div className="absolute inset-0 flex items-center justify-center perspective-[1500px]">
            <div className={`absolute inset-0 pt-24 px-12 overflow-y-auto transition-all ${focusedItemId ? 'opacity-30 blur-sm' : ''}`}>
                <div className="grid grid-cols-3 gap-6 max-w-6xl mx-auto">{filteredItems.map(item => (<div key={item.id} onClick={() => setFocusedItemId(item.id)} className="bg-white/5 border border-white/10 p-6 rounded-xl cursor-pointer hover:border-blue-500"><h3>{item.title}</h3><p className="text-sm text-slate-500 line-clamp-2">{item.description}</p></div>))}</div>
            </div>
            {focusedItemId && (<>
                <div className="absolute inset-0 z-10" onClick={() => { setFocusedItemId(null); setFocusedField(null); }} />
                <div className="absolute inset-0 z-20 pointer-events-none flex items-center justify-center">
                    {items.filter(i => i.id === focusedItemId).map(item => (<div key={item.id} className="pointer-events-auto"><WorkItemCard item={item} relationships={focusedRelationships} isFocused={true} isAdjacent={false} onClick={() => {}} onFieldClick={setFocusedField} onUpdate={handleManualUpdate} focusedField={focusedField} /></div>))}
                </div>
            </>)}
        </div>
      )}
      {error && <div className="absolute bottom-32 left-1/2 -translate-x-1/2 bg-red-900 px-6 py-3 rounded-lg border border-red-500 z-[70]">{error}</div>}
      <div className="absolute bottom-8 left-0 w-full flex flex-col items-center gap-4 z-50 pointer-events-none">
        <Visualizer isActive={isCommanding || (isMeetingRunning && activeSessionType === 'SCRIBE')} />
        <div className="text-xs font-mono uppercase text-slate-600">{isCommanding ? '••• COMMAND MODE •••' : (isMeetingRunning ? '• RECORDING •' : 'SPACE TO COMMAND')}</div>
      </div>
    </div>
  );
}
