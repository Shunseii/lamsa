import type { DesignNode } from "@lamsa/schema";
import { FileJson, Play } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { insertNodes, newId, reparentMany, setStyle } from "../lib/edits";
import { ancestorsOf, baseId, childrenOf, fileRegions, isComponent, isLocked, nodeTitle, rootOf, type Model } from "../lib/model";
import { shortcut } from "../lib/keys";
import { firstOpenFile, useEditor } from "../lib/store";
import { AddFileMenu } from "../panels/AddFileMenu";
import { findElement, FrameView, shadowRoots } from "./FrameView";
import { cn } from "../lib/cn";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Drag =
  | { kind: "pan"; startX: number; startY: number; origin: { x: number; y: number } }
  | { kind: "marquee"; start: { x: number; y: number }; current: { x: number; y: number }; additive: boolean }
  | { kind: "pending-move"; start: { x: number; y: number }; id: string; collapse: boolean; clickSelects?: string }
  | { kind: "move-roots"; start: { x: number; y: number }; ids: string[]; origins: Record<string, { x: number; y: number }>; startRects: Record<string, Rect | null>; delta: { x: number; y: number }; guides: Guide[] }
  | { kind: "move-absolute"; start: { x: number; y: number }; id: string; origin: { left: number; top: number }; delta: { x: number; y: number } }
  | { kind: "reorder"; start: { x: number; y: number }; ids: string[]; fromParent: string; parentId: string; beforeId: string | null; line: Rect | null }
  | { kind: "resize"; start: { x: number; y: number }; id: string; handle: Handle; origin: Rect; isRoot: boolean; absolute: boolean; originPos: { left: number; top: number }; size: { w: number; h: number }; moved: boolean }
  | { kind: "draw"; start: { x: number; y: number }; current: { x: number; y: number }; parentId?: string; tool: "frame" | "rect" };

/** Frames narrower than this on screen don't get the label's preview button; it would crowd the name. */
const PLAY_MIN_WIDTH = 140;
/** Below this on-screen width a frame's label hides (unless selected or hovered); it couldn't show a readable name. */
const LABEL_MIN_WIDTH = 40;
/** On-screen height a label needs above its frame; with less room it would cover the frame above. */
const LABEL_HEIGHT = 22;
/** Screen space kept clear between a file's name and the next file's frames. */
const FILE_LABEL_GAP = 12;
/** The label's padding, pulled back out so its text lines up with the frame's left edge. */
const LABEL_INSET = 4;
/** Screen gap between a label and its frame. */
const LABEL_GAP = 4;

type FrameBox = { id: string; left: number; top: number; right: number; bottom: number };

/** For each frame, the world-space gap to the nearest frame above it that shares some of its columns. */
function roomAbove(boxes: FrameBox[]): Map<string, number> {
  const room = new Map<string, number>();
  for (const box of boxes) {
    let gap = Infinity;
    for (const other of boxes) {
      const overlapsColumns = other.left < box.right && other.right > box.left;
      if (other === box || !overlapsColumns || other.top >= box.top) continue;
      gap = Math.min(gap, box.top - other.bottom);
    }
    room.set(box.id, gap);
  }
  return room;
}

function showsPlay(node: DesignNode, zoom: number): boolean {
  const width = parseFloat(String(node.style?.width ?? ""));
  return Number.isFinite(width) ? width * zoom >= PLAY_MIN_WIDTH : zoom >= 0.5;
}

interface Guide {
  axis: "x" | "y";
  at: number;
}

/** Deepest design node under a screen point, looking inside each frame's shadow root. */
function hitTest(clientX: number, clientY: number): string | null {
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element.classList.contains("frame-label")) return (element as HTMLElement).dataset.labelFor ?? null;
    if (element.classList.contains("frame-host") && element.shadowRoot) {
      let inner: Element | null = element.shadowRoot.elementFromPoint(clientX, clientY);
      while (inner && !inner.getAttribute("data-node-id")) inner = inner.parentElement;
      if (inner) return inner.getAttribute("data-node-id");
    }
    if (element.classList.contains("panel") || element.classList.contains("bar")) return null;
  }
  return null;
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?(px)?$/.test(value)) return Number.parseFloat(value);
  return fallback;
}

function isFlowParent(element: HTMLElement | null): { flow: boolean; axis: "x" | "y" } {
  if (!element) return { flow: false, axis: "y" };
  const style = getComputedStyle(element);
  const flex = style.display.includes("flex");
  const grid = style.display.includes("grid");
  const axis = flex && style.flexDirection.startsWith("row") ? "x" : "y";
  return { flow: flex || grid || style.display === "block", axis };
}

/** Memoised: the editor shell re-renders on panel toggles, which don't change the canvas. */
export const Canvas = memo(function Canvas() {
  const container = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [space, setSpace] = useState(false);
  /** The last press was a drag (move, resize, draw…), so its click shouldn't count toward a double-click. */
  const draggedRecently = useRef(false);

  const {
    snapshot,
    model,
    selection,
    hover,
    tool,
    viewport,
    canvasMode,
    icons,
    renderVersion,
    editingText,
    flash,
    previewProps,
  } = useEditor(
    useShallow((s) => ({
      snapshot: s.snapshot,
      model: s.model,
      selection: s.selection,
      hover: s.hover,
      tool: s.tool,
      viewport: s.viewport,
      canvasMode: s.canvasMode,
      icons: s.icons,
      renderVersion: s.renderVersion,
      editingText: s.editingText,
      flash: s.flash,
      previewProps: s.previewProps,
    })),
  );
  const store = useEditor.getState;

  const tokens = snapshot?.tokens;
  const regions = fileRegions(model, snapshot?.root, (id) => (shadowRoots.get(id)?.host as HTMLElement | undefined)?.offsetWidth);
  const dxOf = (id: string) => regions.get(model.fileOf.get(id) ?? "")?.dx ?? 0;
  const dxOfFile = (file: string) => regions.get(file)?.dx ?? 0;
  const labelRoom = roomAbove(
    model.roots.flatMap((id) => {
      const host = shadowRoots.get(id)?.host as HTMLElement | undefined;
      const node = model.nodes[id];
      if (!host || !node) return [];
      const left = (node.x ?? 0) + dxOf(id);
      const top = node.y ?? 0;
      return [{ id, left, top, right: left + host.offsetWidth, bottom: top + host.offsetHeight }];
    }),
  );

  const toScreen = useCallback(
    (rect: DOMRect): Rect => {
      const box = container.current?.getBoundingClientRect();
      return { x: rect.left - (box?.left ?? 0), y: rect.top - (box?.top ?? 0), w: rect.width, h: rect.height };
    },
    [],
  );

  const screenRect = useCallback(
    (displayId: string): Rect | null => {
      const id = baseId(displayId);
      if (!model.nodes[id]) return null;
      const element = findElement(rootOf(model, id), displayId);
      return element ? toScreen(element.getBoundingClientRect()) : null;
    },
    [model, toScreen],
  );

  const toWorld = useCallback(
    (clientX: number, clientY: number) => {
      const box = container.current?.getBoundingClientRect();
      return {
        x: (clientX - (box?.left ?? 0) - viewport.x) / viewport.zoom,
        y: (clientY - (box?.top ?? 0) - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => setTick((t) => t + 1));
    return () => cancelAnimationFrame(frame);
  }, [model, viewport, selection, renderVersion, icons, canvasMode, previewProps]);

  // Outlines follow frames that change size on their own (variant previews, late-loading fonts).
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTick((t) => t + 1));
    for (const host of Array.from(element.querySelectorAll(".frame-host"))) observer.observe(host);
    return () => observer.disconnect();
  }, [model]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target as HTMLElement)?.isContentEditable) setSpace(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = store().viewport;
      if (e.ctrlKey || e.metaKey) {
        const box = element.getBoundingClientRect();
        const px = e.clientX - box.left;
        const py = e.clientY - box.top;
        const zoom = Math.min(8, Math.max(0.05, vp.zoom * zoomFactor(e)));
        store().setViewport({ zoom, x: px - ((px - vp.x) * zoom) / vp.zoom, y: py - ((py - vp.y) * zoom) / vp.zoom });
      } else {
        store().setViewport({ ...vp, x: vp.x - e.deltaX, y: vp.y - e.deltaY });
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [store]);

  const deepestFrameAt = (displayId: string | null): string | undefined => {
    if (!displayId || displayId.includes("/")) return displayId ? baseId(displayId) : undefined;
    let id: string | undefined = displayId;
    while (id && model.nodes[id]?.type !== "frame") id = model.nodes[id]?.parentId;
    return id;
  };

  /** root → … → id */
  const chainOf = (id: string): string[] => [...ancestorsOf(model, id)].reverse().concat(id);

  /**
   * What a click on `displayId` selects (Figma's rules): the deepest layer whose parent is "entered" —
   * a top-level screen, or an ancestor of the current selection. Main components, like instances,
   * select as a whole until you double-click into them. Ctrl/⌘ selects the deepest layer.
   */
  const selectableId = (displayId: string, deep = false): string | null => {
    const id = baseId(displayId);
    const chain = chainOf(id);
    const root = chain[0]!;
    let pick = root;
    if (deep) pick = id;
    else {
      const entered = new Set<string>(isComponent(model.nodes[root]) ? [] : [root]);
      for (const selected of selection) for (const ancestor of ancestorsOf(model, selected)) entered.add(ancestor);
      for (let i = chain.length - 1; i >= 1; i--) {
        if (entered.has(chain[i - 1]!)) {
          pick = chain[i]!;
          break;
        }
      }
    }
    // Clicks pass through locked layers to the nearest unlocked layer around them, or to the canvas.
    let candidate: string | undefined = pick;
    while (candidate && isLocked(model, candidate)) candidate = model.nodes[candidate]?.parentId;
    return candidate ?? null;
  };

  const isInside = (id: string, container: string) => id === container || ancestorsOf(model, id).includes(container);

  /** The frame a dragged layer would land in under the pointer, never inside what is being dragged. */
  const dropTargetAt = (clientX: number, clientY: number, moving: string[]): string | null => {
    const hit = hitTest(clientX, clientY);
    if (!hit) return null;
    let id: string | undefined = baseId(hit);
    while (id && (model.nodes[id]?.type !== "frame" || moving.some((m) => isInside(id!, m)))) id = model.nodes[id]?.parentId;
    return id ?? null;
  };

  const startTextEdit = (displayId: string) => {
    const id = baseId(displayId);
    const element = findElement(rootOf(model, id), displayId);
    const node = displayId.includes("/") ? undefined : model.nodes[id];
    if (!element || (node && node.type !== "text")) return;
    if (displayId.split("/").length > 2) {
      store().toast({ tone: "warn", title: "Nested instance text", message: "Edit it on the component, or override it from the outer instance's properties." });
      return;
    }
    store().setEditingText(displayId);
    element.contentEditable = "plaintext-only";
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const sel = element.ownerDocument.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    const finish = (commit: boolean) => {
      element.removeEventListener("blur", onBlur);
      element.removeEventListener("keydown", onKey);
      element.contentEditable = "false";
      const text = element.innerText.replace(/\n$/, "");
      store().setEditingText(null);
      if (!commit) return;
      const current = store().model;
      if (displayId.includes("/")) {
        const [instanceId, innerId] = displayId.split("/") as [string, string];
        const instance = current.nodes[instanceId];
        if (instance?.type !== "instance") return;
        void store().commit("Edit text", [
          {
            file: current.fileOf.get(instanceId)!,
            id: instanceId,
            node: {
              ...instance,
              overrides: { ...instance.overrides, [innerId]: { ...instance.overrides?.[innerId], content: text } },
            },
          },
        ]);
      } else {
        const textNode = current.nodes[id];
        if (textNode?.type !== "text" || textNode.content === text) return;
        void store().commit("Edit text", [{ file: current.fileOf.get(id)!, id, node: { ...textNode, content: text } }]);
      }
    };
    const onBlur = () => finish(true);
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        finish(false);
        element.blur();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        element.blur();
      }
    };
    element.addEventListener("blur", onBlur);
    element.addEventListener("keydown", onKey);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (editingText) return;
    const target = e.target as HTMLElement;
    container.current?.setPointerCapture(e.pointerId);
    const point = { x: e.clientX, y: e.clientY };
    store().setContextMenu(null);

    if (e.button === 1 || tool === "hand" || space) {
      setDrag({ kind: "pan", startX: e.clientX, startY: e.clientY, origin: { x: viewport.x, y: viewport.y } });
      return;
    }
    if (e.button !== 0) return;

    const handle = target.dataset.handle as Handle | undefined;
    if (handle && selection.length === 1) {
      const id = selection[0]!;
      const rect = screenRect(id);
      const node = model.nodes[id]!;
      if (!rect) return;
      const element = findElement(rootOf(model, id), id);
      const absolute = element ? getComputedStyle(element).position === "absolute" : false;
      setDrag({
        kind: "resize",
        start: point,
        id,
        handle,
        origin: rect,
        isRoot: node.parentId === undefined,
        absolute,
        originPos: { left: numberOr(node.style?.left, 0), top: numberOr(node.style?.top, 0) },
        size: { w: Math.round(rect.w / viewport.zoom), h: Math.round(rect.h / viewport.zoom) },
        moved: false,
      });
      return;
    }

    // A file's name selects all its frames; dragging it moves them together.
    const fileLabel = tool === "select" ? target.closest<HTMLElement>(".file-label") : null;
    if (fileLabel?.dataset.file) {
      const frames = model.roots.filter((id) => model.fileOf.get(id) === fileLabel.dataset.file);
      if (!frames.length) return;
      if (e.shiftKey) {
        const all = frames.every((id) => selection.includes(id));
        store().select(all ? selection.filter((id) => !frames.includes(id)) : [...new Set([...selection, ...frames])]);
        return;
      }
      store().select(frames);
      setDrag({ kind: "pending-move", start: point, id: frames[0]!, collapse: false });
      return;
    }

    const displayId = hitTest(e.clientX, e.clientY);

    if (tool === "frame" || tool === "rect") {
      const world = toWorld(e.clientX, e.clientY);
      setDrag({ kind: "draw", start: world, current: world, parentId: deepestFrameAt(displayId), tool });
      return;
    }

    if (tool === "text") {
      const parentId = deepestFrameAt(displayId);
      const world = toWorld(e.clientX, e.clientY);
      const current = store().model;
      const id = newId(current);
      const node: DesignNode = { type: "text", content: "Text", style: { "font-size": 16 } };
      const changes = parentId
        ? insertNodes({ model: current, entries: [{ root: { id, node: placeInParent(parentId, world, node) } }], parentId })
        : insertNodes({
            model: current,
            entries: [{ root: { id, node: { ...node, name: "Text", x: Math.round(world.x - dxOfFile(defaultFile(current))), y: Math.round(world.y) } as DesignNode } }],
            file: defaultFile(current),
          });
      void store().commit("Add text", changes).then(() => {
        store().select([id]);
        store().setTool("select");
        requestAnimationFrame(() => requestAnimationFrame(() => startTextEdit(id)));
      });
      return;
    }

    const id = displayId ? selectableId(displayId, e.ctrlKey || e.metaKey) : null;
    if (!id) {
      if (!e.shiftKey) store().select([]);
      setDrag({ kind: "marquee", start: point, current: point, additive: e.shiftKey });
      return;
    }

    if (e.shiftKey) {
      store().select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
      return;
    }
    // Like Figma: pressing inside a selected layer's box drags that layer, even over its children.
    // A click without a drag still selects the child under the pointer.
    if (!e.ctrlKey && !e.metaKey && !selection.includes(id)) {
      const box = container.current!.getBoundingClientRect();
      const local = { x: point.x - box.left, y: point.y - box.top };
      const holder = selection.find((selected) => {
        if (!isInside(id, selected)) return false;
        const rect = screenRect(selected);
        return !!rect && local.x >= rect.x && local.x <= rect.x + rect.w && local.y >= rect.y && local.y <= rect.y + rect.h;
      });
      if (holder) {
        setDrag({ kind: "pending-move", start: point, id: holder, collapse: false, clickSelects: id });
        return;
      }
    }
    if (!selection.includes(id)) store().select([id]);
    setDrag({ kind: "pending-move", start: point, id, collapse: selection.length > 1 && selection.includes(id) });
  };

  const placeInParent = (parentId: string, world: { x: number; y: number }, node: DesignNode): DesignNode => {
    const element = findElement(rootOf(model, parentId), parentId);
    const style = element ? getComputedStyle(element) : null;
    const flexOrGrid = !!style && (style.display.includes("flex") || style.display.includes("grid"));
    if (flexOrGrid || !element) return node;
    const box = element.getBoundingClientRect();
    const local = toWorld(box.left, box.top);
    return {
      ...node,
      style: { ...node.style, position: "absolute", left: Math.round(world.x - local.x), top: Math.round(world.y - local.y) },
    } as DesignNode;
  };

  const beginMove = (pending: Extract<Drag, { kind: "pending-move" }>, e: React.PointerEvent): Drag | null => {
    const ids = selection.length ? selection : [pending.id];
    if (ids.every((id) => model.nodes[id]?.parentId === undefined)) {
      return {
        kind: "move-roots",
        start: pending.start,
        ids,
        origins: Object.fromEntries(ids.map((id) => [id, { x: model.nodes[id]?.x ?? 0, y: model.nodes[id]?.y ?? 0 }])),
        startRects: Object.fromEntries(ids.map((id) => [id, screenRect(id)])),
        delta: { x: 0, y: 0 },
        guides: [],
      };
    }
    const parentId = model.nodes[ids[0]!]?.parentId;
    if (!parentId || ids.some((id) => model.nodes[id]?.parentId !== parentId)) return null;
    const id = ids[0]!;
    const node = model.nodes[id]!;
    const element = findElement(rootOf(model, id), id);
    if (ids.length === 1 && element && getComputedStyle(element).position === "absolute") {
      return {
        kind: "move-absolute",
        start: pending.start,
        id,
        origin: { left: numberOr(node.style?.left, element.offsetLeft), top: numberOr(node.style?.top, element.offsetTop) },
        delta: { x: 0, y: 0 },
      };
    }
    void e;
    const ordered = childrenOf(model, parentId).filter((sibling) => ids.includes(sibling));
    return { kind: "reorder", start: pending.start, ids: ordered, fromParent: parentId, parentId, beforeId: null, line: null };
  };

  const snapRoots = (ids: string[], dx: number, dy: number): { dx: number; dy: number; guides: Guide[] } => {
    const moving = ids.map((id) => {
      const rect = screenRect(id);
      const origin = (drag as Extract<Drag, { kind: "move-roots" }>).origins[id]!;
      return { x: origin.x + dxOf(id) + dx, y: origin.y + dy, w: (rect?.w ?? 0) / viewport.zoom, h: (rect?.h ?? 0) / viewport.zoom };
    });
    const others = model.roots
      .filter((id) => !ids.includes(id))
      .map((id) => {
        const rect = screenRect(id);
        const node = model.nodes[id]!;
        return { x: (node.x ?? 0) + dxOf(id), y: node.y ?? 0, w: (rect?.w ?? 0) / viewport.zoom, h: (rect?.h ?? 0) / viewport.zoom };
      });
    const threshold = 6 / viewport.zoom;
    let bestX: { d: number; at: number } | null = null;
    let bestY: { d: number; at: number } | null = null;
    for (const m of moving) {
      for (const o of others) {
        for (const a of [m.x, m.x + m.w / 2, m.x + m.w]) {
          for (const b of [o.x, o.x + o.w / 2, o.x + o.w]) {
            const d = b - a;
            if (Math.abs(d) < threshold && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: b };
          }
        }
        for (const a of [m.y, m.y + m.h / 2, m.y + m.h]) {
          for (const b of [o.y, o.y + o.h / 2, o.y + o.h]) {
            const d = b - a;
            if (Math.abs(d) < threshold && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: b };
          }
        }
      }
    }
    const guides: Guide[] = [];
    if (bestX) guides.push({ axis: "x", at: bestX.at });
    if (bestY) guides.push({ axis: "y", at: bestY.at });
    return { dx: dx + (bestX?.d ?? 0), dy: dy + (bestY?.d ?? 0), guides };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) {
      if (tool === "select" && !editingText) {
        const id = hitTest(e.clientX, e.clientY);
        const next = id ? selectableId(id, e.ctrlKey || e.metaKey) : null;
        if (next !== hover) store().setHover(next);
      }
      return;
    }
    const point = { x: e.clientX, y: e.clientY };
    switch (drag.kind) {
      case "pan":
        store().setViewport({ ...viewport, x: drag.origin.x + e.clientX - drag.startX, y: drag.origin.y + e.clientY - drag.startY });
        return;
      case "marquee":
        setDrag({ ...drag, current: point });
        return;
      case "pending-move": {
        if (Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < 4) return;
        const next = beginMove(drag, e);
        setDrag(next);
        return;
      }
      case "move-roots": {
        const raw = { x: (point.x - drag.start.x) / viewport.zoom, y: (point.y - drag.start.y) / viewport.zoom };
        const snapped = e.altKey ? { dx: raw.x, dy: raw.y, guides: [] } : snapRoots(drag.ids, raw.x, raw.y);
        setDrag({ ...drag, delta: { x: snapped.dx, y: snapped.dy }, guides: snapped.guides });
        return;
      }
      case "move-absolute": {
        const delta = { x: (point.x - drag.start.x) / viewport.zoom, y: (point.y - drag.start.y) / viewport.zoom };
        const element = findElement(rootOf(model, drag.id), drag.id);
        if (element) element.style.translate = `${delta.x}px ${delta.y}px`;
        setDrag({ ...drag, delta });
        return;
      }
      case "reorder": {
        const target = dropTargetAt(e.clientX, e.clientY, drag.ids);
        if (!target) {
          if (drag.line) setDrag({ ...drag, line: null });
          return;
        }
        const parentId = target;
        const parentElement = findElement(rootOf(model, parentId), parentId);
        const { axis } = isFlowParent(parentElement);
        const siblings = childrenOf(model, parentId).filter((id) => !drag.ids.includes(id));
        let beforeId: string | null = null;
        let line: Rect | null = null;
        for (const sibling of siblings) {
          const rect = screenRect(sibling);
          if (!rect) continue;
          const box = container.current!.getBoundingClientRect();
          const p = axis === "x" ? point.x - box.left : point.y - box.top;
          const mid = axis === "x" ? rect.x + rect.w / 2 : rect.y + rect.h / 2;
          if (p < mid) {
            beforeId = sibling;
            line = axis === "x" ? { x: rect.x - 2, y: rect.y, w: 2, h: rect.h } : { x: rect.x, y: rect.y - 2, w: rect.w, h: 2 };
            break;
          }
        }
        if (!line) {
          const last = siblings.at(-1);
          const rect = last ? screenRect(last) : screenRect(parentId);
          if (rect && last) line = axis === "x" ? { x: rect.x + rect.w, y: rect.y, w: 2, h: rect.h } : { x: rect.x, y: rect.y + rect.h, w: rect.w, h: 2 };
          else if (rect) line = axis === "x" ? { x: rect.x + 2, y: rect.y, w: 2, h: rect.h } : { x: rect.x, y: rect.y + 2, w: rect.w, h: 2 };
        }
        setDrag({ ...drag, parentId, beforeId, line });
        return;
      }
      case "resize": {
        const dx = (point.x - drag.start.x) / viewport.zoom;
        const dy = (point.y - drag.start.y) / viewport.zoom;
        let w = drag.origin.w / viewport.zoom;
        let h = drag.origin.h / viewport.zoom;
        if (drag.handle.includes("e")) w += dx;
        if (drag.handle.includes("w")) w -= dx;
        if (drag.handle.includes("s")) h += dy;
        if (drag.handle.includes("n")) h -= dy;
        const moved = drag.moved || Math.hypot(point.x - drag.start.x, point.y - drag.start.y) >= 2;
        setDrag({ ...drag, moved, size: moved ? { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) } : drag.size });
        return;
      }
      case "draw":
        setDrag({ ...drag, current: toWorld(e.clientX, e.clientY) });
        return;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    container.current?.releasePointerCapture(e.pointerId);
    const current = drag;
    draggedRecently.current = !!current && current.kind !== "pending-move" && current.kind !== "marquee";
    setDrag(null);
    if (!current) return;
    const m = store().model;
    switch (current.kind) {
      case "marquee": {
        const box = normalise(current.start, current.current, container.current!.getBoundingClientRect());
        if (box.w < 3 && box.h < 3) return;
        const contains = (rect: Rect) => rect.x >= box.x && rect.y >= box.y && rect.x + rect.w <= box.x + box.w && rect.y + rect.h <= box.y + box.h;
        const touches = (rect: Rect) => rect.x < box.x + box.w && rect.x + rect.w > box.x && rect.y < box.y + box.h && rect.y + rect.h > box.y;
        const picked: string[] = [];
        for (const rootId of m.roots) {
          const rect = screenRect(rootId);
          if (!rect || !touches(rect) || m.nodes[rootId]?.locked) continue;
          if (contains(rect)) picked.push(rootId);
          else picked.push(...childrenOf(m, rootId).filter((child) => { const r = screenRect(child); return !!r && touches(r) && !m.nodes[child]?.locked; }));
        }
        store().select(current.additive ? [...selection, ...picked] : picked);
        return;
      }
      case "move-roots": {
        if (current.delta.x === 0 && current.delta.y === 0) return;
        void store().commit(
          "Move",
          current.ids.map((id) => ({
            file: m.fileOf.get(id)!,
            id,
            node: { ...m.nodes[id]!, x: Math.round(current.origins[id]!.x + current.delta.x), y: Math.round(current.origins[id]!.y + current.delta.y) } as DesignNode,
          })),
        );
        return;
      }
      case "move-absolute":
        findElement(rootOf(m, current.id), current.id)?.style.removeProperty("translate");
        if (current.delta.x === 0 && current.delta.y === 0) return;
        void store().commit(
          "Move",
          setStyle(m, [current.id], {
            left: Math.round(current.origin.left + current.delta.x),
            top: Math.round(current.origin.top + current.delta.y),
          }),
        );
        return;
      case "pending-move":
        if (current.clickSelects) store().select([current.clickSelects]);
        else if (current.collapse) store().select([current.id]);
        return;
      case "reorder": {
        if (!current.line) return;
        if (current.parentId === current.fromParent) {
          const siblings = childrenOf(m, current.parentId);
          const last = current.ids.at(-1)!;
          const after = siblings[siblings.indexOf(last) + 1] ?? null;
          const contiguous = current.ids.every((id, i) => siblings.indexOf(id) === siblings.indexOf(current.ids[0]!) + i);
          if (contiguous && (current.beforeId === after || current.ids.includes(current.beforeId ?? ""))) return;
        }
        const changes = reparentMany({ model: m, ids: current.ids, parentId: current.parentId, beforeId: current.beforeId });
        if (changes.length) void store().commit(current.parentId === current.fromParent ? "Reorder" : "Move into frame", changes);
        return;
      }
      case "resize": {
        if (!current.moved) return;
        const { w, h } = current.size;
        const dw = w - current.origin.w / viewport.zoom;
        const dh = h - current.origin.h / viewport.zoom;
        const values: Record<string, number> = {};
        if (current.handle.includes("e") || current.handle.includes("w")) values.width = w;
        if (current.handle.includes("n") || current.handle.includes("s")) values.height = h;
        const changes = setStyle(m, [current.id], values);
        const node = changes[0]?.node;
        if (node && current.isRoot) {
          if (current.handle.includes("w")) node.x = Math.round((node.x ?? 0) - dw);
          if (current.handle.includes("n")) node.y = Math.round((node.y ?? 0) - dh);
        } else if (node && current.absolute) {
          node.style = { ...node.style };
          if (current.handle.includes("w")) node.style.left = Math.round(current.originPos.left - dw);
          if (current.handle.includes("n")) node.style.top = Math.round(current.originPos.top - dh);
        }
        void store().commit("Resize", changes);
        return;
      }
      case "draw": {
        const x = Math.min(current.start.x, current.current.x);
        const y = Math.min(current.start.y, current.current.y);
        let w = Math.abs(current.current.x - current.start.x);
        let h = Math.abs(current.current.y - current.start.y);
        if (w < 4 && h < 4) {
          w = current.parentId ? 100 : 390;
          h = current.parentId ? 100 : 844;
        }
        const id = newId(m);
        const background = tokens?.tokens["color.background"] ? "{color.background}" : "#ffffff";
        const fill = tokens?.tokens["color.muted"] ? "{color.muted}" : "#e5e5e5";
        const base: DesignNode = {
          type: "frame",
          name: current.tool === "rect" ? "Rectangle" : "Frame",
          style: { width: Math.round(w), height: Math.round(h), background: current.parentId || current.tool === "rect" ? fill : background },
        };
        const changes = current.parentId
          ? insertNodes({ model: m, entries: [{ root: { id, node: placeInParent(current.parentId, { x, y }, base) } }], parentId: current.parentId })
          : insertNodes({ model: m, entries: [{ root: { id, node: { ...base, x: Math.round(x - dxOfFile(defaultFile(m))), y: Math.round(y) } as DesignNode } }], file: defaultFile(m) });
        void store().commit("Draw frame", changes).then(() => {
          store().select([id]);
          store().setTool("select");
        });
        return;
      }
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).dataset.handle || draggedRecently.current) return;
    const displayId = hitTest(e.clientX, e.clientY);
    if (!displayId) return;
    const id = baseId(displayId);
    const chain = chainOf(id);
    const scoped = selectableId(displayId);
    if (!scoped || isLocked(model, id)) return;
    const deeper = chain[chain.indexOf(scoped) + 1];
    if (selection.includes(scoped) && deeper) {
      store().select([deeper]);
      if (deeper === id && model.nodes[id]?.type === "text" && !displayId.includes("/")) startTextEdit(displayId);
      return;
    }
    if (displayId.includes("/")) {
      const inner = displayId.split("/").at(-1)!;
      if (model.nodes[inner]?.type === "text") startTextEdit(displayId);
      return;
    }
    if (model.nodes[id]?.type === "text") startTextEdit(displayId);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const displayId = hitTest(e.clientX, e.clientY);
    if (displayId) {
      const id = selectableId(displayId);
      if (id && !selection.includes(id)) store().select([id]);
    }
    store().setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const cursor =
    drag?.kind === "pan" || tool === "hand" || space ? (drag?.kind === "pan" ? "grabbing" : "grab") : tool === "frame" || tool === "rect" ? "crosshair" : tool === "text" ? "text" : "default";

  const frameOffset = (id: string) => {
    if (drag?.kind === "move-roots" && drag.ids.includes(id)) return drag.delta;
    return { x: 0, y: 0 };
  };

  const overlay: React.ReactNode[] = [];
  /** While frames are dragged their DOM already moves, so draw from where the drag started. */
  const liveRect = (id: string): Rect | null => {
    if (drag?.kind === "move-roots" && drag.ids.includes(id)) {
      const start = drag.startRects[id];
      return start ? { ...start, x: start.x + drag.delta.x * viewport.zoom, y: start.y + drag.delta.y * viewport.zoom } : null;
    }
    return screenRect(id);
  };
  const selectionRects = selection.map((id) => [id, liveRect(id)] as const);
  if (hover && !selection.includes(hover) && !drag) {
    const rect = screenRect(hover);
    if (rect) overlay.push(<div key="hover" className="ov-hover" style={rectStyle(rect)} />);
  }
  for (const [id, until] of Object.entries(flash)) {
    if (until < Date.now()) continue;
    const rect = screenRect(id);
    if (rect) overlay.push(<div key={`flash-${id}`} className="ov-flash" style={rectStyle(rect)} />);
  }
  for (const [id, rect] of selectionRects) {
    if (!rect) continue;
    let shown = rect;
    if (drag?.kind === "resize" && drag.id === id) {
      const w = drag.size.w * viewport.zoom;
      const h = drag.size.h * viewport.zoom;
      shown = {
        x: drag.handle.includes("w") ? rect.x + rect.w - w : rect.x,
        y: drag.handle.includes("n") ? rect.y + rect.h - h : rect.y,
        w,
        h,
      };
    }
    overlay.push(<div key={`sel-${id}`} className="ov-selection" style={rectStyle(shown)} />);
    if (selection.length === 1 && !editingText && !isLocked(model, id)) {
      for (const handle of HANDLES) {
        overlay.push(<div key={`h-${handle}`} data-handle={handle} className={`ov-handle ov-handle-${handle}`} style={handleStyle(shown, handle)} />);
      }
      const node = model.nodes[id];
      const w = drag?.kind === "resize" ? drag.size.w : Math.round(rect.w / viewport.zoom);
      const h = drag?.kind === "resize" ? drag.size.h : Math.round(rect.h / viewport.zoom);
      overlay.push(
        <div key="size" className="ov-size" style={{ left: shown.x + shown.w / 2, top: shown.y + shown.h + 8 }}>
          {w} × {h}
          {node?.type === "instance" ? " · instance" : ""}
        </div>,
      );
    }
  }
  if (selection.length > 1) {
    const rects = selectionRects.map(([, r]) => r).filter((r): r is Rect => !!r);
    if (rects.length) {
      const x = Math.min(...rects.map((r) => r.x));
      const y = Math.min(...rects.map((r) => r.y));
      const right = Math.max(...rects.map((r) => r.x + r.w));
      const bottom = Math.max(...rects.map((r) => r.y + r.h));
      overlay.push(
        <div key="multi" className="ov-size" style={{ left: (x + right) / 2, top: bottom + 8 }}>
          {selection.length} layers
        </div>,
      );
    }
  }
  if (drag?.kind === "marquee") {
    overlay.push(<div key="marquee" className="ov-marquee" style={rectStyle(normalise(drag.start, drag.current, container.current!.getBoundingClientRect()))} />);
  }
  if (drag?.kind === "reorder" && drag.line) {
    overlay.push(<div key="drop" className="ov-drop" style={rectStyle(drag.line)} />);
    const target = drag.parentId !== drag.fromParent ? screenRect(drag.parentId) : null;
    if (target) overlay.push(<div key="drop-target" className="ov-hover" style={rectStyle(target)} />);
  }
  if (drag?.kind === "move-roots") {
    for (const guide of drag.guides) {
      const at = guide.at * viewport.zoom + (guide.axis === "x" ? viewport.x : viewport.y);
      overlay.push(
        <div key={`g-${guide.axis}-${guide.at}`} className="ov-guide" style={guide.axis === "x" ? { left: at, top: 0, width: 1, bottom: 0 } : { top: at, left: 0, height: 1, right: 0 }} />,
      );
    }
  }
  if (drag?.kind === "draw") {
    const a = { x: drag.start.x * viewport.zoom + viewport.x, y: drag.start.y * viewport.zoom + viewport.y };
    const b = { x: drag.current.x * viewport.zoom + viewport.x, y: drag.current.y * viewport.zoom + viewport.y };
    const rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    overlay.push(<div key="draw" className="ov-selection" style={rectStyle(rect)} />);
    overlay.push(
      <div key="draw-size" className="ov-size" style={{ left: rect.x + rect.w / 2, top: rect.y + rect.h + 8 }}>
        {Math.round(rect.w / viewport.zoom)} × {Math.round(rect.h / viewport.zoom)}
      </div>,
    );
  }

  if (!tokens) return <div className="canvas" ref={container} />;

  return (
    <div
      ref={container}
      className="canvas"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !drag && store().setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      data-testid="canvas"
    >
      <div className="canvas-grid" style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px` }} />
      <div className="world" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}>
        {[...regions.values()].map((region) => {
          const screenRoom = Number.isFinite(region.room) ? region.room * viewport.zoom - FILE_LABEL_GAP : undefined;
          return (
            <div
              key={region.file}
              className={cn("file-label", {
                "is-selected": selection.length > 0 && model.roots.filter((id) => model.fileOf.get(id) === region.file).every((id) => selection.includes(id)),
                "is-cramped": screenRoom !== undefined && screenRoom < LABEL_MIN_WIDTH,
              })}
              data-file={region.file}
              title={`${region.file} · click to select its frames, drag to move them`}
              style={{ left: region.left, top: region.top - 40 / viewport.zoom - 24, transform: `scale(${1 / viewport.zoom})`, maxWidth: screenRoom }}
            >
              <FileJson size={13} className="file-label-icon" aria-hidden />
              <span className="file-label-name">{region.file.split("/").pop()}</span>
            </div>
          );
        })}
        {model.roots.map((id) => {
          const node = model.nodes[id]!;
          const offset = frameOffset(id);
          const declaredWidth = parseFloat(String(node.style?.width ?? ""));
          const width = (shadowRoots.get(id)?.host as HTMLElement | undefined)?.offsetWidth || (Number.isFinite(declaredWidth) ? declaredWidth : undefined);
          const screenWidth = width === undefined ? undefined : width * viewport.zoom;
          return (
            <div key={id} className="frame-slot" style={{ left: (node.x ?? 0) + dxOf(id) + offset.x, top: (node.y ?? 0) + offset.y }}>
              {node.type !== "text" && (
                <div
                  className={cn("frame-label", {
                    "is-selected": selection.includes(id),
                    "is-cramped": (screenWidth !== undefined && screenWidth < LABEL_MIN_WIDTH) || (labelRoom.get(id) ?? Infinity) * viewport.zoom < LABEL_HEIGHT,
                  })}
                  data-label-for={id}
                  title={nodeTitle(id, node)}
                  style={{ transform: `scale(${1 / viewport.zoom}) translate(-${LABEL_INSET}px, -${LABEL_GAP}px)`, maxWidth: screenWidth === undefined ? undefined : screenWidth + 2 * LABEL_INSET }}
                >
                  <span className="frame-label-name">
                    {node.type === "frame" && node.component ? "◇ " : ""}
                    {nodeTitle(id, node)}
                  </span>
                  {showsPlay(node, viewport.zoom) && (
                    <button
                      className="frame-label-play"
                      aria-label={`Preview ${nodeTitle(id, node)}`}
                      title="Preview animations  P"
                      data-testid="frame-label-play"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => useEditor.getState().openPreview([id])}
                    >
                      <Play size={10} />
                    </button>
                  )}
                </div>
              )}
              <FrameView
                id={id}
                nodes={model.nodes}
                childIds={model.children}
                tokens={tokens}
                icons={icons}
                canvasMode={canvasMode}
                componentProps={previewProps[id]}
                fileCss={model.fileCss}
                version={renderVersion}
                frozen={!!editingText && rootOf(model, baseId(editingText)) === id}
              />
            </div>
          );
        })}
      </div>
      <div className="overlay">{overlay}</div>
      {model.roots.length === 0 && <EmptyCanvas />}
    </div>
  );
});

/** One wheel notch zooms ~1.2×; trackpad pinches (many small deltas) zoom smoothly. */
const NOTCH_STEP = Math.log(1.2);
function zoomFactor(e: WheelEvent): number {
  const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * 400 : e.deltaY;
  if (Math.abs(pixels) >= 50) return Math.exp(-Math.sign(pixels) * NOTCH_STEP);
  return Math.exp(-pixels * 0.01);
}

function defaultFile(model: Model): string {
  const state = useEditor.getState();
  const selected = state.selection[0];
  if (selected && model.fileOf.get(selected)) return model.fileOf.get(selected)!;
  return firstOpenFile(state) ?? `${state.snapshot?.config.designs[0]?.split("/")[0] ?? "designs"}/main.lamsa.json`;
}

function EmptyCanvas() {
  const setTool = useEditor((s) => s.setTool);
  const showPanel = useEditor((s) => s.showPanel);
  const noneOpen = useEditor((s) => s.openFiles !== null && s.openFiles.length === 0 && Object.keys(s.files).length > 0);
  if (useEditor.getState().openFiles === null) return null;
  if (noneOpen) {
    return (
      <div className="empty-canvas">
        <div className="empty-card" data-testid="no-files-open" onPointerDown={(e) => e.stopPropagation()}>
          <div className="empty-icon">⌗</div>
          <div className="title">No files open</div>
          <p>Open one of this project's design files, or pick one from anywhere on disk.</p>
          <div className="empty-actions">
            <AddFileMenu appearance="primary" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="empty-canvas">
      <div className="empty-card" onPointerDown={(e) => e.stopPropagation()}>
        <div className="empty-icon">⌗</div>
        <div className="title">This file is empty</div>
        <p>Draw a frame to start, or ask your agent to design something.</p>
        <div className="empty-actions">
          <button className="btn btn-accent" onClick={() => setTool("frame")}>
            Draw a frame <kbd>F</kbd>
          </button>
          <button className="btn" onClick={() => showPanel("agent")}>
            Ask your agent <kbd>{shortcut("mod+j")}</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function normalise(a: { x: number; y: number }, b: { x: number; y: number }, box: DOMRect): Rect {
  return {
    x: Math.min(a.x, b.x) - box.left,
    y: Math.min(a.y, b.y) - box.top,
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function rectStyle(rect: Rect): React.CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
}

function handleStyle(rect: Rect, handle: Handle): React.CSSProperties {
  const x = handle.includes("w") ? rect.x : handle.includes("e") ? rect.x + rect.w : rect.x + rect.w / 2;
  const y = handle.includes("n") ? rect.y : handle.includes("s") ? rect.y + rect.h : rect.y + rect.h / 2;
  return { left: x, top: y };
}
