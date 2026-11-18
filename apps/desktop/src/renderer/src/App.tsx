import { useShallow } from "zustand/react/shallow";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Canvas } from "./canvas/Canvas";
import { installShortcuts } from "./lib/commands";
import { api, useEditor } from "./lib/store";
import { fitTo } from "./lib/viewport";
import { baseId } from "./lib/model";
import type { OpenRequest } from "../../shared/api";
import { ComponentPicker } from "./panels/ComponentPicker";
import { ContextMenu } from "./panels/ContextMenu";
import { localFontCss } from "./canvas/FrameView";
import { LayersPanel } from "./panels/LayersPanel";
import { LogoMark } from "./panels/LogoMark";
import { PreviewPanel } from "./panels/PreviewPanel";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { OpenFilesDialog } from "./panels/OpenFilesDialog";
import { ShortcutsHelp } from "./panels/ShortcutsHelp";
import { StatusBar } from "./panels/StatusBar";
import { TerminalPanel } from "./panels/TerminalPanel";
import { Toasts } from "./panels/Toasts";
import { Toolbar } from "./panels/Toolbar";
import { Welcome } from "./panels/Welcome";
import { cn } from "./lib/cn";

function useFonts() {
  const snapshot = useEditor((s) => s.snapshot);
  useEffect(() => {
    if (!snapshot) return;
    const added: HTMLElement[] = [];
    for (const href of snapshot.fontLinks) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
      added.push(link);
    }
    if (snapshot.fontCss) {
      const style = document.createElement("style");
      style.textContent = localFontCss(snapshot.fontCss);
      document.head.appendChild(style);
      added.push(style);
    }
    void document.fonts.ready.then(() => useEditor.setState((s) => ({ renderVersion: s.renderVersion + 1 })));
    return () => added.forEach((element) => element.remove());
  }, [snapshot]);
}

async function handleOpenRequest(request: OpenRequest) {
  const before = useEditor.getState();
  const toSelect = [...new Set((request.select ?? []).map(baseId))].filter((id) => before.model.nodes[id]);
  // A file asked for by name, or holding a node to select, opens first if it isn't already.
  const wanted = [...new Set([request.file, ...toSelect.map((id) => before.model.fileOf.get(id))])].filter(
    (path): path is string => !!path && !(before.openFiles ?? []).includes(path),
  );
  if (wanted.length) await before.addFiles(wanted);
  const state = useEditor.getState();
  const { model } = state;
  const selection = toSelect.length ? toSelect : request.file ? model.roots.filter((id) => model.fileOf.get(id) === request.file) : [];
  if (selection.length) state.select(selection);
  setTimeout(() => fitTo(selection.length ? "selection" : "all"), 80);
}

export function App() {
  const { screen, panels, picker, files, help, choosingFiles } = useEditor(
    useShallow((s) => ({ screen: s.screen, panels: s.panels, picker: s.picker, files: s.files, help: s.help, choosingFiles: s.openFiles === null })),
  );
  useFonts();

  useEffect(() => {
    void api()
      .current()
      .then((snapshot) => {
        if (snapshot) {
          useEditor.getState().loadSnapshot(snapshot);
          setTimeout(() => fitTo("all"), 120);
        } else useEditor.getState().showWelcome();
      });
    const offs = [
      api().onExternalChange((change) => useEditor.getState().applyExternal(change)),
      api().onOpenRequest((request) => void handleOpenRequest(request)),
      api().onProjectReloaded((snapshot) => {
        useEditor.getState().loadSnapshot(snapshot);
        useEditor.getState().toast({ tone: "neutral", title: "Tokens or config changed", message: "Reloaded from disk" });
      }),
      installShortcuts(),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  if (screen === "loading") {
    return (
      <div className="loading">
        <LogoMark size={32} />
        <span className="muted">Indexing design files…</span>
      </div>
    );
  }
  if (screen === "welcome") return <Welcome />;

  const invalid = Object.values(files).filter((f) => f.error && f.error !== "deleted");

  return (
    <div className={cn("editor", { "has-left": panels.layers, "has-right": panels.properties, "has-terminal": panels.terminal })}>
      <Canvas />
      <Toolbar />
      {invalid.length > 0 && (
        <div className="banner" data-testid="invalid-banner">
          <TriangleAlert size={16} />
          <div>
            <div className="strong">
              {invalid.map((f) => f.path).join(", ")} failed validation · showing the last valid version
            </div>
            <div className="small">{invalid[0]!.error}. Fix the file or run <code>lamsa fmt --fix</code>; edits to it are paused.</div>
          </div>
        </div>
      )}
      <Presence open={panels.layers}>
        <LayersPanel />
      </Presence>
      <Presence open={panels.properties}>
        <PropertiesPanel />
      </Presence>
      <Presence open={panels.terminal}>
        <TerminalPanel />
      </Presence>
      <PreviewPanel />
      <StatusBar />
      <ContextMenu />
      {picker && <ComponentPicker />}
      <Toasts />
      <Presence open={help}>
        <ShortcutsHelp />
      </Presence>
      <Presence open={choosingFiles}>
        <OpenFilesDialog />
      </Presence>
    </div>
  );
}

/** How long a closing panel or dialog stays mounted so its exit transition (styles.css) can play. */
const PANEL_EXIT_MS = 140;

/** Keeps a panel or dialog mounted for its exit transition; `data-state` drives the CSS. */
function Presence({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), PANEL_EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !mounted) return null;
  return (
    <div className="presence" data-state={open ? "open" : "closed"}>
      {children}
    </div>
  );
}
