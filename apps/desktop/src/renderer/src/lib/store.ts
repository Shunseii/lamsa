import type { TokenMode } from "@lamsa/schema";
import { create } from "zustand";
import type {
  ExternalChange,
  FileState,
  LamsaApi,
  NodeChange,
  ProjectIssue,
  ProjectSnapshot,
} from "../../../shared/api";
import { buildModel, iconNamesIn, type Model } from "./model";

declare global {
  interface Window {
    lamsa: LamsaApi;
  }
}

export const api = (): LamsaApi => window.lamsa;

export type Tool = "select" | "hand" | "frame" | "rect" | "text" | "image" | "component";

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
}

interface HistoryEntry {
  label: string;
  changes: NodeChange[];
  inverse: NodeChange[];
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
  panels: { layers: boolean; properties: boolean; terminal: boolean };
  leftTab: "layers" | "files" | "components";
  canvasMode: TokenMode;
  /** Editor-only prop values for previewing a main component's variants; never saved. */
  previewProps: Record<string, Record<string, string | boolean>>;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  pending: number;
  lastError?: string;
  toasts: Toast[];
  flash: Record<string, number>;
  icons: Record<string, string>;
  editingText: string | null;
  picker: boolean;
  contextMenu: { x: number; y: number } | null;
  renderVersion: number;
}

interface EditorActions {
  loadSnapshot(snapshot: ProjectSnapshot): void;
  showWelcome(): void;
  commit(label: string, changes: NodeChange[]): Promise<void>;
  undo(): void;
  redo(): void;
  applyExternal(change: ExternalChange): void;
  select(ids: string[]): void;
  setHover(id: string | null): void;
  setTool(tool: Tool): void;
  setViewport(viewport: Viewport): void;
  togglePanel(panel: keyof EditorState["panels"], value?: boolean): void;
  toggleSidebars(): void;
  setLeftTab(tab: EditorState["leftTab"]): void;
  setCanvasMode(mode: TokenMode): void;
  setPreviewProp(componentId: string, prop: string, value: string | boolean | undefined): void;
  toast(toast: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  setEditingText(id: string | null): void;
  setPicker(open: boolean): void;
  setContextMenu(menu: { x: number; y: number } | null): void;
  ensureIcons(): void;
}

let toastId = 0;
let selectionTimer: ReturnType<typeof setTimeout> | undefined;

function applyToFiles(files: Record<string, FileState>, changes: NodeChange[]): Record<string, FileState> {
  const next = { ...files };
  for (const change of changes) {
    const file = next[change.file] ?? { path: change.file, nodes: {} };
    const nodes = { ...file.nodes };
    if (change.node === null) delete nodes[change.id];
    else nodes[change.id] = change.node;
    next[change.file] = { ...file, nodes };
  }
  return next;
}

function inverseOf(files: Record<string, FileState>, changes: NodeChange[]): NodeChange[] {
  const seen = new Set<string>();
  const inverse: NodeChange[] = [];
  for (const change of changes) {
    const key = `${change.file}\u0000${change.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    inverse.push({ file: change.file, id: change.id, node: files[change.file]?.nodes[change.id] ?? null });
  }
  return inverse.reverse();
}

const emptyModel = buildModel({});

export const useEditor = create<EditorState & EditorActions>((set, get) => {
  const send = async (changes: NodeChange[]) => {
    set((s) => ({ pending: s.pending + 1 }));
    try {
      const result = await api().applyChanges(changes);
      set({ issues: result.issues, lastError: result.ok ? undefined : result.error });
      if (!result.ok) get().toast({ tone: "danger", title: "Couldn't save", message: result.error });
    } finally {
      set((s) => ({ pending: s.pending - 1 }));
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
    panels: { layers: true, properties: true, terminal: false },
    leftTab: "layers",
    canvasMode: "light",
    previewProps: {},
    undoStack: [],
    redoStack: [],
    pending: 0,
    toasts: [],
    flash: {},
    icons: {},
    editingText: null,
    picker: false,
    contextMenu: null,
    renderVersion: 0,

    loadSnapshot(snapshot) {
      const model = buildModel(snapshot.files);
      set({
        screen: "editor",
        snapshot,
        files: snapshot.files,
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
      set({ screen: "welcome", snapshot: null, files: {}, model: emptyModel });
    },

    async commit(label, changes) {
      if (changes.length === 0) return;
      const { files } = get();
      const inverse = inverseOf(files, changes);
      const next = applyToFiles(files, changes);
      set((s) => ({
        files: next,
        model: buildModel(next),
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
        model: buildModel(next),
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
        model: buildModel(next),
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, entry],
      }));
      void send(entry.changes);
    },

    applyExternal(change) {
      const files = { ...get().files, [change.path]: change.file };
      if (change.file.error === "deleted") delete files[change.path];
      const model = buildModel(files);
      const touched = new Set(change.changedIds);
      const keep = (entry: HistoryEntry) => !entry.changes.some((c) => touched.has(c.id));
      const now = Date.now();
      const flash = { ...get().flash };
      for (const id of change.changedIds) if (model.nodes[id]) flash[id] = now + 1600;
      set((s) => ({
        files,
        model,
        issues: change.issues,
        selection: s.selection.filter((id) => model.nodes[id]),
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
        });
      }
      setTimeout(() => {
        const current = { ...get().flash };
        for (const [id, until] of Object.entries(current)) if (until <= Date.now()) delete current[id];
        set({ flash: current });
      }, 1700);
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
        const open = !(s.panels.layers || s.panels.properties);
        return { panels: { ...s.panels, layers: open, properties: open } };
      }),
    setLeftTab: (leftTab) => set({ leftTab, panels: { ...get().panels, layers: true } }),
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
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...toast, id }] }));
      setTimeout(() => get().dismissToast(id), toast.tone === "danger" ? 9000 : 4500);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    setEditingText: (editingText) => set({ editingText }),
    setPicker: (picker) => set({ picker, tool: picker ? "component" : get().tool === "component" ? "select" : get().tool }),
    setContextMenu: (contextMenu) => set({ contextMenu }),

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
