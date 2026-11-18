import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  Clapperboard,
  Component,
  Frame,
  Hand,
  Image as ImageIcon,
  ImagePlay,
  Keyboard,
  Moon,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Square,
  SquareTerminal,
  Sun,
  Type,
  Smile,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode } from "react";
import { insertNodes, newId } from "../lib/edits";
import { api, firstOpenFile, useEditor, type Tool } from "../lib/store";
import { fitTo, zoomBy, zoomTo } from "../lib/viewport";
import { shortcut } from "../lib/keys";
import { LogoMark } from "./LogoMark";
import { ProjectMenu } from "./ProjectMenu";
import { IconPicker, useIconNames } from "./IconField";
import { Popover } from "./Popover";
import { cn } from "../lib/cn";
import { runCommand } from "../lib/commands";

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
  { tool: "icon", icon: <Smile size={16} />, label: "Icon", keys: "" },
  { tool: "component", icon: <Component size={16} />, label: "Component", keys: "C" },
];

export async function insertImage() {
  const picked = await api().importImage();
  if (!picked) return;
  const { model, selection, commit, select, files } = useEditor.getState();
  const id = newId(model);
  const parent = selection[0] && model.nodes[selection[0]]?.type === "frame" ? selection[0] : undefined;
  const node = { type: "image" as const, src: picked.src, alt: "", style: { width: 240, height: 160, "object-fit": "cover" } };
  const file = model.fileOf.get(selection[0] ?? "") ?? firstOpenFile(useEditor.getState()) ?? "designs/main.lamsa.json";
  const changes = parent
    ? insertNodes({ model, entries: [{ root: { id, node } }], parentId: parent })
    : insertNodes({ model, entries: [{ root: { id, node: { ...node, name: "Image", x: 0, y: 0 } } }], file });
  await commit("Insert image", changes);
  select([id]);
}

/** Inserts a lucide icon into the selected frame (or beside the selected layer), else at the top level. */
export async function insertIcon(name: string) {
  const { model, selection, commit, select, files } = useEditor.getState();
  const id = newId(model);
  const target = selection[0] ? model.nodes[selection[0]] : undefined;
  const parent = target?.type === "frame" ? selection[0] : target?.parentId;
  const node = { type: "icon" as const, set: "lucide" as const, icon: name, style: { width: 24, height: 24 } };
  const file = model.fileOf.get(selection[0] ?? "") ?? firstOpenFile(useEditor.getState()) ?? "designs/main.lamsa.json";
  const changes = parent
    ? insertNodes({ model, entries: [{ root: { id, node } }], parentId: parent })
    : insertNodes({ model, entries: [{ root: { id, node: { ...node, name: name, x: 0, y: 0 } } }], file });
  await commit("Insert icon", changes);
  select([id]);
}

export function Toolbar() {
  const { snapshot, tool, setTool, panels, togglePanel, canvasMode, setCanvasMode, viewport, selection, model, toast, previewOpen, closePreview, help, setHelp } = useEditor(
    useShallow((s) => ({ snapshot: s.snapshot, tool: s.tool, setTool: s.setTool, panels: s.panels, togglePanel: s.togglePanel, canvasMode: s.canvasMode, setCanvasMode: s.setCanvasMode, viewport: s.viewport, selection: s.selection, model: s.model, toast: s.toast, previewOpen: s.preview !== null, closePreview: s.closePreview, help: s.help, setHelp: s.setHelp })),
  );
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const closeZoom = useCallback(() => setZoomOpen(false), []);
  const [rendering, setRendering] = useState(false);

  const [iconOpen, setIconOpen] = useState(false);
  const iconButton = useRef<HTMLButtonElement>(null);
  const closeIcons = useCallback(() => setIconOpen(false), []);
  const iconNames = useIconNames();

  const pickTool = (next: Tool) => {
    if (next === "icon") {
      setIconOpen(!iconOpen);
      return;
    }
    if (next === "image") {
      void insertImage();
      return;
    }
    setTool(next === "component" && tool === "component" ? "select" : next);
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
    <div className="topbar">
      <div className="bar bar-project">
        <LogoMark />
        <ProjectMenu />
        <span className="bar-divider" />
        <Tip label={panels.layers ? "Hide layers" : "Show layers"} keys={shortcut("mod+[")} hint={["Focus mode", shortcut("mod+\\")]}>
          <button className={cn("icon-btn", { "is-active": panels.layers })} onClick={() => togglePanel("layers")} aria-label="Toggle layers">
            <PanelLeft size={16} />
          </button>
        </Tip>
      </div>

      <div className="bar bar-tools">
        {TOOLS.map((t) => (
          <Tip key={t.tool} label={t.label} keys={t.keys}>
            <button
              ref={t.tool === "icon" ? iconButton : undefined}
              className={cn("icon-btn", { "is-active": tool === t.tool || (t.tool === "icon" && iconOpen) })}
              onClick={() => pickTool(t.tool)}
              aria-label={t.label}
              data-tool={t.tool}
            >
              {t.icon}
            </button>
          </Tip>
        ))}
        {iconOpen && (
          <Popover anchor={iconButton.current} width={300} onClose={closeIcons} testId="insert-icon-picker">
            <IconPicker
              names={iconNames}
              current=""
              onPick={(name) => {
                setIconOpen(false);
                void insertIcon(name);
              }}
            />
          </Popover>
        )}
      </div>

      <div className="bar bar-view">
        <div className="segmented">
          <button className={canvasMode === "light" ? "is-on" : ""} onClick={() => setCanvasMode("light")}>
            <Sun size={14} /> <span className="wide-only">Light</span>
          </button>
          <button className={canvasMode === "dark" ? "is-on" : ""} onClick={() => setCanvasMode("dark")}>
            <Moon size={14} /> <span className="wide-only">Dark</span>
          </button>
        </div>
        <div className="zoom">
          <button ref={zoomButton} className="ghost-btn" onClick={() => setZoomOpen(!zoomOpen)}>
            {Math.round(viewport.zoom * 100)}% <ChevronDown size={14} />
          </button>
          {zoomOpen && (
            <Popover anchor={zoomButton.current} width={220} onClose={closeZoom}>
              {[
                ["Zoom in", shortcut("mod+="), () => zoomBy(1.25)],
                ["Zoom out", shortcut("mod+-"), () => zoomBy(0.8)],
                ["Zoom to fit all files", shortcut("shift+1"), () => fitTo("all")],
                ["Zoom to selection", shortcut("shift+2"), () => fitTo("selection")],
              ].map(([label, keys, run]) => (
                <button key={label as string} className="menu-item" onClick={() => { (run as () => void)(); setZoomOpen(false); }}>
                  {label as string}
                  <kbd>{keys as string}</kbd>
                </button>
              ))}
              <div className="menu-sep" />
              {[0.5, 1, 2].map((z) => (
                <button key={z} className="menu-item" onClick={() => { zoomTo(z); setZoomOpen(false); }}>
                  {z * 100}%{z === 1 && <kbd>{shortcut("shift+0")}</kbd>}
                </button>
              ))}
            </Popover>
          )}
        </div>
        <Tip label={previewOpen ? "Close animation preview" : selection.length ? "Preview animations" : "Select a layer to preview its animations"} keys="P">
          <button
            className={cn("icon-btn", { "is-active": previewOpen })}
            onClick={() => (previewOpen ? closePreview() : void runCommand("preview-animations"))}
            disabled={!previewOpen && selection.length === 0}
            aria-label="Toggle animation preview"
            data-testid="toggle-preview"
          >
            <Clapperboard size={16} />
          </button>
        </Tip>
        <Tip label={panels.terminal ? "Hide agent terminal" : "Show agent terminal"} keys={shortcut("mod+j")}>
          <button className={cn("icon-btn", { "is-active": panels.terminal })} onClick={() => togglePanel("terminal")} aria-label="Toggle terminal">
            <SquareTerminal size={16} />
          </button>
        </Tip>
        <Tip label={panels.properties ? "Hide properties" : "Show properties"} keys={shortcut("mod+]")} hint={["Focus mode", shortcut("mod+\\")]}>
          <button className={cn("icon-btn", { "is-active": panels.properties })} onClick={() => togglePanel("properties")} aria-label="Toggle properties">
            <PanelRight size={16} />
          </button>
        </Tip>
        <Tip label="Keyboard shortcuts" keys="?">
          <button className={cn("icon-btn", { "is-active": help })} onClick={() => setHelp(!help)} aria-label="Keyboard shortcuts" data-testid="open-shortcuts">
            <Keyboard size={16} />
          </button>
        </Tip>
        <button className="btn" onClick={() => void render()} disabled={rendering}>
          <ImagePlay size={14} /> <span className="wide-only">{rendering ? "Rendering…" : "Render"}</span>
        </button>
      </div>
    </div>
  );
}
