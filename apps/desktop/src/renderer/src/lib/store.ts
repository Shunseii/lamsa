import type { CommentThread, TokenMode, TokenSet } from "@lamsa/schema";
import { create } from "zustand";
import {
  isCssChange,
  type AgentActivity,
  type Change,
  type ExternalChange,
  type FileState,
  type LamsaApi,
  type ProjectIssue,
  type ProjectSnapshot,
} from "../../../shared/api";
import { changeHighlights, HIGHLIGHT_MS } from "./highlights";
import { buildModel, iconNamesIn, rootOf, type Model } from "./model";
import { activatePanel, DEFAULT_LAYOUT, dockOf, initialShown, movePanel, readLayout, resizeDock, writeLayout, type DockId, type DockShown, type PanelId, type PanelLayout } from "./layout";

declare global {
  interface Window {
    lamsa: LamsaApi;
  }
}

export const api = (): LamsaApi => window.lamsa;

export type Tool = "select" | "hand" | "frame" | "rect" | "text" | "image" | "icon" | "component" | "comment";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface Toast {
  id: number;
  tone: "neutral" | "ok" | "warn" | "danger";
  title: string;
  message?: string;
  action?: { label: string; run: () => void };
  /** Stays until dismissed or removed by the code that raised it, instead of timing out. */
  sticky?: boolean;
}

/** Where the agent is working: a labelled cursor on the canvas, at the first of `ids` that's on screen. */
export interface AgentCursor {
  name: string;
  /** Writes draw the cursor solid; reads (the agent looking at layers) draw it faint. */
  kind: "read" | "write";
  ids: string[];
  /** When it last moved; each move restarts its linger. */
  at: number;
}

interface HistoryEntry {
  label: string;
  changes: Change[];
  inverse: Change[];
}

export interface EditorState {
  screen: "loading" | "welcome" | "editor";
  snapshot: ProjectSnapshot | null;
  files: Record<string, FileState>;
  model: Model;
  issues: ProjectIssue[];
  selection: string[];
  hover: string | null;
  tool: Tool;
  viewport: Viewport;
  /** Whether each dock is shown; a dock without tabs stays collapsed either way. */
  panels: DockShown;
  /** Which panel is a tab in which dock, and each dock's size. Saved per user, never in design files. */
  layout: PanelLayout;
  canvasMode: TokenMode;
  /** Editor-only prop values for previewing a main component's variants; never saved. */
  previewProps: Record<string, Record<string, string | boolean>>;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  /** Why the last save failed; cleared by the next save that succeeds. */
  lastError?: string;
  toasts: Toast[];
  /** Layers an agent just changed on disk, each with when its highlight ends (the restart key for its fade). */
  flash: Record<string, number>;
  agentCursor: AgentCursor | null;
  icons: Record<string, string>;
  editingText: string | null;
  picker: boolean;
  contextMenu: { x: number; y: number } | null;
  renderVersion: number;
  /** Layers playing in the animation preview, in the order they were picked; null shows its empty state. */
  preview: string[] | null;
  /** The preview's dock fills the canvas area. */
  previewFullscreen: boolean;
  /** What the preview's dock showed before the preview took it over, so closing the preview puts it back. */
  previewReturn: { dock: DockId; shown: boolean; active: PanelId | null } | null;
  /** The keyboard shortcuts sheet. */
  help: boolean;
  /** The project's comment threads, oldest first (lib/comments.ts keeps them in sync with disk). */
  comments: CommentThread[];
  /** Design files shown in the editor; null until the user picks them (the first-open prompt shows). */
  openFiles: string[] | null;
}

interface EditorActions {
  loadSnapshot(snapshot: ProjectSnapshot): void;
  showWelcome(): void;
  commit(label: string, changes: Change[]): Promise<void>;
  undo(): void;
  redo(): void;
  applyExternal(change: ExternalChange): void;
  /** A CLI command the agent ran: moves its cursor to the layers it read or wrote. */
  noteAgentActivity(activity: AgentActivity): void;
  select(ids: string[]): void;
  setHover(id: string | null): void;
  setTool(tool: Tool): void;
  setViewport(viewport: Viewport): void;
  togglePanel(panel: keyof EditorState["panels"], value?: boolean): void;
  toggleSidebars(): void;
  /** Opens a panel's tab, and its dock if that was hidden. */
  showPanel(panel: PanelId): void;
  movePanel(move: { panel: PanelId; dock: DockId; index?: number }): void;
  setDockSize(resize: { dock: DockId; size: number | null }): void;
  resetLayout(): void;
  setCanvasMode(mode: TokenMode): void;
  setPreviewProp(componentId: string, prop: string, value: string | boolean | undefined): void;
  /** Shows a toast and returns its id. */
  toast(toast: Omit<Toast, "id">): number;
  dismissToast(id: number): void;
  setEditingText(id: string | null): void;
  setPicker(open: boolean): void;
  setContextMenu(menu: { x: number; y: number } | null): void;
  ensureIcons(): void;
  /** Shows the Preview tab, playing `ids` (none shows its empty state). */
  openPreview(ids: string[]): void;
  /** Hands the preview's dock back to what it showed before, or hides it. */
  closePreview(): void;
  setPreviewFullscreen(fullscreen: boolean): void;
  setHelp(open: boolean): void;
  /** Loads files (absolute or repo-relative paths) into the session and shows them. */
  addFiles(paths: string[]): Promise<void>;
  setOpenFiles(paths: string[]): Promise<void>;
  /**
   * Opens another project (folder picker when no root is given): here when this window is empty, otherwise in its own
   * window. False if nothing opened in this window.
   */
  switchProject(root?: string): Promise<boolean>;
  /** Closes the project and shows the welcome screen. */
  goHome(): Promise<void>;
  closeFile(path: string): Promise<void>;
}

let toastId = 0;
/** The name from the agent's latest CLI command, so changes it makes by editing JSON directly carry it too. */
let lastAgent: { name: string; at: number } | undefined;
const AGENT_NAME_FRESH_MS = 30_000;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let saveErrorToast: number | undefined;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;

const MAX_TOASTS = 4;

/** Drops the oldest toasts that time out on their own until another fits; sticky ones stay until they're dealt with. */
function withRoomForOneMore(toasts: Toast[]): Toast[] {
  const kept = [...toasts];
  while (kept.length >= MAX_TOASTS) {
    const oldest = kept.findIndex((toast) => !toast.sticky);
    kept.splice(oldest === -1 ? 0 : oldest, 1);
  }
  return kept;
}

function applyToFiles(files: Record<string, FileState>, changes: Change[]): Record<string, FileState> {
  const next = { ...files };
  for (const change of changes) {
    const file = next[change.file] ?? { path: change.file, nodes: {} };
    if (isCssChange(change)) {
      next[change.file] = { ...file, css: change.css.trim() ? change.css : undefined };
      continue;
    }
    const nodes = { ...file.nodes };
    if (change.node === null) delete nodes[change.id];
    else nodes[change.id] = change.node;
    next[change.file] = { ...file, nodes };
  }
  return next;
}

function inverseOf(files: Record<string, FileState>, changes: Change[]): Change[] {
  const seen = new Set<string>();
  const inverse: Change[] = [];
  for (const change of changes) {
    if (isCssChange(change)) {
      const key = `${change.file}\u0000css`;
      if (seen.has(key)) continue;
      seen.add(key);
      inverse.push({ file: change.file, css: files[change.file]?.css ?? "" });
      continue;
    }
    const key = `${change.file}\u0000${change.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inverse.push({ file: change.file, id: change.id, node: files[change.file]?.nodes[change.id] ?? null });
  }
  return inverse.reverse();
}

/** Keeps the old object for every node the disk change didn't touch, so frames that don't show those nodes skip re-rendering. */
function withUnchangedNodesKept({ previous, next, changedIds }: { previous: FileState | undefined; next: FileState; changedIds: string[] }): FileState {
  if (!previous || next.error) return next;
  const changed = new Set(changedIds);
  const nodes: FileState["nodes"] = {};
  for (const [id, node] of Object.entries(next.nodes)) nodes[id] = !changed.has(id) && previous.nodes[id] ? previous.nodes[id]! : node;
  return { ...next, nodes };
}

const emptyModel = buildModel({});

export const useEditor = create<EditorState & EditorActions>((set, get) => {
  const reportSave = (error: string | undefined) => {
    const failing = get().lastError !== undefined;
    set({ lastError: error });
    if (error === undefined) {
      if (saveErrorToast !== undefined) get().dismissToast(saveErrorToast);
      saveErrorToast = undefined;
      return;
    }
    // One toast per run of failures, not one per edit while saving keeps failing.
    if (failing) return;
    saveErrorToast = get().toast({ tone: "danger", title: "Couldn't save", message: error, sticky: true });
  };

  const send = async (changes: Change[]) => {
    try {
      const result = await api().applyChanges(changes);
      set({ issues: result.issues });
      reportSave(result.ok ? undefined : (result.error ?? "Unknown error"));
    } catch (error) {
      reportSave(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error));
    }
  };

  return {
    screen: "loading",
    snapshot: null,
    files: {},
    model: emptyModel,
    issues: [],
    selection: [],
    hover: null,
    tool: "select",
    viewport: { x: 80, y: 120, zoom: 1 },
    ...(() => {
      const layout = readLayout();
      return { layout, panels: initialShown(layout) };
    })(),
    canvasMode: "light",
    previewProps: {},
    undoStack: [],
    redoStack: [],
    toasts: [],
    flash: {},
    agentCursor: null,
    icons: {},
    editingText: null,
    picker: false,
    contextMenu: null,
    renderVersion: 0,
    preview: null,
    previewFullscreen: false,
    previewReturn: null,
    help: false,
    comments: [],
    openFiles: null,

    loadSnapshot(snapshot) {
      const model = buildModel(snapshot.files, snapshot.open);
      set({
        screen: "editor",
        snapshot,
        files: snapshot.files,
        openFiles: snapshot.open,
        model,
        issues: snapshot.issues,
        selection: get().selection.filter((id) => model.nodes[id]),
        undoStack: [],
        redoStack: [],
        renderVersion: get().renderVersion + 1,
      });
      get().ensureIcons();
    },

    showWelcome() {
      set({ screen: "welcome", snapshot: null, files: {}, model: emptyModel, openFiles: null });
    },

    async switchProject(root) {
      let target = root;
      if (!target) {
        const picked = await api().chooseFolder();
        // A folder without lamsa.config.json: the welcome screen explains how to set it up.
        if (picked.uninitialised) {
          await get().goHome();
          return false;
        }
        target = picked.root;
      }
      if (!target) return false;
      const snapshot = await api().openProject(target);
      // The project opened in a window of its own; this one keeps its project.
      if (!snapshot) return false;
      set({ selection: [], hover: null, preview: null, picker: false, contextMenu: null, flash: {}, agentCursor: null });
      reportSave(undefined);
      get().loadSnapshot(snapshot);
      return true;
    },

    async goHome() {
      await api().closeProject();
      set({ selection: [], hover: null, preview: null, picker: false, contextMenu: null, flash: {}, agentCursor: null, undoStack: [], redoStack: [] });
      reportSave(undefined);
      get().showWelcome();
    },

    async commit(label, changes) {
      if (changes.length === 0) return;
      const { files } = get();
      const inverse = inverseOf(files, changes);
      const next = applyToFiles(files, changes);
      set((s) => ({
        files: next,
        model: buildModel(next, s.openFiles),
        undoStack: [...s.undoStack.slice(-199), { label, changes, inverse }],
        redoStack: [],
      }));
      get().ensureIcons();
      const errorKey = (issue: ProjectIssue) => `${issue.file}|${issue.nodeId}|${issue.code}|${issue.message}`;
      const before = new Set(get().issues.filter((i) => i.severity === "error").map(errorKey));
      await send(changes);
      const added = get().issues.filter((i) => i.severity === "error" && !before.has(errorKey(i)));
      if (added.length) {
        get().toast({
          tone: "warn",
          title: `${label} left ${added.length} validation error${added.length === 1 ? "" : "s"}`,
          message: added[0]!.message,
          action: { label: "Undo", run: () => get().undo() },
        });
      }
    },

    undo() {
      const entry = get().undoStack.at(-1);
      if (!entry) return;
      const next = applyToFiles(get().files, entry.inverse);
      set((s) => ({
        files: next,
        model: buildModel(next, s.openFiles),
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, entry],
      }));
      void send(entry.inverse);
    },

    redo() {
      const entry = get().redoStack.at(-1);
      if (!entry) return;
      const next = applyToFiles(get().files, entry.changes);
      set((s) => ({
        files: next,
        model: buildModel(next, s.openFiles),
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, entry],
      }));
      void send(entry.changes);
    },

    applyExternal(change) {
      const files = { ...get().files, [change.path]: withUnchangedNodesKept({ previous: get().files[change.path], next: change.file, changedIds: change.changedIds }) };
      if (change.file.error === "deleted") delete files[change.path];
      const openFiles = change.open ?? get().openFiles;
      const model = buildModel(files, openFiles);
      const touched = new Set(change.changedIds);
      const cssChanged = (get().files[change.path]?.css ?? "") !== (change.file.css ?? "");
      const keep = (entry: HistoryEntry) => !entry.changes.some((c) => (isCssChange(c) ? cssChanged && c.file === change.path : touched.has(c.id)));
      const highlights = changeHighlights({ model, previous: get().model, changedIds: change.changedIds });
      const until = Date.now() + HIGHLIGHT_MS;
      const flash = { ...get().flash };
      for (const id of highlights) flash[id] = until;
      set((s) => ({
        files,
        model,
        openFiles,
        issues: change.issues,
        selection: s.selection.filter((id) => model.nodes[id]),
        preview: s.preview && s.preview.some((id) => model.nodes[id]) ? s.preview.filter((id) => model.nodes[id]) : null,
        undoStack: s.undoStack.filter(keep),
        redoStack: s.redoStack.filter(keep),
        flash,
      }));
      get().ensureIcons();
      if (change.file.error && change.file.error !== "deleted") {
        get().toast({
          tone: "danger",
          title: `${change.path} is invalid`,
          message: `${change.file.error}. Showing the last valid version; the file was not changed.`,
        });
      } else if (change.changedIds.length > 0) {
        get().toast({
          tone: "neutral",
          title: `${change.path.split("/").pop()} changed on disk`,
          message: `${change.changedIds.length} node${change.changedIds.length === 1 ? "" : "s"} updated live`,
          ...(highlights.length ? { action: { label: "Show changes", run: () => void import("./viewport").then(({ fitTo }) => fitTo(highlights)) } } : {}),
        });
      }
      if (highlights.length) {
        const name = change.agent ?? (lastAgent && Date.now() - lastAgent.at < AGENT_NAME_FRESH_MS ? lastAgent.name : "Agent");
        set({ agentCursor: { name, kind: "write", ids: highlights, at: Date.now() } });
      }
      clearTimeout(flashTimer);
      const expire = () => {
        const now = Date.now();
        const current = get().flash;
        const live = Object.entries(current).filter(([, end]) => end > now);
        if (live.length !== Object.keys(current).length) set({ flash: Object.fromEntries(live) });
        if (live.length) flashTimer = setTimeout(expire, Math.min(...live.map(([, end]) => end)) - now + 20);
      };
      flashTimer = setTimeout(expire, HIGHLIGHT_MS + 20);
    },

    noteAgentActivity(activity) {
      lastAgent = { name: activity.agent, at: Date.now() };
      const { model } = get();
      const shown = new Set(model.roots);
      let ids = activity.ids.filter((id) => model.nodes[id] && shown.has(rootOf(model, id)));
      if (!ids.length && activity.file) ids = model.roots.filter((id) => model.fileOf.get(id) === activity.file).slice(0, 1);
      // Writes whose layers haven't arrived yet keep the cursor where it is; the file change moves it.
      if (!ids.length) {
        const cursor = get().agentCursor;
        if (cursor && cursor.name !== activity.agent) set({ agentCursor: { ...cursor, name: activity.agent } });
        return;
      }
      set({ agentCursor: { name: activity.agent, kind: activity.kind, ids, at: Date.now() } });
    },

    select(ids) {
      const unique = [...new Set(ids)];
      set({ selection: unique, contextMenu: null });
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        const first = unique[0];
        void api().setSelection(unique, first ? get().model.fileOf.get(first) : undefined);
      }, 120);
    },

    setHover: (hover) => set({ hover }),
    setTool: (tool) => set({ tool, picker: tool === "component" }),
    setViewport: (viewport) => set({ viewport }),
    togglePanel: (panel, value) => set((s) => ({ panels: { ...s.panels, [panel]: value ?? !s.panels[panel] } })),
    toggleSidebars: () =>
      set((s) => {
        const open = !(s.panels.left || s.panels.right);
        return { panels: { ...s.panels, left: open, right: open } };
      }),
    showPanel: (panel) => {
      const state = get();
      const { layout, panels } = state;
      const dock = dockOf(layout, panel);
      if (!dock) return;
      const next = activatePanel(layout, panel);
      if (next !== layout) writeLayout(next);
      const previewReturn = panel === "preview" && !isPreviewShown(state) ? { dock, shown: panels[dock], active: layout[dock].active } : state.previewReturn;
      set({ layout: next, panels: { ...panels, [dock]: true }, previewReturn });
    },
    movePanel: ({ panel, dock, index }) => {
      const layout = movePanel({ layout: get().layout, panel, dock, index });
      writeLayout(layout);
      set((s) => ({ layout, panels: { ...s.panels, [dock]: true } }));
    },
    setDockSize: ({ dock, size }) => {
      const layout = resizeDock({ layout: get().layout, dock, size });
      writeLayout(layout);
      set({ layout });
    },
    resetLayout: () => {
      writeLayout(null);
      set({ layout: DEFAULT_LAYOUT, panels: initialShown(DEFAULT_LAYOUT), previewReturn: null, previewFullscreen: false });
    },
    setCanvasMode: (canvasMode) => set({ canvasMode }),
    setPreviewProp: (componentId, prop, value) =>
      set((s) => {
        const props = { ...s.previewProps[componentId] };
        if (value === undefined) delete props[prop];
        else props[prop] = value;
        const previewProps = { ...s.previewProps };
        if (Object.keys(props).length) previewProps[componentId] = props;
        else delete previewProps[componentId];
        return { previewProps };
      }),

    toast(toast) {
      const id = ++toastId;
      set((s) => ({ toasts: withRoomForOneMore(s.toasts).concat({ ...toast, id }) }));
      if (!toast.sticky) setTimeout(() => get().dismissToast(id), toast.tone === "danger" ? 9000 : 4500);
      return id;
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setEditingText: (editingText) => set({ editingText }),
    setPicker: (picker) => set({ picker, tool: picker ? "component" : get().tool === "component" ? "select" : get().tool }),
    setContextMenu: (contextMenu) => set({ contextMenu }),
    openPreview: (ids) => {
      get().showPanel("preview");
      set({ preview: ids.length ? ids : null });
    },
    closePreview: () => {
      const state = get();
      const { layout, panels, previewReturn } = state;
      const dock = dockOf(layout, "preview");
      if (!dock || !isPreviewShown(state)) return;
      const { tabs } = layout[dock];
      const back = previewReturn?.dock === dock ? previewReturn : null;
      const neighbour = tabs.filter((tab) => tab !== "preview")[Math.max(0, tabs.indexOf("preview") - 1)] ?? null;
      const restore = back ? (back.active && back.active !== "preview" && tabs.includes(back.active) ? back.active : null) : neighbour;
      const shown = back ? back.shown : restore !== null;
      const next = restore ? activatePanel(layout, restore) : layout;
      if (next !== layout) writeLayout(next);
      set({ layout: next, panels: { ...panels, [dock]: shown }, previewReturn: null, previewFullscreen: false });
    },
    setPreviewFullscreen: (previewFullscreen) => set({ previewFullscreen }),
    setHelp: (help) => set({ help }),

    async addFiles(paths) {
      if (!paths.length) return;
      const result = await api().addFiles(paths);
      const files = { ...get().files };
      for (const file of result.files) files[file.path] = file;
      const model = buildModel(files, result.open);
      set({ files, openFiles: result.open, model, issues: result.issues, renderVersion: get().renderVersion + 1 });
      get().ensureIcons();
      if (result.errors.length) get().toast({ tone: "warn", title: `Couldn't add ${result.errors.length === 1 ? "a file" : `${result.errors.length} files`}`, message: result.errors.join("\n") });
    },

    async setOpenFiles(paths) {
      const openFiles = await api().setOpenFiles(paths);
      set({ openFiles, model: buildModel(get().files, openFiles) });
    },

    async closeFile(path) {
      const openFiles = await api().closeFile(path);
      const model = buildModel(get().files, openFiles);
      set((s) => ({
        openFiles,
        model,
        selection: s.selection.filter((id) => model.fileOf.get(id) !== path),
        preview: s.preview && s.preview.some((id) => model.fileOf.get(id) !== path) ? s.preview.filter((id) => model.fileOf.get(id) !== path) : null,
      }));
    },

    ensureIcons() {
      const missing = iconNamesIn(get().model.nodes).filter((name) => !(name in get().icons));
      if (missing.length === 0) return;
      void api()
        .icons(missing)
        .then((icons) => {
          const filled = { ...icons };
          for (const name of missing) filled[name] ??= "";
          set((s) => ({ icons: { ...s.icons, ...filled }, renderVersion: s.renderVersion + 1 }));
        });
    },
  };
});

/** Where new top-level frames go when nothing selected says otherwise: the first open file. */
export function firstOpenFile(state: Pick<EditorState, "openFiles" | "files">): string | undefined {
  return state.openFiles?.[0] ?? Object.keys(state.files)[0];
}

/** Whether the Preview tab is the open tab of a dock that's on screen. */
/** Whether the app's CSS gives any token a dark value; without one, light and dark draw the same. */
export const hasDarkTokens = (tokens: TokenSet | undefined) => Object.values(tokens?.tokens ?? {}).some((token) => token.values.dark !== undefined);

export function isPreviewShown(state: Pick<EditorState, "layout" | "panels">): boolean {
  const dock = dockOf(state.layout, "preview");
  return dock !== null && state.panels[dock] && state.layout[dock].tabs.length > 0 && state.layout[dock].active === "preview";
}
