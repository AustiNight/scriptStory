
export enum WorkItemType {
  EPIC = 'EPIC',
  FEATURE = 'FEATURE',
  STORY = 'STORY',
  TASK = 'TASK',
  BUG = 'BUG'
}

export enum Priority {
  MUST_DO = '1: Must do',
  HIGH_VALUE = '2: High value',
  NICE_TO_HAVE = '3: Nice to have',
  NOT_PLANNED = '4: Not planned'
}

export enum Risk {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low'
}

export const FIBONACCI_SEQUENCE = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export interface AcceptanceCriteria {
  id: string;
  text: string; // Gherkin format expected for processed items
  met: boolean;
}

export interface WorkItem {
  id: string;
  type: WorkItemType;
  title: string;
  description: string;
  priority: Priority;
  risk?: Risk;
  criteria: AcceptanceCriteria[];
  parentId?: string | null;
  relatedIds?: string[]; // IDs of related items (siblings/dependencies)
  aiNotes?: string;
  storyPoints?: number;
  assignee?: string;
  stepsToReproduce?: string[]; 
  actualResult?: string;
  expectedResult?: string;
  // Integration fields
  adoId?: number; // The ID assigned by Azure DevOps
  syncedToADO?: boolean;
}

export enum AppMode {
  MEETING = 'MEETING',
  GROOMING = 'GROOMING'
}

export interface SavedTranscript {
  id: string;
  timestamp: number;
  fullText: string;
  summary: string;
}

export interface PushedItemLog {
  id: string;
  itemType: WorkItemType;
  title: string;
  adoId: number;
  timestamp: number;
}

export interface ADOConfig {
  organization: string;
  project: string;
  pat: string; // Personal Access Token
}

export interface ContextSource {
  id: string;
  name: string;
  type: 'FILE' | 'PASTE';
  content: string; // Text content OR Base64 image data
  mimeType?: string; // e.g. 'image/png', 'application/json', 'text/plain'
  enabled: boolean;
  description?: string; 
}

export type SearchMode = 'TEXT' | 'WILDCARD' | 'REGEX';

export interface FilterState {
  type?: WorkItemType;
  priority?: Priority;
  storyPoints?: number;
  search?: string; // Text search query
  searchMode?: SearchMode;
}

// Gemini Tool Arguments
export interface UpdateWorkItemArgs {
  id: string;
  title?: string;
  description?: string;
  priority?: string;
  risk?: string;
  type?: string;
  storyPoints?: number;
  addCriteria?: string;
  addStep?: string;
  parentId?: string; // Added for linking
  addRelatedId?: string; // Added for non-hierarchical linking
  actualResult?: string;
  expectedResult?: string;
}

export interface CreateWorkItemArgs {
  type: string;
  title: string;
  description: string;
  parentId?: string;
  priority?: string;
  risk?: string;
  // Extended fields for one-shot creation
  criteria?: { text: string; met: boolean }[];
  stepsToReproduce?: string[];
  expectedResult?: string;
  actualResult?: string;
  // Batch processing fields
  tempId?: string;
  parentTempId?: string;
  relatedTempIds?: string[];
}

export interface NavigationArgs {
  targetId: string | null;
  targetField?: string; 
}

export interface SwitchModeArgs {
  mode: string; // MEETING or GROOMING
}

export interface FilterArgs {
  type?: string;
  priority?: string;
  storyPoints?: number;
  searchQuery?: string;
  clear?: boolean;
}

export interface VisualArgs {
  enableBlur: boolean;
}

export interface DeleteArgs {
  id: string;
}
