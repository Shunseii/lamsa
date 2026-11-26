import { useShallow } from "zustand/react/shallow";
import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Canvas } from "./canvas/Canvas";
import { installShortcuts } from "./lib/commands";
import { installComments } from "./lib/comments";
import { installUpdateToasts } from "./lib/updates";
import { api, useEditor } from "./lib/store";
import { fitTo } from "./lib/viewport";
import { baseId } from "./lib/model";
import type { OpenRequest } from "../../shared/api";
import { ComponentPicker } from "./panels/ComponentPicker";
import { ContextMenu } from "./panels/ContextMenu";
import { localFontCss } from "./canvas/FrameView";
import { Docks } from "./panels/Dock";
import { LogoMark } from "./panels/LogoMark";
import { Presence } from "./panels/Panel";
import { DockSizeStyle } from "./panels/PanelResize";
import { OpenFilesDialog } from "./panels/OpenFilesDialog";
import { ShortcutsHelp } from "./panels/ShortcutsHelp";
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
    return () => {
      for (const element of added) element.remove();
    };
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
  const { screen, hasLeft, hasRight, hasCentre, picker, files, help, choosingFiles } = useEditor(
    useShallow((s) => ({
      screen: s.screen,
      hasLeft: s.panels.left && s.layout.left.tabs.length > 0,
      hasRight: s.panels.right && s.layout.right.tabs.length > 0,
      hasCentre: s.panels.centre && s.layout.centre.tabs.length > 0,
      picker: s.picker,
      files: s.files,
      help: s.help,
      choosingFiles: s.openFiles === null,
    })),
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
      api().onAgentActivity((activity) => useEditor.getState().noteAgentActivity(activity)),
      api().onOpenRequest((request) => void handleOpenRequest(request)),
      api().onProjectReloaded((snapshot) => {
        useEditor.getState().loadSnapshot(snapshot);
        useEditor.getState().toast({ tone: "neutral", title: "Tokens or config changed", message: "Reloaded from disk" });
      }),
      installShortcuts(),
      installComments(),
      installUpdateToasts(),
    ];
    return () => {
      for (const off of offs) off();
    };
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
    <div className={cn("editor", { "has-left": hasLeft, "has-right": hasRight, "has-centre": hasCentre })}>
      <DockSizeStyle />
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
      <Docks />
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
