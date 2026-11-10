import {
  ChevronDown,
  Component,
  Frame,
  Hand,
  Image as ImageIcon,
  ImagePlay,
  Moon,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Square,
  SquareTerminal,
  Sun,
  Type,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { insertNodes, newId } from "../lib/edits";
import { api, useEditor, type Tool } from "../lib/store";
import { fitTo, zoomBy, zoomTo } from "../lib/viewport";
import { LogoMark } from "./LogoMark";

export function Tip({ label, keys, hint, children }: { label: string; keys?: string; hint?: [string, string]; children: ReactNode }) {
  return (
    <span className="tip-wrap">
      {children}
      <span className="tip" role="tooltip">
        <span className="tip-row">
          {label}
          {keys && <kbd>{keys}</kbd>}
        </span>
        {hint && (
          <span className="tip-row tip-hint">
            {hint[0]}
            <kbd>{hint[1]}</kbd>
          </span>
        )}
      </span>
    </span>
  );
}

const TOOLS: { tool: Tool; icon: ReactNode; label: string; keys: string }[] = [
  { tool: "select", icon: <MousePointer2 size={16} />, label: "Select", keys: "V" },
  { tool: "hand", icon: <Hand size={16} />, label: "Hand", keys: "H" },
  { tool: "frame", icon: <Frame size={16} />, label: "Frame", keys: "F" },
  { tool: "text", icon: <Type size={16} />, label: "Text", keys: "T" },
  { tool: "rect", icon: <Square size={16} />, label: "Rectangle", keys: "R" },
  { tool: "image", icon: <ImageIcon size={16} />, label: "Image", keys: "I" },
  { tool: "component", icon: <Component size={16} />, label: "Component", keys: "C" },
];

export async function insertImage() {
  const picked = await api().importImage();
  if (!picked) return;
  const { model, selection, commit, select, files } = useEditor.getState();
  const id = newId(model);
  const parent = selection[0] && model.nodes[selection[0]]?.type === "frame" ? selection[0] : undefined;
  const node = { type: "image" as const, src: picked.src, alt: "", style: { width: 240, height: 160, "object-fit": "cover" } };
  const file = model.fileOf.get(selection[0] ?? "") ?? Object.keys(files)[0] ?? "designs/main.lamsa.json";
  const changes = parent
    ? insertNodes({ model, entries: [{ root: { id, node } }], parentId: parent })
    : insertNodes({ model, entries: [{ root: { id, node: { ...node, name: "Image", x: 0, y: 0 } } }], file });
  await commit("Insert image", changes);
  select([id]);
}

export function Toolbar() {
  const { snapshot, tool, setTool, panels, togglePanel, canvasMode, setCanvasMode, viewport, selection, model, toast } = useEditor();
  const [zoomOpen, setZoomOpen] = useState(false);
  const [rendering, setRendering] = useState(false);
  const file = useEditor((s) => (s.selection[0] ? s.model.fileOf.get(s.selection[0]) : Object.keys(s.files)[0]));

  const pickTool = (next: Tool) => {
    if (next === "image") {
      void insertImage();
      return;
    }
    setTool(next);
  };

  const render = async () => {
    const roots = selection.length
      ? [...new Set(selection.map((id) => {
          let current = id;
          while (model.nodes[current]?.parentId) current = model.nodes[current]!.parentId!;
          return current;
        }))]
      : model.roots;
    if (roots.length === 0) return;
    setRendering(true);
    try {
      const results = await api().render(roots, canvasMode);
      const first = results[0];
      toast({
        tone: "ok",
        title: `Rendered ${results.length} frame${results.length === 1 ? "" : "s"}`,
        message: first ? first.path.replace(`${snapshot?.root}/`, "") : undefined,
        action: first ? { label: "Show", run: () => void api().revealPath(first.path) } : undefined,
      });
    } catch (error) {
      toast({ tone: "danger", title: "Render failed", message: (error as Error).message });
    } finally {
      setRendering(false);
    }
  };

  return (
    <>
      <div className="bar bar-project">
        <LogoMark />
        <span className="project-name">{snapshot?.name}</span>
        <span className="crumb-sep">›</span>
        <span className="crumb mono">{file ?? "no files"}</span>
      </div>

      <div className="bar bar-tools">
        {TOOLS.map((t) => (
          <Tip key={t.tool} label={t.label} keys={t.keys}>
            <button className={`icon-btn ${tool === t.tool ? "is-active" : ""}`} onClick={() => pickTool(t.tool)} aria-label={t.label}>
              {t.icon}
            </button>
          </Tip>
        ))}
      </div>

      <div className="bar bar-view">
        <div className="segmented">
          <button className={canvasMode === "light" ? "is-on" : ""} onClick={() => setCanvasMode("light")}>
            <Sun size={14} /> Light
          </button>
          <button className={canvasMode === "dark" ? "is-on" : ""} onClick={() => setCanvasMode("dark")}>
            <Moon size={14} /> Dark
          </button>
        </div>
        <div className="zoom">
          <button className="ghost-btn" onClick={() => setZoomOpen(!zoomOpen)}>
            {Math.round(viewport.zoom * 100)}% <ChevronDown size={14} />
          </button>
          {zoomOpen && (
            <div className="menu zoom-menu" onMouseLeave={() => setZoomOpen(false)}>
              {[
                ["Zoom in", "⌘ +", () => zoomBy(1.25)],
                ["Zoom out", "⌘ −", () => zoomBy(0.8)],
                ["Zoom to fit all files", "⇧ 1", () => fitTo("all")],
                ["Zoom to selection", "⇧ 2", () => fitTo("selection")],
              ].map(([label, keys, run]) => (
                <button key={label as string} className="menu-item" onClick={() => { (run as () => void)(); setZoomOpen(false); }}>
                  {label as string}
                  <kbd>{keys as string}</kbd>
                </button>
              ))}
              <div className="menu-sep" />
              {[0.5, 1, 2].map((z) => (
                <button key={z} className="menu-item" onClick={() => { zoomTo(z); setZoomOpen(false); }}>
                  {z * 100}%{z === 1 && <kbd>⇧ 0</kbd>}
                </button>
              ))}
            </div>
          )}
        </div>
        <Tip label={panels.layers ? "Hide layers" : "Show layers"} keys="⌘[" hint={["Both sidebars", "⌘\\"]}>
          <button className={`icon-btn ${panels.layers ? "is-active" : ""}`} onClick={() => togglePanel("layers")} aria-label="Toggle layers">
            <PanelLeft size={16} />
          </button>
        </Tip>
        <Tip label={panels.terminal ? "Hide agent terminal" : "Show agent terminal"} keys="⌘J">
          <button className={`icon-btn ${panels.terminal ? "is-active" : ""}`} onClick={() => togglePanel("terminal")} aria-label="Toggle terminal">
            <SquareTerminal size={16} />
          </button>
        </Tip>
        <Tip label={panels.properties ? "Hide properties" : "Show properties"} keys="⌘]" hint={["Both sidebars", "⌘\\"]}>
          <button className={`icon-btn ${panels.properties ? "is-active" : ""}`} onClick={() => togglePanel("properties")} aria-label="Toggle properties">
            <PanelRight size={16} />
          </button>
        </Tip>
        <button className="btn" onClick={() => void render()} disabled={rendering}>
          <ImagePlay size={14} /> {rendering ? "Rendering…" : "Render"}
        </button>
      </div>
    </>
  );
}
