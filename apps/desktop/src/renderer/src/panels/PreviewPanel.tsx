import {
  applyMotionState,
  buildRenderTree,
  emulateReducedMotion,
  motionLength,
  motionStatesIn,
  toHtml,
} from "@lamsa/renderer";
import { Clapperboard, Expand, GripVertical, Maximize2, Minimize2, Minus, Plus, Play, Shrink, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { assetUrl, shadowCss } from "../canvas/FrameView";
import { cn } from "../lib/cn";
import { isMac } from "../lib/keys";
import { ancestorsOf, baseId, nodeTitle, rootOf } from "../lib/model";
import { useEditor } from "../lib/store";
import { PreviewFlow, type PreviewFlowHandle } from "./PreviewFlow";
import { TransitionEditor } from "./TransitionEditor";

const PAD = 24;
const SPEEDS = [0.1, 0.25, 1];
/** Pointer states are played by really hovering or pressing in the preview; they're only measured for the crop. */
const POINTER_STATES = ["hover", "press", "focus"];
/** Past this, a moving layer's crop would be mostly empty, so the cell shows the whole frame. */
const MAX_CROP_GROWTH = 2.5;
const WHOLE_MAX = { width: 560, height: 320 };
const WHOLE_MAX_FULLSCREEN = { width: 1200, height: 720 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Settings {
  state: string;
  speed: number;
  reduced: boolean;
  generation: number;
  ctrl: boolean;
  /** Multiplies every cell's own scale (1:1 for a crop, fitted for a whole frame). */
  zoom: number;
  fullscreen: boolean;
}

const union = (all: Rect[]): Rect => {
  // A state that hides the layer (`display: none`) measures 0×0 at the frame's corner; it adds nothing.
  const visible = all.filter((r) => r.w > 0 || r.h > 0);
  const rects = visible.length ? visible : all;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

function setSpeed(root: ShadowRoot, speed: number) {
  for (const animation of root.getAnimations()) animation.playbackRate = speed;
}

/** Where `target` travels while its animations run, in the frame's own pixels. Restarts them from 0. */
function motionBounds(root: ShadowRoot, frame: HTMLElement, target: HTMLElement): Rect {
  const scale = frame.getBoundingClientRect().width / (frame.offsetWidth || 1) || 1;
  const rectNow = (): Rect => {
    const base = frame.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    return { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale };
  };
  const animations = root.getAnimations();
  const length = motionLength(root);
  const rects = [rectNow()];
  if (length > 0) {
    for (let i = 0; i <= 12; i++) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = (length * i) / 12;
      }
      rects.push(rectNow());
    }
    for (const animation of animations) {
      animation.currentTime = 0;
      animation.play();
    }
  }
  return union(rects);
}

const rectIn = (frame: HTMLElement, target: HTMLElement): Rect => {
  const base = frame.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const scale = base.width / (frame.offsetWidth || 1) || 1;
  return { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale };
};

interface Bounds {
  crop: Rect;
  rest: Rect;
  frame: { w: number; h: number };
}

/**
 * Where the layer travels across every state, measured once in a hidden copy so the visible cell
 * never resizes or restarts its animations when the state changes.
 */
function measureAllStates({ html, id, isRoot }: { html: string; id: string; isRoot: boolean }): { bounds: Bounds; states: string[]; length: number } | null {
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; left: -100000px; top: 0; visibility: hidden; pointer-events: none;";
  document.body.appendChild(container);
  const root = container.attachShadow({ mode: "open" });
  const mount = () => {
    root.innerHTML = html;
    const frame = root.querySelector<HTMLElement>(".lamsa-surface > [data-node-id]");
    const target = isRoot ? frame : root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    return frame && target ? { frame, target } : null;
  };
  try {
    const first = mount();
    if (!first) return null;
    const own = (first.target.getAttribute("data-lamsa-states") ?? "").split(" ").filter(Boolean);
    const states = [...new Set([...own, ...motionStatesIn(first.target)])];
    const length = motionLength(root);
    const rest = rectIn(first.frame, first.target);
    const frame = { w: first.frame.offsetWidth, h: first.frame.offsetHeight };
    const rects = [motionBounds(root, first.frame, first.target)];
    for (const state of [...POINTER_STATES, ...states]) {
      const found = mount();
      if (!found) continue;
      found.frame.getBoundingClientRect();
      applyMotionState(root, state, isRoot ? null : found.target);
      found.frame.getBoundingClientRect();
      rects.push(motionBounds(root, found.frame, found.target));
    }
    return { bounds: { crop: union(rects), rest, frame }, states, length };
  } finally {
    container.remove();
  }
}

function PreviewCell({
  id,
  settings,
  whole,
  onToggleWhole,
  onReport,
  onDragStart,
  onDrop,
}: {
  id: string;
  settings: Settings;
  whole: boolean;
  onToggleWhole: () => void;
  onReport: (id: string, report: { states: string[]; length: number }) => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const model = useEditor((s) => s.model);
  const tokens = useEditor((s) => s.snapshot?.tokens);
  const icons = useEditor((s) => s.icons);
  const canvasMode = useEditor((s) => s.canvasMode);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const host = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [picking, setPicking] = useState<{ box: Rect; name: string } | null>(null);
  const [selectedBox, setSelectedBox] = useState<Rect | null>(null);
  const rootId = rootOf(model, baseId(id));
  const isRoot = rootId === id;
  const { state, speed, reduced, generation, ctrl, zoom, fullscreen } = settings;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const stateRef = useRef(state);
  const mountedState = useRef(state);

  const parts = useCallback(() => {
    const root = host.current?.shadowRoot;
    const frame = root?.querySelector<HTMLElement>(".lamsa-surface > [data-node-id]");
    const target = isRoot ? frame : root?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    return root && frame && target ? { root, frame, target } : null;
  }, [id, isRoot]);

  // Mount (and remount on replay or any design change): entrances play from the start.
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !tokens || !model.nodes[rootId]) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    const result = buildRenderTree({
      nodes: model.nodes,
      rootId,
      tokens,
      canvasMode,
      iconSvg: (name) => icons[name] || undefined,
      assetUrl,
      fileCss: model.fileCss,
    });
    const css = reduced ? emulateReducedMotion(result.css) : result.css;
    const html = `<style>${shadowCss(tokens)}\n${css}</style><div class="lamsa-surface ${result.mode}" style="display: inline-block">${toHtml(result.root)}</div>`;
    const measured = measureAllStates({ html, id, isRoot });
    setBounds(measured?.bounds ?? null);
    root.innerHTML = html;
    const onStart = () => setSpeed(root, speedRef.current);
    root.addEventListener("animationstart", onStart);
    root.addEventListener("transitionrun", onStart);
    setSpeed(root, speedRef.current);
    onReport(id, { states: measured?.states ?? [], length: measured?.length ?? 0 });
    mountedState.current = "rest";
    // A state other than rest is entered a moment after mounting, so its transition plays.
    let frameId = 0;
    if (stateRef.current !== "rest") {
      frameId = requestAnimationFrame(() => {
        frameId = requestAnimationFrame(() => {
          const now = parts();
          if (!now) return;
          applyMotionState(now.root, stateRef.current, isRoot ? null : now.target);
          mountedState.current = stateRef.current;
        });
      });
    }
    return () => {
      cancelAnimationFrame(frameId);
      root.removeEventListener("animationstart", onStart);
      root.removeEventListener("transitionrun", onStart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, rootId, model, tokens, icons, canvasMode, reduced]);

  // Changing state without a remount plays the transition between the two.
  useLayoutEffect(() => {
    stateRef.current = state;
    if (mountedState.current === state) return;
    mountedState.current = state;
    const found = parts();
    if (!found) return;
    applyMotionState(found.root, state, isRoot ? null : found.target);
  }, [state, parts, isRoot]);

  useEffect(() => {
    const root = host.current?.shadowRoot;
    if (root) setSpeed(root, speed);
  }, [speed]);

  const cropMode = !whole && !isRoot && bounds && bounds.crop.w <= bounds.rest.w * MAX_CROP_GROWTH + PAD * 4 && bounds.crop.h <= bounds.rest.h * MAX_CROP_GROWTH + PAD * 4;
  const wholeMax = fullscreen ? WHOLE_MAX_FULLSCREEN : WHOLE_MAX;
  const fit = bounds ? Math.min(1, wholeMax.width / bounds.frame.w, wholeMax.height / bounds.frame.h) : 1;
  const scale = (cropMode ? 1 : fit) * zoom;
  const size = !bounds
    ? { width: 120, height: 80 }
    : cropMode
      ? { width: (bounds.crop.w + PAD * 2) * scale, height: (bounds.crop.h + PAD * 2) * scale }
      : { width: bounds.frame.w * scale, height: bounds.frame.h * scale };
  const offset = bounds && cropMode ? { left: -(bounds.crop.x - PAD) * scale, top: -(bounds.crop.y - PAD) * scale } : { left: 0, top: 0 };

  const toViewport = useCallback(
    (element: Element): Rect | null => {
      const box = viewport.current;
      if (!box) return null;
      // Absolute children are placed from the padding box, inside the viewport's border.
      const frame = box.getBoundingClientRect();
      const r = element.getBoundingClientRect();
      return { x: r.left - frame.left - box.clientLeft, y: r.top - frame.top - box.clientTop, w: r.width, h: r.height };
    },
    [],
  );

  // Outline the layer that's selected in the editor, if it's in this cell.
  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    const own = baseId(id);
    const selected = selection.find((sid) => sid === own || (!isRoot && ancestorsOf(model, sid).includes(own)) || (isRoot && rootOf(model, sid) === rootId && sid !== rootId));
    const element = selected ? root?.querySelector(`[data-node-id="${CSS.escape(selected)}"]`) : null;
    setSelectedBox(element ? toViewport(element) : null);
  }, [selection, model, rootId, id, isRoot, bounds, state, toViewport, scale]);

  const elementAt = (e: ReactPointerEvent): Element | null => {
    const root = host.current?.shadowRoot;
    if (!root) return null;
    return root.elementsFromPoint(e.clientX, e.clientY).find((element) => element.hasAttribute("data-node-id")) ?? null;
  };

  const rootName = nodeTitle(rootId, model.nodes[rootId]);
  return (
    <div className="preview-cell">
      <div
        className="preview-cell-label"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
        title="Drag to reorder"
      >
        <GripVertical size={12} className="muted" />
        <span className="strong">{nodeTitle(id, model.nodes[baseId(id)])}</span>
        {!isRoot && <span className="mono muted">in {rootName}</span>}
        {!isRoot && (
          <button className={cn("preview-whole", { "is-on": whole })} onClick={onToggleWhole}>
            {whole ? <Minimize2 size={11} /> : <Maximize2 size={11} />} Whole frame
          </button>
        )}
        {bounds && scale !== 1 && (
          <span className="mono muted push-right">
            {!cropMode && fit < 1 ? "fit · " : ""}
            {Math.round(scale * 100)}%
          </span>
        )}
      </div>
      <div ref={viewport} className="preview-viewport" style={size} data-testid="preview-cell" data-preview-id={id}>
        <div className="preview-render" style={{ ...offset, transform: scale === 1 ? undefined : `scale(${scale})` }}>
          <div ref={host} />
        </div>
        {cropMode && bounds && (
          <div
            className="preview-dim"
            style={{ left: (PAD - 4) * scale, top: (PAD - 4) * scale, width: (bounds.crop.w + 8) * scale, height: (bounds.crop.h + 8) * scale }}
          />
        )}
        {selectedBox && (
          <div
            className={cn("preview-selected", {
              // A selection that fills the cell follows its rounded corners, which would clip a square outline.
              "is-whole": selectedBox.x <= 0.5 && selectedBox.y <= 0.5 && selectedBox.x + selectedBox.w >= size.width - 0.5 && selectedBox.y + selectedBox.h >= size.height - 0.5,
            })}
            style={{ left: selectedBox.x, top: selectedBox.y, width: selectedBox.w, height: selectedBox.h }}
          />
        )}
        {ctrl && (
          <div
            className="preview-pick"
            onPointerMove={(e) => {
              const element = elementAt(e);
              const box = element ? toViewport(element) : null;
              const nodeId = element?.getAttribute("data-node-id");
              setPicking(box && nodeId ? { box, name: nodeTitle(baseId(nodeId), model.nodes[baseId(nodeId)]) } : null);
            }}
            onPointerLeave={() => setPicking(null)}
            onPointerDown={(e) => {
              e.preventDefault();
              const nodeId = elementAt(e)?.getAttribute("data-node-id");
              if (!nodeId) return;
              const picked = baseId(nodeId);
              const current = useEditor.getState().selection;
              select(e.shiftKey ? (current.includes(picked) ? current.filter((s) => s !== picked) : [...current, picked]) : [picked]);
            }}
          />
        )}
        {ctrl && picking && (
          <div className="preview-picking" style={{ left: picking.box.x, top: picking.box.y, width: picking.box.w, height: picking.box.h }}>
            <span className="preview-picking-name">{picking.name}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function PreviewPanel() {
  const preview = useEditor((s) => s.preview);
  const closePreview = useEditor((s) => s.closePreview);
  const terminalOpen = useEditor((s) => s.panels.terminal);
  const model = useEditor((s) => s.model);
  const [order, setOrder] = useState<string[]>(preview ?? []);
  const [state, setState] = useState("rest");
  const [speed, setSpeedValue] = useState(1);
  const [loop, setLoop] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [whole, setWhole] = useState<Set<string>>(new Set());
  const [ctrl, setCtrl] = useState(false);
  const [reports, setReports] = useState<Record<string, { states: string[]; length: number }>>({});
  const [height, setHeight] = useState(340);
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [flowMode, setFlowMode] = useState(false);
  const [pair, setPair] = useState(0);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [panning, setPanning] = useState(false);
  const flowRef = useRef<PreviewFlowHandle>(null);
  const dragging = useRef<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setOrder(preview ?? []);
    setState("rest");
    setPair(0);
  }, [preview]);

  // The wheel zooms toward the pointer; the middle button pans (see startPan).
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = element.getBoundingClientRect();
      // Cells are centred horizontally and laid out from the top, so that's the point zoom scales from.
      const anchor = { x: e.clientX - (box.left + box.width / 2), y: e.clientY - box.top };
      const current = zoomRef.current;
      const next = clampZoom(current * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
      const k = next / current;
      zoomRef.current = next;
      setZoom(next);
      setPan((p) => ({ x: anchor.x - (anchor.x - p.x) * k, y: anchor.y - (anchor.y - p.y) * k }));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [preview]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => setCtrl(isMac ? e.metaKey : e.ctrlKey);
    const reset = () => setCtrl(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", down);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", down);
      window.removeEventListener("blur", reset);
    };
  }, []);

  const replay = useCallback(() => setGeneration((g) => g + 1), []);
  const longest = Math.max(0, ...order.map((id) => reports[id]?.length ?? 0));

  // Two or more whole frames can also play as a flow: one page transitioning to the next.
  const canFlow = order.length >= 2 && order.every((id) => model.nodes[id] && !model.nodes[id]!.parentId);
  const flow = flowMode && canFlow;

  useEffect(() => {
    if (!loop || flow) return;
    const timer = setInterval(replay, Math.max(900, longest / speed + 700));
    return () => clearInterval(timer);
  }, [loop, longest, speed, replay, flow]);

  const onReport = useCallback((id: string, report: { states: string[]; length: number }) => {
    setReports((current) => {
      const before = current[id];
      if (before && before.length === report.length && before.states.join() === report.states.join()) return current;
      return { ...current, [id]: report };
    });
  }, []);

  if (!preview) return null;
  const custom = [...new Set(order.flatMap((id) => reports[id]?.states ?? []))].filter((s) => !POINTER_STATES.includes(s));
  const settings: Settings = { state, speed, reduced, generation, ctrl, zoom, fullscreen };
  const zoomBy = (factor: number) => setZoom((current) => clampZoom(current * factor));
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const startPan = (e: ReactPointerEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.clientX, y: e.clientY, pan };
    setPanning(true);
    const move = (event: PointerEvent) => setPan({ x: start.pan.x + event.clientX - start.x, y: start.pan.y + event.clientY - start.y });
    const up = () => {
      setPanning(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: ReactPointerEvent) => {
    const startY = e.clientY;
    const startHeight = height;
    const move = (event: PointerEvent) => setHeight(Math.max(200, Math.min(window.innerHeight * 0.7, startHeight + startY - event.clientY)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={cn("panel panel-preview", { "is-picking": ctrl, "is-fullscreen": fullscreen })}
      style={fullscreen ? undefined : { height, bottom: terminalOpen ? 56 + 320 + 12 : 56 }}
      tabIndex={-1}
      data-testid="preview-panel"
      onKeyDown={(e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const target = e.target as HTMLElement;
        if (target.closest("input, select, textarea, [contenteditable='true'], .cm-editor")) return;
        const handled = () => {
          e.preventDefault();
          e.stopPropagation();
        };
        if (e.key === "r" || e.key === "R") {
          handled();
          replay();
        } else if (e.key === "f" || e.key === "F") {
          handled();
          setFullscreen((on) => !on);
        } else if (e.key === "=" || e.key === "+") {
          handled();
          zoomBy(ZOOM_STEP);
        } else if (e.key === "-") {
          handled();
          zoomBy(1 / ZOOM_STEP);
        } else if (e.key === "0") {
          handled();
          resetView();
        } else if (flow && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
          handled();
          flowRef.current?.step(e.key === "ArrowRight" ? 1 : -1);
        } else if (e.key === "Escape") {
          e.stopPropagation();
          if (fullscreen) setFullscreen(false);
          else closePreview();
        }
      }}
    >
      {!fullscreen && <div className="preview-resize" onPointerDown={startResize} />}
      <div className="preview-head" onDoubleClick={(e) => e.target === e.currentTarget && setFullscreen((on) => !on)}>
        <Clapperboard size={16} className="muted" />
        <span className="strong">Preview</span>
        <span className="mono muted">
          {order.length} layer{order.length === 1 ? "" : "s"}
        </span>
        <div className="preview-zoom push-right" data-testid="preview-zoom">
          <button className="icon-btn small" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" title="Zoom out  −">
            <Minus size={14} />
          </button>
          <button className="preview-zoom-value mono" onClick={resetView} title="Reset zoom and position  0">
            {Math.round(zoom * 100)}%
          </button>
          <button className="icon-btn small" onClick={() => zoomBy(ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in  +">
            <Plus size={14} />
          </button>
        </div>
        <button
          className="icon-btn small"
          onClick={() => setFullscreen((on) => !on)}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen  F" : "Full screen  F"}
          data-testid="preview-fullscreen"
        >
          {fullscreen ? <Shrink size={14} /> : <Expand size={14} />}
        </button>
        <button className="icon-btn small" onClick={closePreview} aria-label="Close preview">
          <X size={16} />
        </button>
      </div>
      <div className="preview-body">
      <div
        ref={stage}
        className={cn("preview-stage", { "is-panning": panning })}
        onPointerDownCapture={startPan}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        style={{ backgroundPosition: `${pan.x}px ${pan.y}px` }}
        data-testid="preview-stage"
      >
        <div className="preview-world" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        {flow && (
          <PreviewFlow
            ref={flowRef}
            ids={order}
            speed={speed}
            reduced={reduced}
            loop={loop}
            generation={generation}
            zoom={zoom}
            maxSize={fullscreen ? WHOLE_MAX_FULLSCREEN : WHOLE_MAX}
            pair={Math.min(pair, order.length - 2)}
            onPair={setPair}
          />
        )}
        {!flow && order.map((id) => (
          <PreviewCell
            key={id}
            id={id}
            settings={settings}
            whole={whole.has(id)}
            onToggleWhole={() =>
              setWhole((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onReport={onReport}
            onDragStart={() => (dragging.current = id)}
            onDrop={() => {
              const from = dragging.current;
              dragging.current = null;
              if (!from || from === id) return;
              setOrder((current) => {
                const next = current.filter((x) => x !== from);
                next.splice(next.indexOf(id), 0, from);
                return next;
              });
            }}
          />
        ))}
        </div>
      </div>
      {flow && order[Math.min(pair, order.length - 2) + 1] && (
        <TransitionEditor
          from={order[Math.min(pair, order.length - 2)]!}
          to={order[Math.min(pair, order.length - 2) + 1]!}
          onEdited={() => flowRef.current?.playAfterEdit(Math.min(pair, order.length - 2))}
          onReplay={() => flowRef.current?.play(Math.min(pair, order.length - 2))}
        />
      )}
      </div>
      <div className="preview-controls">
        {canFlow && (
          <div className="segmented small" data-testid="preview-mode">
            <button className={flow ? "" : "is-on"} onClick={() => setFlowMode(false)} title="Each frame in its own cell">
              Side by side
            </button>
            <button className={flow ? "is-on" : ""} onClick={() => setFlowMode(true)} title="One frame at a time, with page transitions between them">
              Flow
            </button>
          </div>
        )}
        <button
          className="btn small"
          onClick={replay}
          data-testid="preview-replay"
          title={flow ? "Play each page transition in order" : "Play every animation from the start"}
        >
          <Play size={14} /> Play <kbd>R</kbd>
        </button>
        <label className="switch-label">
          <input type="checkbox" className="switch" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> Loop
        </label>
        {!flow && custom.length > 0 && (
          <>
            <span className="bar-divider" />
            <span className="muted small">data-state</span>
            <div className="segmented small wrap" data-testid="preview-states">
              {["rest", ...custom].map((s) => (
                <button key={s} className={state === s ? "is-on" : ""} onClick={() => setState(s)}>
                  {s === "rest" ? "None" : s}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="segmented small">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? "is-on" : ""} onClick={() => setSpeedValue(s)}>
              {s}×
            </button>
          ))}
        </div>
        <label className="switch-label">
          <input type="checkbox" className="switch" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> Reduced
        </label>
        <span className={cn("preview-hint push-right", { "is-on": ctrl })}>
          {flow ? (
            <>
              <kbd>←</kbd> <kbd>→</kbd> step through frames
            </>
          ) : ctrl ? (
            "Selecting"
          ) : (
            <>
              Hover and click to interact · <kbd>{isMac ? "⌘" : "Ctrl"}</kbd> click to select · scroll to zoom · drag with the middle button to pan
            </>
          )}
        </span>
      </div>
    </div>
  );
}
