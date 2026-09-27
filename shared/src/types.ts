export interface SavedPagePayload {
  url: string;
  title: string;
  domain: string;
  pageContent: string;
  description?: string | null;
  transcript?: string | null;
  highlightText?: string | null;
  highlightContext?: string | null;
  elementSelector?: string | null;
  noteText?: string | null;
  summary?: string | null;
  folderId?: number | null;
  cleanedContent?: string | null;
  /** Set when the capture is already in a fixed, cleaned format (the server then skips AI cleanup). */
  format?: "youtube-v1";
}

export interface SavedPageRecord extends SavedPagePayload {
  id: number;
  createdAt: string;
  pinned: boolean;
}

export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
}

export interface InsertPageResult {
  id: number;
  duplicateCount: number;
}

export interface TabSessionTab {
  url: string;
  title: string;
  favIconUrl?: string | null;
}

export interface TabSession {
  id: string;
  tabs: TabSessionTab[];
  createdAt: string;
}

export interface SavedPageSummary {
  id: number;
  url: string;
  title: string;
  domain: string;
  createdAt: string;
  hasDescription: boolean;
  hasTranscript: boolean;
  hasHighlight: boolean;
  hasElementSelector: boolean;
  hasNote: boolean;
  hasSummary: boolean;
  pinned: boolean;
  folderId: number | null;
  folderName: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatCurrentPage {
  title: string;
  url: string;
  content: string;
}

export interface ChatRequest {
  message: string;
  history: ChatMessage[];
  currentPage?: ChatCurrentPage | null;
}

export interface ChatSource {
  id: number | null; // null = the current tab (not a saved page)
  title: string;
  url: string;
  domain: string;
}

export interface ChatResponse {
  reply: string;
  sourceIds: number[];
  sources: ChatSource[];
}

export interface ExplainRequest {
  selection: string;
  pageTitle: string;
  surroundingContext: string;
}

export interface ExplainResponse {
  explanation: string;
}

export type AIRole = "cleanup" | "categorize" | "summarize" | "chat" | "embeddings";

export interface ProviderModelPair {
  provider: string;
  model: string;
}

export interface AIRoleConfig {
  chain: ProviderModelPair[];
}

export interface AISettingsResponse {
  roles: Record<AIRole, AIRoleConfig | null>;
  knownProviders: string[];
  envDefaults: Record<AIRole, string>;
}

export interface AIErrorEntry {
  timestamp: string;
  role: AIRole;
  provider: string;
  model: string;
  message: string;
}
