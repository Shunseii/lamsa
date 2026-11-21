import { useShallow } from "zustand/react/shallow";
import {
  ChevronDown,
  Ellipsis,
  Component,
  Frame,
  Hand,
  Image as ImageIcon,
  ImagePlay,
  Keyboard,
  MessageCircle,
  Moon,
  MousePointer2,
  PanelBottom,
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
import { api, firstOpenFile, hasDarkTokens, useEditor, type Tool } from "../lib/store";
import type { DockId } from "../lib/layout";
import { fitTo, zoomBy, zoomTo } from "../lib/viewport";
import { shortcut } from "../lib/keys";
import { LogoMark } from "./LogoMark";
import { ProjectMenu } from "./ProjectMenu";
import { IconPicker, useIconNames } from "./IconField";
import { Popover } from "./Popover";
import { cn } from "../lib/cn";
import { useAgent } from "../lib/agent";

/** After a tooltip has shown, the next one opens at once, until the pointer has been off tooltip targets for a moment. */
const TIP_COOLDOWN_MS = 400;
let coolDown: ReturnType<typeof setTimeout> | undefined;

const warmTips = () => {
  clearTimeout(coolDown);
  document.body.dataset.tipsWarm = "";
};
/** Its delayed `visibility` transition ending means this tooltip just appeared; other transitions in the target don't count. */
const onTipShown = (event: TransitionEvent) => {
  if ((event.target as Element).classList.contains("tip")) warmTips();
};
const coolTips = () => {
  clearTimeout(coolDown);
  coolDown = setTimeout(() => delete document.body.dataset.tipsWarm, TIP_COOLDOWN_MS);
};

/**
 * A tooltip: it opens after a short rest on its target (styles.css), then instantly on neighbours while warm, and a press
 * hides it until the pointer leaves.
 */
export function Tip({ label, keys, hint, className, children }: { label: string; keys?: string; hint?: [string, string]; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn("tip-wrap", className)}
      onPointerEnter={(e) => {
        if (document.body.dataset.tipsWarm !== undefined) warmTips();
        else e.currentTarget.addEventListener("transitionend", onTipShown);
      }}
      onPointerLeave={(e) => {
        e.currentTarget.removeEventListener("transitionend", onTipShown);
        delete e.currentTarget.dataset.pressed;
        if (document.body.dataset.tipsWarm !== undefined) coolTips();
      }}
      onPointerDown={(e) => {
        e.currentTarget.dataset.pressed = "";
      }}
    >
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
  { tool: "comment", icon: <MessageCircle size={16} />, label: "Comment", keys: "M" },
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

export const DOCK_TOGGLES: Record<DockId, { name: string; keys: string; icon: ReactNode }> = {
  left: { name: "left panel", keys: shortcut("mod+["), icon: <PanelLeft size={16} /> },
  right: { name: "right panel", keys: shortcut("mod+]"), icon: <PanelRight size={16} /> },
  centre: { name: "bottom panel", keys: shortcut("mod+'"), icon: <PanelBottom size={16} /> },
};

/** Shows or hides a dock. A dock whose tabs were all dragged elsewhere has nothing to show. */
function DockToggle({ dock, className }: { dock: DockId; className?: string }) {
  const { shown, empty } = useEditor(useShallow((s) => ({ shown: s.panels[dock], empty: s.layout[dock].tabs.length === 0 })));
  const { name, keys, icon } = DOCK_TOGGLES[dock];
  return (
    <Tip className={className} label={empty ? `The ${name} is empty` : shown ? `Hide ${name}` : `Show ${name}`} keys={keys} hint={dock === "centre" ? undefined : ["Focus mode", shortcut("mod+\\")]}>
      <button
        className={cn("icon-btn", { "is-active": shown && !empty })}
        onClick={() => useEditor.getState().togglePanel(dock)}
        disabled={empty}
        aria-label={`Toggle ${name}`}
        data-testid={`toggle-${dock}-dock`}
      >
        {icon}
      </button>
    </Tip>
  );
}

export function Toolbar() {
  const { snapshot, tool, setTool, canvasMode, setCanvasMode, viewport, selection, model, toast, bottomShown, bottomEmpty, help, setHelp } = useEditor(
    useShallow((s) => ({ snapshot: s.snapshot, tool: s.tool, setTool: s.setTool, canvasMode: s.canvasMode, setCanvasMode: s.setCanvasMode, viewport: s.viewport, selection: s.selection, model: s.model, toast: s.toast, bottomShown: s.panels.centre, bottomEmpty: s.layout.centre.tabs.length === 0, help: s.help, setHelp: s.setHelp })),
  );
  const [zoomOpen, setZoomOpen] = useState(false);
  const zoomButton = useRef<HTMLButtonElement>(null);
  const closeZoom = useCallback(() => setZoomOpen(false), []);
  const [rendering, setRendering] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const closeMore = useCallback(() => setMoreOpen(false), []);

  const [iconOpen, setIconOpen] = useState(false);
  const hasDark = hasDarkTokens(snapshot?.tokens);
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
    setTool((next === "component" || next === "comment") && tool === next ? "select" : next);
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
      const results = await api().render(roots, hasDark ? canvasMode : "light");
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
      <div className="topbar-row">
      <div className="bar bar-project">
        <LogoMark />
        <ProjectMenu />
        <span className="bar-divider" />
        <DockToggle dock="left" />
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
        {hasDark ? (
          <>
            <Tip className="view-compact" label={canvasMode === "light" ? "Switch canvas to dark" : "Switch canvas to light"}>
              <button
                className="icon-btn"
                onClick={() => setCanvasMode(canvasMode === "light" ? "dark" : "light")}
                aria-label="Toggle canvas mode"
                data-testid="canvas-mode-toggle"
              >
                {canvasMode === "light" ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </Tip>
            <div className="segmented view-full">
              <button className={canvasMode === "light" ? "is-on" : ""} onClick={() => setCanvasMode("light")}>
                <Sun size={14} /> <span className="wide-only">Light</span>
              </button>
              <button className={canvasMode === "dark" ? "is-on" : ""} onClick={() => setCanvasMode("dark")}>
                <Moon size={14} /> <span className="wide-only">Dark</span>
              </button>
            </div>
          </>
        ) : (
          <Tip label={`No dark tokens. Add a .dark block to ${snapshot?.tokens.source ?? "your token CSS"}.`}>
            <span className="mode-label" data-testid="canvas-mode-label">
              <Sun size={14} /> <span className="wide-only">Light only</span>
            </span>
          </Tip>
        )}
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
        <Tip className="view-full" label="Continue in your terminal" keys={shortcut("mod+j")}>
          <button className="icon-btn" onClick={() => void useAgent.getState().openTerminal()} aria-label="Continue in terminal" data-testid="toolbar-terminal">
            <SquareTerminal size={16} />
          </button>
        </Tip>
        <DockToggle dock="centre" className="view-full" />
        <DockToggle dock="right" />
        <Tip className="view-full" label="Keyboard shortcuts" keys="?">
          <button className={cn("icon-btn", { "is-active": help })} onClick={() => setHelp(!help)} aria-label="Keyboard shortcuts" data-testid="open-shortcuts">
            <Keyboard size={16} />
          </button>
        </Tip>
        <button className="btn view-full" onClick={() => void render()} disabled={rendering}>
          <ImagePlay size={14} /> <span className="wide-only">{rendering ? "Rendering…" : "Render"}</span>
        </button>
        <Tip className="view-compact" label="More">
          <button
            ref={moreButton}
            className={cn("icon-btn", { "is-active": moreOpen })}
            onClick={() => setMoreOpen(!moreOpen)}
            aria-label="More"
            data-testid="view-more"
          >
            <Ellipsis size={16} />
          </button>
        </Tip>
        {moreOpen && (
          <Popover anchor={moreButton.current} width={240} onClose={closeMore} testId="view-more-menu">
            {[
              {
                label: bottomShown ? "Hide bottom panel" : "Show bottom panel",
                icon: <PanelBottom size={14} className="muted" />,
                keys: DOCK_TOGGLES.centre.keys,
                disabled: bottomEmpty,
                run: () => useEditor.getState().togglePanel("centre"),
              },
              { label: "Continue in your terminal", icon: <SquareTerminal size={14} className="muted" />, keys: shortcut("mod+j"), run: () => void useAgent.getState().openTerminal() },
              { label: "Keyboard shortcuts", icon: <Keyboard size={14} className="muted" />, keys: "?", run: () => setHelp(!help) },
            ].map((item) => (
              <button
                key={item.label}
                className="menu-item"
                disabled={item.disabled}
                onClick={() => {
                  setMoreOpen(false);
                  item.run();
                }}
              >
                {item.icon}
                {item.label}
                <kbd>{item.keys}</kbd>
              </button>
            ))}
            <div className="menu-sep" />
            <button
              className="menu-item"
              disabled={rendering}
              onClick={() => {
                setMoreOpen(false);
                void render();
              }}
            >
              <ImagePlay size={14} className="muted" />
              {rendering ? "Rendering…" : "Render"}
            </button>
          </Popover>
        )}
      </div>
      </div>
    </div>
  );
}
