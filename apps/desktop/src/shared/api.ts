import type { DesignNode, LamsaConfig, TokenSet } from "@lamsa/schema";

export interface FileState {
  path: string;
  /** Last valid nodes; kept on screen while the file on disk is invalid. */
  nodes: Record<string, DesignNode>;
  /** File-level CSS: the `@keyframes` its nodes can use. */
  css?: string;
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
  /** Files shown in the editor (paths as in `files`); null until the user picks them. */
  open: string[] | null;
}

/** The result of adding files to the session: what loaded, the new open list, and anything that couldn't be added. */
export interface AddFilesResult {
  files: FileState[];
  open: string[];
  issues: ProjectIssue[];
  errors: string[];
}

/** A node-level write: `node: null` deletes it. */
export interface NodeChange {
  file: string;
  id: string;
  node: DesignNode | null;
}

/** Replaces a file's `css` (its @keyframes and ::view-transition-* rules); empty removes it. */
export interface FileCssChange {
  file: string;
  css: string;
}

export type Change = NodeChange | FileCssChange;

/** A node's `css` (declarations and nested rules) or a file's `css` (@keyframes, ::view-transition-*). */
export type CssScope = "node" | "file";

export const isCssChange = (change: Change): change is FileCssChange => "css" in change;

export interface ExternalChange {
  path: string;
  file: FileState;
  changedIds: string[];
  issues: ProjectIssue[];
  /** The open list, when this change altered it (a new file was created, or an open one deleted). */
  open?: string[];
}

export interface OpenRequest {
  root?: string;
  file?: string;
  select?: string[];
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
  /** Removes a project from the recent list (the folder itself is untouched). */
  forgetRecent(root: string): Promise<WelcomeState>;
  chooseFolder(): Promise<{ root?: string; uninitialised?: string }>;
  openProject(root: string): Promise<ProjectSnapshot>;
  /** Closes the project (and its agent terminal) to go back to the welcome screen. */
  closeProject(): Promise<void>;
  current(): Promise<ProjectSnapshot | null>;
  applyChanges(changes: Change[]): Promise<{ ok: boolean; error?: string; issues: ProjectIssue[] }>;
  icons(names: string[]): Promise<Record<string, string>>;
  /** Formats a node's CSS the way `lamsa fmt` does; unparseable CSS comes back unchanged. */
  formatCss(css: string, scope?: CssScope): Promise<string>;
  /** Problems in a node's CSS (syntax, misplaced @keyframes). */
  checkCss(css: string, scope?: CssScope): Promise<{ message: string; line?: number }[]>;
  /** Every lucide icon name, sorted. */
  iconNames(): Promise<string[]>;
  setSelection(selection: string[], file?: string): Promise<void>;
  /** Native file picker for design files; returns absolute paths (empty when cancelled). */
  pickDesignFiles(): Promise<string[]>;
  /** Loads files (absolute or repo-relative) and opens them in the editor. */
  addFiles(paths: string[]): Promise<AddFilesResult>;
  /** Replaces the open list, e.g. from the first-open prompt. */
  setOpenFiles(paths: string[]): Promise<string[]>;
  /** Hides a file from the editor; it stays loaded so instances of its components keep rendering. */
  closeFile(path: string): Promise<string[]>;
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
