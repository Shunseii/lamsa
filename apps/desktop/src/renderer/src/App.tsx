import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { Canvas } from "./canvas/Canvas";
import { installShortcuts } from "./lib/commands";
import { api, useEditor } from "./lib/store";
import { fitTo } from "./lib/viewport";
import { ComponentPicker } from "./panels/ComponentPicker";
import { ContextMenu } from "./panels/ContextMenu";
import { LayersPanel } from "./panels/LayersPanel";
import { LogoMark } from "./panels/LogoMark";
import { PropertiesPanel } from "./panels/PropertiesPanel";
import { StatusBar } from "./panels/StatusBar";
import { TerminalPanel } from "./panels/TerminalPanel";
import { Toasts } from "./panels/Toasts";
import { Toolbar } from "./panels/Toolbar";
import { Welcome } from "./panels/Welcome";

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
      style.textContent = snapshot.fontCss.replace(/url\("(?!https?:|data:)([^"]+)"\)/g, (_m, path: string) => `url("lamsa-asset://local/${path}")`);
      document.head.appendChild(style);
      added.push(style);
    }
    void document.fonts.ready.then(() => useEditor.setState((s) => ({ renderVersion: s.renderVersion + 1 })));
    return () => added.forEach((element) => element.remove());
  }, [snapshot]);
}

function handleOpenRequest(request: { file?: string; select?: string }) {
  const state = useEditor.getState();
  const { model } = state;
  if (request.select && model.nodes[request.select.split("/")[0]!]) {
    state.select([request.select.split("/")[0]!]);
  } else if (request.file) {
    state.select(model.roots.filter((id) => model.fileOf.get(id) === request.file));
  }
  setTimeout(() => fitTo(state.selection.length || request.select || request.file ? "selection" : "all"), 80);
}

export function App() {
  const { screen, panels, picker, files } = useEditor();
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
      api().onOpenRequest((request) => handleOpenRequest(request)),
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
    <div className={`editor ${panels.layers ? "has-left" : ""} ${panels.properties ? "has-right" : ""} ${panels.terminal ? "has-terminal" : ""}`}>
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
      {panels.layers && <LayersPanel />}
      {panels.properties && <PropertiesPanel />}
      {panels.terminal && <TerminalPanel />}
      <StatusBar />
      <ContextMenu />
      {picker && <ComponentPicker />}
      <Toasts />
    </div>
  );
}

