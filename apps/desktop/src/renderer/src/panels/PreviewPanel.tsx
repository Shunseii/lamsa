import { applyMotionState, buildRenderTree, emulateReducedMotion, toHtml } from "@lamsa/renderer";
import { Clapperboard, Expand, GripVertical, Maximize2, Minimize2, Minus, Plus, Play, Shrink } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { assetUrl, shadowCss } from "../canvas/FrameView";
import { cn } from "../lib/cn";
import { isMac } from "../lib/keys";
import { ancestorsOf, baseId, nodeTitle, rootOf } from "../lib/model";
import { useEditor } from "../lib/store";
import { runCommand } from "../lib/commands";
import { PreviewFlow, type PreviewFlowHandle } from "./PreviewFlow";
import { type Bounds, cachedMeasure, type Measured, measureKey, measureLater, measureNow, POINTER_STATES, type Rect, rectIn } from "./previewMeasure";
import { TransitionEditor } from "./TransitionEditor";

const PAD = 24;
const SPEEDS = [0.1, 0.25, 1];
/** Past this, a moving layer's crop would be mostly empty, so the cell shows the whole frame. */
const MAX_CROP_GROWTH = 2.5;
const WHOLE_MAX = { width: 560, height: 320 };
const WHOLE_MAX_FULLSCREEN = { width: 1200, height: 720 };
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.25;
/** Up to this many cells are measured while opening, so they appear at their final size; more are measured in the background. */
const EAGER_CELLS = 4;
/** How far outside the stage a cell counts as on screen, so it's measured before it's panned into view. */
const ON_SCREEN_MARGIN = "200px";

const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

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

function setSpeed(root: ShadowRoot, speed: number) {
  for (const animation of root.getAnimations()) animation.playbackRate = speed;
}

function PreviewCell({
  id,
  settings,
  whole,
  eager,
  onToggleWhole,
  onReport,
  onDragStart,
  onDrop,
}: {
  id: string;
  settings: Settings;
  whole: boolean;
  eager: boolean;
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
  const onScreen = useRef(false);
  const measuring = useRef<{ hurry: () => void } | null>(null);
  const needsProvisional = useRef(false);

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
    const apply = (measured: Measured | null) => {
      needsProvisional.current = false;
      setBounds(measured?.bounds ?? null);
      onReport(id, { states: measured?.states ?? [], length: measured?.length ?? 0 });
    };
    const subject = { html, id, isRoot };
    const key = measureKey(subject);
    const cached = cachedMeasure(key);
    let later: ReturnType<typeof measureLater> | null = null;
    if (cached !== undefined) apply(cached);
    else if (eager) apply(measureNow(subject));
    else {
      needsProvisional.current = true;
      later = measureLater({ ...subject, key, onMeasured: apply });
      if (onScreen.current) later.hurry();
    }
    measuring.current = later;
    root.innerHTML = html;
    const onStart = () => setSpeed(root, speedRef.current);
    root.addEventListener("animationstart", onStart);
    root.addEventListener("transitionrun", onStart);
    setSpeed(root, speedRef.current);
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
      later?.cancel();
      measuring.current = null;
      root.removeEventListener("animationstart", onStart);
      root.removeEventListener("transitionrun", onStart);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, rootId, model, tokens, icons, canvasMode, reduced]);

  // Until the background measurement lands, size the cell from its own render at rest. Passive effects
  // run after every cell's layout effect, so these reads share one layout instead of forcing one per cell.
  // A whole frame keeps its size across states, so for those this is already the final size.
  useEffect(() => {
    if (!needsProvisional.current) return;
    needsProvisional.current = false;
    const found = parts();
    if (!found) return;
    const rest = rectIn(found.frame, found.target);
    const frame = { w: found.frame.offsetWidth, h: found.frame.offsetHeight };
    // A layer's earlier crop is likelier to match its next one than its rest box is, so keep it rather than jump.
    setBounds((current) => (current && !isRoot ? current : { crop: rest, rest, frame }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, rootId, model, tokens, icons, canvasMode, reduced]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen.current = entry?.isIntersecting ?? false;
        if (onScreen.current) measuring.current?.hurry();
      },
      { root: element.closest(".preview-stage"), rootMargin: ON_SCREEN_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
  const fullscreen = useEditor((s) => s.previewFullscreen);
  const setFullscreenValue = useEditor((s) => s.setPreviewFullscreen);
  const toggleFullscreen = useCallback(() => setFullscreenValue(!useEditor.getState().previewFullscreen), [setFullscreenValue]);
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
  const [zoom, setZoom] = useState(1);
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

  // Full screen belongs to this tab: switching away from it, or closing it, leaves full screen.
  useEffect(() => () => setFullscreenValue(false), [setFullscreenValue]);

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

  if (!preview) return <PreviewEmpty />;
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

  return (
    <div
      className={cn("preview", { "is-picking": ctrl })}
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
          toggleFullscreen();
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
          if (fullscreen) setFullscreenValue(false);
          else closePreview();
        }
      }}
    >
      <div className="preview-head" onDoubleClick={(e) => e.target === e.currentTarget && toggleFullscreen()}>
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
          onClick={toggleFullscreen}
          aria-label={fullscreen ? "Exit full screen" : "Full screen"}
          title={fullscreen ? "Exit full screen  F" : "Full screen  F"}
          data-testid="preview-fullscreen"
        >
          {fullscreen ? <Shrink size={14} /> : <Expand size={14} />}
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
            eager={order.length <= EAGER_CELLS}
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

/** Shown until something is picked to play: how to pick it, and a shortcut for the current selection. */
function PreviewEmpty() {
  const hasSelection = useEditor((s) => s.selection.length > 0);
  return (
    <div className="preview" data-testid="preview-panel">
      <div className="preview-stage preview-empty" data-testid="preview-empty">
        <div className="empty-card">
          <Clapperboard size={24} className="empty-icon" />
          <div className="strong">Nothing to preview</div>
          <p className="small">
            Select the frames or layers you want to compare, then press <kbd>P</kbd> or the play button on a frame’s label. Doing it again with
            another selection replaces these.
          </p>
          <button className="btn small" disabled={!hasSelection} onClick={() => void runCommand("preview-animations")} data-testid="preview-selection">
            <Play size={14} /> Preview selection
          </button>
        </div>
      </div>
    </div>
  );
}
