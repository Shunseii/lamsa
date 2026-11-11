import type { DesignNode, LamsaConfig, TokenSet } from "@lamsa/schema";

export interface FileState {
  path: string;
  /** Last valid nodes; kept on screen while the file on disk is invalid. */
  nodes: Record<string, DesignNode>;
  /** Set while the file on disk can't be read as a design file. */
  error?: string;
}

export interface ProjectIssue {
  severity: "error" | "warning";
  code: string;
  file?: string;
  nodeId?: string;
  message: string;
  fix?: string;
}

export interface ProjectSnapshot {
  root: string;
  name: string;
  config: LamsaConfig;
  files: Record<string, FileState>;
  tokens: TokenSet;
  tokenError?: string;
  fontCss: string;
  fontLinks: string[];
  issues: ProjectIssue[];
}

/** A node-level write: `node: null` deletes it. */
export interface NodeChange {
  file: string;
  id: string;
  node: DesignNode | null;
}

export interface ExternalChange {
  path: string;
  file: FileState;
  changedIds: string[];
  issues: ProjectIssue[];
}

export interface OpenRequest {
  root?: string;
  file?: string;
  select?: string;
}

export interface RecentProject {
  root: string;
  name: string;
  openedAt: string;
}

export interface WelcomeState {
  recent: RecentProject[];
  /** Folder the user picked that has no lamsa.config.json yet. */
  uninitialised?: string;
}

export interface RenderResultSummary {
  id: string;
  path: string;
  width: number;
  height: number;
}

export interface LamsaApi {
  welcome(): Promise<WelcomeState>;
  chooseFolder(): Promise<{ root?: string; uninitialised?: string }>;
  openProject(root: string): Promise<ProjectSnapshot>;
  current(): Promise<ProjectSnapshot | null>;
  applyChanges(changes: NodeChange[]): Promise<{ ok: boolean; error?: string; issues: ProjectIssue[] }>;
  icons(names: string[]): Promise<Record<string, string>>;
  /** Every lucide icon name, sorted. */
  iconNames(): Promise<string[]>;
  setSelection(selection: string[], file?: string): Promise<void>;
  render(ids: string[], mode?: "light" | "dark"): Promise<RenderResultSummary[]>;
  importImage(): Promise<{ src: string } | null>;
  revealPath(path: string): Promise<void>;
  terminalStart(cols: number, rows: number): Promise<{ ok: boolean; error?: string; command: string }>;
  terminalWrite(data: string): void;
  terminalResize(cols: number, rows: number): void;
  terminalExternal(): Promise<{ ok: boolean; error?: string }>;
  onExternalChange(listener: (change: ExternalChange) => void): () => void;
  onOpenRequest(listener: (request: OpenRequest) => void): () => void;
  onTerminalData(listener: (data: string) => void): () => void;
  onTerminalExit(listener: (code: number) => void): () => void;
  onProjectReloaded(listener: (snapshot: ProjectSnapshot) => void): () => void;
}
