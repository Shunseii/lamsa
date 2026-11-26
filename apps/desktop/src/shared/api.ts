import type { CommentThread, DesignNode, LamsaConfig, TokenSet } from "@lamsa/schema";
import type { AgentAvailability, AgentSendRequest, AgentSessionSummary, AgentTerminalState, AgentTurnEvents, ChatItem } from "./agent.js";

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
  /** The agent that made the change, when the editor's own chat was running a turn. */
  agent?: string;
}

/** A CLI command the agent ran (from `.lamsa/activity.json`): where the editor shows the agent working. */
export interface AgentActivity {
  agent: string;
  command: string;
  kind: "read" | "write";
  ids: string[];
  file?: string;
}

/** The project's comment threads, oldest first, plus thread files that couldn't be read. */
export interface CommentsState {
  threads: CommentThread[];
  errors: string[];
}

/** A change the user makes to comments in the editor; the main process signs it with their git name. */
export type CommentRequest =
  | { kind: "add"; nodeId: string; offset?: { x: number; y: number }; text: string }
  | { kind: "reply"; id: string; text: string }
  | { kind: "resolve"; id: string; reply?: string }
  | { kind: "reopen"; id: string };

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

/** One top-level frame as the canvas rendered it, to be drawn into a small bitmap (main/frame-snapshots.ts). */
export interface FrameSnapshotRequest {
  /** The frame's shadow root contents: its styles and markup, with animations already at rest. */
  html: string;
  /** Project fonts, with URLs already pointing at this window's `lamsa-asset://` host. */
  fontCss: string;
  fontLinks: string[];
  /** The frame's size in CSS pixels. */
  width: number;
  height: number;
  /** Bitmap pixels per CSS pixel. */
  scale: number;
  /** Text styles the frame inherits from the canvas around it. */
  inherited: Record<string, string>;
}

/** A newer lamsa release: `available` to download by hand (the .deb), `ready` once downloaded to install on restart. */
export type UpdateStatus = { state: "none" } | { state: "available"; version: string } | { state: "ready"; version: string };

export interface LamsaApi {
  /** Host of this window's `lamsa-asset://` URLs: each window serves images and fonts from its own project. */
  assetHost: string;
  welcome(): Promise<WelcomeState>;
  /** Removes a project from the recent list (the folder itself is untouched). */
  forgetRecent(root: string): Promise<WelcomeState>;
  /** A picked folder without lamsa.config.json comes back as `uninitialised`, unless this window has a project (it opens a new window). */
  chooseFolder(): Promise<{ root?: string; uninitialised?: string }>;
  /**
   * Opens a project in this window when it has none. Otherwise the project opens in its own window (or the window that
   * already has it comes forward) and this returns null.
   */
  openProject(root: string): Promise<ProjectSnapshot | null>;
  /** Closes the project (and stops its agent chat turn) to go back to the welcome screen. */
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
  /** A PNG of a frame as the canvas shows it; null when it couldn't be drawn. */
  frameSnapshot(request: FrameSnapshotRequest): Promise<Uint8Array | null>;
  importImage(): Promise<{ src: string } | null>;
  revealPath(path: string): Promise<void>;
  /** Whether the agent chat can run; null when no project is open. */
  agentStatus(): Promise<AgentAvailability | null>;
  /** Starts a chat turn; its events arrive through `onAgentEvents`. */
  agentSend(request: AgentSendRequest): Promise<{ ok: boolean; turnId?: string; error?: string }>;
  agentStop(): Promise<void>;
  /** This project's past conversations, newest first. */
  agentSessions(): Promise<AgentSessionSummary[]>;
  /** A past conversation as chat items; null when it has no saved session yet. */
  agentTranscript(sessionId: string): Promise<ChatItem[] | null>;
  /** Continues the session (a new one when null) in the user's own terminal. */
  agentTerminal(request: { sessionId: string | null; resume: boolean }): Promise<{ ok: boolean; error?: string; sessionId?: string }>;
  /** Opens the agent CLI in the user's terminal so they can sign in there. */
  agentSignIn(): Promise<{ ok: boolean; error?: string }>;
  /** This project's comment threads (empty when no project is open). */
  comments(): Promise<CommentsState>;
  /** Writes a comment, reply, resolve or reopen to the thread files and returns the threads after it. */
  updateComments(request: CommentRequest): Promise<CommentsState>;
  /** Comment threads changed on disk (the agent's CLI, or another window). */
  onCommentsChanged(listener: (state: CommentsState) => void): () => void;
  onExternalChange(listener: (change: ExternalChange) => void): () => void;
  onAgentActivity(listener: (activity: AgentActivity) => void): () => void;
  onOpenRequest(listener: (request: OpenRequest) => void): () => void;
  onAgentEvents(listener: (batch: AgentTurnEvents) => void): () => void;
  onAgentTerminal(listener: (state: AgentTerminalState) => void): () => void;
  onProjectReloaded(listener: (snapshot: ProjectSnapshot) => void): () => void;
  updateStatus(): Promise<UpdateStatus>;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<void>;
  /** Opens the latest release's download page. */
  openUpdateDownload(): Promise<void>;
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
}
