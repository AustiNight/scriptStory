
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { WorkItem, WorkItemType, Priority, Risk, CreateWorkItemArgs, UpdateWorkItemArgs, AppMode, SavedTranscript, ADOConfig, FilterState, FilterArgs, VisualArgs, DeleteArgs, SwitchModeArgs, FIBONACCI_SEQUENCE, SearchMode, PushedItemLog, ContextSource } from './types';
import { geminiLive, SessionType } from './services/geminiLiveService';
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
  const [settingsTab, setSettingsTab] = useState<'ADO' | 'KNOWLEDGE'>('ADO');
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
  
  const createWorkItem = useCallback(async (args: CreateWorkItemArgs) => {
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
      actualResult: args.actualResult
    };
    
    setItems(prev => [...prev, newItem]);
    if (mode === AppMode.GROOMING) { setFocusedItemId(newItem.id); setFocusedField('description'); }
    return `Created ${newItem.type} titled "${newItem.title}"`;
  }, [mode]);

  const updateWorkItem = useCallback(async (args: UpdateWorkItemArgs) => {
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
      try {
          const projectContext = itemsRef.current.map(i => `ID:${i.id} Type:${i.type} Title:"${i.title}"`).join('\n');
          const activeSources = contextSourcesRef.current.filter(src => src.enabled);
          const toolCalls = await geminiLive.analyzeMeetingTranscript(segment, projectContext, activeSources);
          if (toolCalls && toolCalls.length > 0) {
              for (const call of toolCalls) {
                 const tools = latestRef.current;
                 if (call.name === 'createWorkItem') await tools.createWorkItem(call.args as CreateWorkItemArgs);
                 else if (call.name === 'updateWorkItem') await tools.updateWorkItem(call.args as UpdateWorkItemArgs);
              }
          }
      } catch (e) { console.error(e); } finally { setIsAnalyzingMeeting(false); }
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
        if (isCommanding) {
            if (activeSessionType !== 'COMMANDER') { await geminiLive.disconnect(); await geminiLive.connect('COMMANDER'); geminiLive.setMute(false); setActiveSessionType('COMMANDER'); }
        } else if (isMeetingRunning) {
            if (activeSessionType !== 'SCRIBE') { await geminiLive.disconnect(); await geminiLive.connect('SCRIBE'); geminiLive.setMute(false); setActiveSessionType('SCRIBE'); }
        } else if (activeSessionType) { await geminiLive.disconnect(); setActiveSessionType(null); }
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
              <div className="bg-[#111] border border-white/10 rounded-2xl w-full max-w-2xl h-[600px] flex flex-col">
                  <div className="p-6 border-b border-white/10 flex justify-between items-center"><h2 className="text-xl font-light">Project Configuration</h2><button onClick={() => setShowSettings(false)}>✕</button></div>
                  <div className="flex border-b border-white/5 px-6">
                      <button onClick={() => setSettingsTab('ADO')} className={`px-4 py-3 text-xs font-bold ${settingsTab === 'ADO' ? 'border-b-2 border-blue-500 text-white' : 'text-gray-500'}`}>Integrations</button>
                      <button onClick={() => setSettingsTab('KNOWLEDGE')} className={`px-4 py-3 text-xs font-bold ${settingsTab === 'KNOWLEDGE' ? 'border-b-2 border-purple-500 text-white' : 'text-gray-500'}`}>Knowledge Base</button>
                  </div>
                  <div className="p-6 overflow-y-auto flex-1">
                      {settingsTab === 'ADO' && (
                          <div className="space-y-4 max-w-md mx-auto">
                              <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Org" value={adoConfig.organization} onChange={e => setAdoConfig({...adoConfig, organization: e.target.value})} />
                              <input type="text" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="Project" value={adoConfig.project} onChange={e => setAdoConfig({...adoConfig, project: e.target.value})} />
                              <input type="password" className="w-full bg-black/50 border border-white/10 rounded px-3 py-2 text-sm" placeholder="PAT" value={adoConfig.pat} onChange={e => setAdoConfig({...adoConfig, pat: e.target.value})} />
                          </div>
                      )}
                      {settingsTab === 'KNOWLEDGE' && (
                          <div className="space-y-6">
                              <div onClick={() => contextFileInputRef.current?.click()} className="border-2 border-dashed border-white/10 rounded-xl h-[120px] flex items-center justify-center cursor-pointer text-gray-500">Upload Context Files (Multiple)</div>
                              <input type="file" ref={contextFileInputRef} className="hidden" onChange={handleContextFileUpload} multiple />
                              <div className="space-y-2">{contextSources.map(src => (
                                  <div key={src.id} className="flex items-center justify-between bg-white/5 p-3 rounded-lg"><span className="text-sm">{src.name}</span><button onClick={() => setContextSources(prev => prev.filter(s => s.id !== src.id))} className="text-red-500 text-xs">Remove</button></div>
                              ))}</div>
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
