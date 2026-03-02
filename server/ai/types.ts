export interface ContextSourceInput {
  id?: string;
  name: string;
  type: "FILE" | "PASTE";
  content: string;
  mimeType?: string;
  enabled?: boolean;
}

export interface WorkItemInput {
  type: string;
  title: string;
  description: string;
}
