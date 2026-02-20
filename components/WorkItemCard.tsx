
import React from 'react';
import { WorkItem, WorkItemType, Priority, Risk, FIBONACCI_SEQUENCE } from '../types';

export interface Relationship {
  id: string;
  title: string;
  type: 'Parent' | 'Child' | 'Related';
}

interface Props {
  item: WorkItem;
  relationships?: Relationship[]; // Passed from App
  isFocused: boolean;
  isAdjacent: boolean;
  onClick: () => void;
  onFieldClick: (field: string) => void;
  onUpdate: (id: string, updates: Partial<WorkItem>) => void;
  focusedField: string | null;
}

const typeColors: Record<WorkItemType, string> = {
  [WorkItemType.EPIC]: 'bg-purple-900/80 border-purple-500/40 shadow-[0_0_30px_rgba(168,85,247,0.1)]',
  [WorkItemType.FEATURE]: 'bg-blue-900/80 border-blue-500/40 shadow-[0_0_30px_rgba(59,130,246,0.1)]',
  [WorkItemType.STORY]: 'bg-green-900/80 border-green-500/40 shadow-[0_0_30px_rgba(34,197,94,0.1)]',
  [WorkItemType.TASK]: 'bg-slate-700/80 border-slate-500/40 shadow-[0_0_30px_rgba(148,163,184,0.1)]',
  [WorkItemType.BUG]: 'bg-red-900/80 border-red-500/40 shadow-[0_0_30px_rgba(239,68,68,0.1)]',
};

const priorityColors: Record<string, string> = {
    '1: Must do': 'bg-red-500/40 border-red-500 text-red-100',
    '2: High value': 'bg-orange-500/40 border-orange-500 text-orange-100',
    '3: Nice to have': 'bg-blue-500/40 border-blue-500 text-blue-100',
    '4: Not planned': 'bg-gray-500/40 border-gray-500 text-gray-300'
};

const riskColors: Record<string, string> = {
    'High': 'bg-red-600/50 border-red-400',
    'Medium': 'bg-yellow-600/50 border-yellow-400',
    'Low': 'bg-green-600/50 border-green-400'
};

export const WorkItemCard: React.FC<Props> = ({ item, relationships = [], isFocused, isAdjacent, onClick, onFieldClick, onUpdate, focusedField }) => {
  
  let cardRotation = 'rotateX(0deg)';
  let yShift = '0px';
  
  if (isFocused) {
    if (focusedField === 'title') {
        cardRotation = 'rotateX(-5deg)'; 
        yShift = '200px'; 
    }
    else if (focusedField === 'description') {
        cardRotation = 'rotateX(-2deg)'; 
        yShift = '100px'; 
    }
    else if (focusedField === 'criteria') {
        cardRotation = 'rotateX(2deg)'; 
        yShift = '-100px'; 
    }
    else if (focusedField === 'relationships') {
        cardRotation = 'rotateX(5deg)'; 
        yShift = '-150px'; 
    }
    else if (focusedField === 'meta') {
        cardRotation = 'rotateX(10deg)'; 
        yShift = '-220px'; 
    }
    else if (focusedField === 'priority' || focusedField === 'risk' || focusedField === 'points') {
        cardRotation = 'rotateX(-5deg)';
        yShift = '200px';
    }
  }

  // Helper for field styles
  const getFieldStyle = (fieldName: string) => {
    const isThisFocused = focusedField === fieldName;
    if (!isFocused) return {};
    
    if (isThisFocused) {
      return {
        transform: 'translateZ(60px) scale(1.02)', 
        filter: 'none', 
        backdropFilter: 'none', 
        opacity: 1,
        borderColor: 'rgba(255,255,255,1)',
        backgroundColor: '#0f0f11', // Fully opaque background for editing
        backgroundImage: 'none',
        boxShadow: '0 30px 60px rgba(0,0,0,1)', 
        backfaceVisibility: 'hidden' as any,
        zIndex: 50,
        color: '#ffffff',
      };
    } else {
      return {
        transform: 'translateZ(0px) scale(1)',
        filter: 'blur(0px)', 
        opacity: 0.4, 
      };
    }
  };

  const baseTransform = isFocused 
    ? `translate(-50%, calc(-50% + ${yShift})) translateZ(200px) ${cardRotation}` 
    : 'translate(-50%, -50%) translateZ(0px) scale(1)';
  
  const pointerEvents = isFocused ? 'auto' : 'none';

  return (
    <div 
      onClick={onClick}
      className={`
        absolute top-1/2 left-1/2 
        w-[700px] h-[650px] rounded-3xl border backdrop-blur-3xl p-6
        transition-all duration-700 ease-[cubic-bezier(0.23,1,0.32,1)]
        ${typeColors[item.type]}
        flex flex-col gap-4
        shadow-2xl
      `}
      style={{
        transform: baseTransform,
        transformStyle: 'preserve-3d',
        pointerEvents: pointerEvents as any,
      }}
    >
      {/* 1. Header / Title Section */}
      <div 
        className="relative transition-all duration-500 p-4 rounded-xl border border-transparent hover:bg-white/5 bg-[#0f0f11]/40 shrink-0"
      >
        <div className="flex justify-between items-start mb-2">
          <span className="text-xs font-mono uppercase tracking-[0.2em] opacity-60">{item.type}</span>
          
          <div className="flex gap-2 relative z-10">
              {/* POINTS SELECTOR */}
              <div 
                onClick={(e) => { e.stopPropagation(); onFieldClick('points'); }}
                style={getFieldStyle('points')}
                className="relative"
              >
                  {isFocused ? (
                      <select 
                        value={item.storyPoints || 0}
                        onChange={(e) => onUpdate(item.id, { storyPoints: parseInt(e.target.value) })}
                        className="text-xs font-mono px-2 py-1 rounded bg-gray-800 border border-gray-600 text-white outline-none appearance-none cursor-pointer hover:bg-gray-700"
                      >
                          <option value={0}>- PTS</option>
                          {FIBONACCI_SEQUENCE.map(n => <option key={n} value={n}>{n} PTS</option>)}
                      </select>
                  ) : (
                      <div className="text-xs font-mono px-3 py-1 rounded border border-gray-600 bg-gray-800/50 min-w-[30px] text-center">
                          {item.storyPoints !== undefined ? item.storyPoints : '-'} PTS
                      </div>
                  )}
              </div>

              {/* PRIORITY SELECTOR */}
              <div
                onClick={(e) => { e.stopPropagation(); onFieldClick('priority'); }}
                style={getFieldStyle('priority')}
                className="relative"
              >
                  {isFocused ? (
                       <select 
                         value={item.priority}
                         onChange={(e) => onUpdate(item.id, { priority: e.target.value as Priority })}
                         className={`text-xs font-bold px-2 py-1 rounded border outline-none appearance-none cursor-pointer ${priorityColors[item.priority]}`}
                       >
                           {Object.values(Priority).map(p => <option key={p} value={p} className="text-black">{p}</option>)}
                       </select>
                  ) : (
                       <div className={`text-xs font-bold px-3 py-1 rounded border ${priorityColors[item.priority]}`}>
                           {item.priority}
                       </div>
                  )}
              </div>
              
              {/* RISK SELECTOR */}
              <div
                onClick={(e) => { e.stopPropagation(); onFieldClick('risk'); }}
                style={getFieldStyle('risk')}
                className="relative"
              >
                  {isFocused ? (
                      <select
                        value={item.risk || 'Low'}
                        onChange={(e) => onUpdate(item.id, { risk: e.target.value as Risk })}
                        className={`text-xs font-bold px-2 py-1 rounded border outline-none appearance-none cursor-pointer flex items-center gap-1 ${item.risk ? riskColors[item.risk] : 'bg-gray-800/50 border-gray-600 text-gray-400'}`}
                      >
                          {Object.values(Risk).map(r => <option key={r} value={r} className="text-black">{r}</option>)}
                      </select>
                  ) : (
                      <div className={`text-xs font-bold px-3 py-1 rounded border ${item.risk ? riskColors[item.risk] : 'bg-gray-800/50 border-gray-600 text-gray-400'}`}>
                           Risk: {item.risk || 'N/A'}
                      </div>
                  )}
              </div>
          </div>
        </div>
        
        <div 
             onClick={(e) => { e.stopPropagation(); onFieldClick('title'); }}
             style={getFieldStyle('title')}
             className="rounded-lg p-2 -ml-2 border border-transparent"
        >
            {isFocused ? (
                <textarea
                    value={item.title}
                    onChange={(e) => onUpdate(item.id, { title: e.target.value })}
                    className="w-full bg-transparent text-3xl font-light tracking-tight leading-none text-white outline-none resize-none overflow-hidden"
                    rows={item.title.length > 30 ? 2 : 1}
                    autoFocus={focusedField === 'title'}
                />
            ) : (
                <h2 className="text-3xl font-light tracking-tight leading-none text-white/90 line-clamp-2">
                    {item.title}
                </h2>
            )}
        </div>
      </div>

      {/* 2. Description Section */}
      <div 
        onClick={(e) => { e.stopPropagation(); onFieldClick('description'); }}
        className="relative flex-1 min-h-[120px] overflow-y-auto p-4 rounded-xl border border-transparent transition-all duration-500 cursor-pointer hover:bg-white/5 bg-[#0f0f11]/40"
        style={getFieldStyle('description')}
      >
        <div className="text-xs text-blue-300/50 uppercase tracking-widest mb-2 font-bold sticky top-0 bg-[#0f0f11]/0 backdrop-blur-0 w-full">Description</div>
        
        {isFocused ? (
            <textarea
                value={item.description}
                onChange={(e) => onUpdate(item.id, { description: e.target.value })}
                className="w-full h-[90%] bg-transparent text-base text-gray-200 leading-relaxed font-light resize-none outline-none"
                autoFocus={focusedField === 'description'}
            />
        ) : (
            <p className="text-base text-gray-200 leading-relaxed font-light whitespace-pre-wrap">
                {item.description}
            </p>
        )}
      </div>

      {/* 3. Acceptance Criteria / Steps */}
      <div 
        onClick={(e) => { e.stopPropagation(); onFieldClick('criteria'); }}
        className="relative flex-1 min-h-[100px] overflow-y-auto p-4 rounded-xl border border-transparent transition-all duration-500 cursor-pointer hover:bg-white/5 bg-[#0f0f11]/40"
        style={getFieldStyle('criteria')}
      >
        <div className="text-xs text-emerald-300/50 uppercase tracking-widest mb-2 font-bold sticky top-0 bg-[#0f0f11]/0 backdrop-blur-0 w-full">
          {item.type === WorkItemType.BUG ? 'Steps to Reproduce' : 'Acceptance Criteria'}
        </div>
        <div className="space-y-2">
          {item.type === WorkItemType.BUG ? (
            isFocused ? (
                <textarea 
                    value={item.stepsToReproduce?.join('\n') || ''}
                    onChange={(e) => onUpdate(item.id, { stepsToReproduce: e.target.value.split('\n') })}
                    className="w-full h-full bg-transparent text-sm text-gray-300 font-mono outline-none resize-none"
                    placeholder="Enter steps, one per line..."
                />
            ) : (
                item.stepsToReproduce?.length ? (
                <div className="text-sm text-gray-300 space-y-1 font-mono">
                    {item.stepsToReproduce.map((step, i) => <div key={i}>{step}</div>)}
                </div>
                ) : <span className="text-white/20 italic text-sm">No steps defined...</span>
            )
          ) : (
            // STORIES / FEATURES
            <ul className="space-y-2">
                 {item.criteria?.map((c, idx) => (
                   <li key={c.id} className="flex items-start gap-2 text-sm text-gray-300">
                     <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            if (isFocused) {
                                const newCriteria = [...item.criteria];
                                newCriteria[idx].met = !newCriteria[idx].met;
                                onUpdate(item.id, { criteria: newCriteria });
                            }
                        }}
                        className={`mt-1 w-3 h-3 rounded-full border shrink-0 transition-colors ${c.met ? 'bg-green-500 border-green-500' : 'border-gray-500 hover:border-white'}`} 
                     />
                     {isFocused ? (
                         <input 
                            value={c.text}
                            onChange={(e) => {
                                const newCriteria = [...item.criteria];
                                newCriteria[idx].text = e.target.value;
                                onUpdate(item.id, { criteria: newCriteria });
                            }}
                            className="bg-transparent w-full outline-none border-b border-transparent focus:border-white/20"
                         />
                     ) : (
                         <span className={c.met ? 'line-through opacity-50' : ''}>{c.text}</span>
                     )}
                   </li>
                 ))}
                 {isFocused && (
                     <li 
                        className="text-xs text-gray-500 italic cursor-pointer hover:text-white"
                        onClick={(e) => {
                            e.stopPropagation();
                            onUpdate(item.id, { 
                                criteria: [...item.criteria, { id: Math.random().toString(), text: 'New Criteria', met: false }] 
                            });
                        }}
                     >
                         + Add Criteria
                     </li>
                 )}
            </ul>
          )}
        </div>
      </div>

      {/* 4. Related Items / Links */}
      <div 
         onClick={(e) => { e.stopPropagation(); onFieldClick('relationships'); }}
         className="relative min-h-[60px] p-4 rounded-xl border border-transparent transition-all duration-500 bg-[#0f0f11]/40 overflow-hidden"
         style={getFieldStyle('relationships')}
      >
        <div className="text-xs text-indigo-300/50 uppercase tracking-widest mb-2 font-bold">Related Work Items</div>
        {relationships.length === 0 ? (
            <div className="text-xs text-white/20 italic">No linked items.</div>
        ) : (
            <div className="flex flex-wrap gap-2">
                {relationships.map((rel, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white/5 border border-white/10 px-2 py-1 rounded text-xs text-gray-300">
                        <span className={`
                            text-[9px] font-bold uppercase px-1 rounded
                            ${rel.type === 'Parent' ? 'bg-purple-500/30 text-purple-200' : ''}
                            ${rel.type === 'Child' ? 'bg-blue-500/30 text-blue-200' : ''}
                            ${rel.type === 'Related' ? 'bg-indigo-500/30 text-indigo-200' : ''}
                        `}>
                            {rel.type}
                        </span>
                        <span className="truncate max-w-[120px]">{rel.title}</span>
                        <span className="text-[9px] font-mono opacity-50">#{rel.id.split('-')[0]}</span>
                    </div>
                ))}
            </div>
        )}
      </div>

      {/* 5. Footer Meta Data */}
      <div 
         onClick={(e) => { e.stopPropagation(); onFieldClick('meta'); }}
         className="relative shrink-0 flex justify-between items-center pt-2 p-4 rounded-xl border border-transparent transition-all duration-500 bg-[#0f0f11]/40"
         style={getFieldStyle('meta')}
      >
        {item.aiNotes && (
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-amber-500/20 flex items-center justify-center border border-amber-500/50 text-amber-500 shrink-0">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <div className="text-xs text-amber-200/80 italic max-w-[400px] line-clamp-2">"{item.aiNotes}"</div>
          </div>
        )}
        <div className="text-xs font-mono text-gray-500 ml-auto">ID: {item.id.split('-')[0]}</div>
      </div>

    </div>
  );
};
