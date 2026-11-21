import type { CommentThread } from "@lamsa/schema";
import { Check, Plus } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import { avatarOf, isOpen, matchesFilter, useComments, worldTransform } from "../lib/comments";
import { cn } from "../lib/cn";
import { rootOf, type Model } from "../lib/model";
import { useEditor, type Viewport } from "../lib/store";
import { Composer, ThreadView } from "../panels/comments/Thread";
import { findElement } from "./FrameView";

const DRAFT = "\u0000draft";

interface Target {
  key: string;
  nodeId: string;
  offset?: { x: number; y: number };
}

type Box = { x: number; y: number; w: number; h: number };
/** A pin's point and the box of the layer it's on, both in world pixels. */
type Point = { x: number; y: number; layer: Box };
type Points = Map<string, Point>;

/** The node's box in world pixels, or its nearest rendered ancestor's (a hidden layer has no box). */
function worldBox({ model, nodeId, transform }: { model: Model; nodeId: string; transform: { origin: DOMRect; zoom: number } }) {
  let current: string | undefined = nodeId;
  while (current) {
    const rect = findElement(rootOf(model, current), current)?.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      const { origin, zoom } = transform;
      return { x: (rect.left - origin.left) / zoom, y: (rect.top - origin.top) / zoom, w: rect.width / zoom, h: rect.height / zoom, exact: current === nodeId };
    }
    current = model.nodes[current]?.parentId;
  }
  return null;
}

/** Where each pin goes, in world pixels: its offset inside the layer (kept inside it if the layer shrank), else the layer's top-right corner. */
function measure(targets: Target[]): Points {
  const points: Points = new Map();
  if (targets.length === 0) return points;
  const transform = worldTransform();
  if (!transform) return points;
  const { model } = useEditor.getState();
  const shownRoots = new Set(model.roots);
  for (const target of targets) {
    if (!model.nodes[target.nodeId] || !shownRoots.has(rootOf(model, target.nodeId))) continue;
    const box = worldBox({ model, nodeId: target.nodeId, transform });
    if (!box) continue;
    const offset = box.exact ? target.offset : undefined;
    const layer = { x: box.x, y: box.y, w: box.w, h: box.h };
    points.set(
      target.key,
      offset ? { x: box.x + Math.min(Math.max(offset.x, 0), box.w), y: box.y + Math.min(Math.max(offset.y, 0), box.h), layer } : { x: box.x + box.w, y: box.y, layer },
    );
  }
  return points;
}

const sameBox = (a: Box, b: Box) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const samePoints = (a: Points, b: Points) =>
  a.size === b.size &&
  [...a].every(([key, point]) => {
    const other = b.get(key);
    return other?.x === point.x && other.y === point.y && sameBox(other.layer, point.layer);
  });

const at = (point: { x: number; y: number }) => ({ "--wx": point.x, "--wy": point.y }) as CSSProperties;

/** Panning moves the pins' wrapper as a whole (a transform restyles nothing inside it); only a zoom restyles each pin. */
function applyViewport(pins: HTMLElement, { x, y, zoom }: Viewport) {
  pins.style.transform = `translate(${x}px, ${y}px)`;
  if (pins.style.getPropertyValue("--zoom") !== String(zoom)) pins.style.setProperty("--zoom", String(zoom));
}

/**
 * Closes the open thread or draft on a press outside it (a press on a pin switches threads instead) and on Escape.
 * The press still reaches the canvas, so a click elsewhere in comment mode starts the next comment right away.
 */
function useDismissComments(open: boolean) {
  useEffect(() => {
    if (!open) return;
    const close = () => useComments.setState({ active: null, draft: null });
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target?.closest(".comment-card, .comment-pin, [data-comment-row]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
}

function Pin({ thread, point, active }: { thread: CommentThread; point: { x: number; y: number }; active: boolean }) {
  const { initial, tone } = avatarOf(thread.author);
  const resolved = !isOpen(thread);
  return (
    <button
      className={cn("comment-pin", `tone-${tone}`, { "is-active": active, "is-resolved": resolved })}
      style={at(point)}
      aria-label={`Comment by ${thread.author}: ${thread.text}`}
      title={thread.text}
      data-testid="comment-pin"
      data-comment-id={thread.id}
      data-state={resolved ? "resolved" : "open"}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerEnter={() => useEditor.getState().setHover(thread.nodeId)}
      onPointerLeave={() => useEditor.getState().setHover(null)}
      onClick={() => useComments.getState().setActive(active ? null : thread.id)}
    >
      {resolved ? <Check size={14} /> : initial}
    </button>
  );
}

const CARD_GAP = 12;
const EDGE = 8;

const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const rectBox = (rect: DOMRect): Box => ({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });

/** The part of the canvas no floating bar or docked panel covers, in canvas pixels. */
function openArea(canvas: HTMLElement): Box {
  const bounds = canvas.getBoundingClientRect();
  let left = bounds.left + EDGE;
  let right = bounds.right - EDGE;
  let top = bounds.top + EDGE;
  let bottom = bounds.bottom - EDGE;
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="dock-"][data-dock], .bar'))) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const dock = element.dataset.dock;
    if (dock === "left") left = Math.max(left, rect.right + EDGE);
    else if (dock === "right") right = Math.min(right, rect.left - EDGE);
    else if (dock === "centre") bottom = Math.min(bottom, rect.top - EDGE);
    else top = Math.max(top, rect.bottom + EDGE);
  }
  return { x: left - bounds.left, y: top - bounds.top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}

/**
 * Where a card goes, in canvas pixels: beside the commented layer (right, then left, then below, then above) so the
 * card never hides what the comment is about, inside the open part of the canvas and clear of toasts. A layer too big
 * to sit beside falls back to beside the pin.
 */
function placeCard({ card, point, viewport }: { card: HTMLElement; point: Point; viewport: Viewport }) {
  const canvas = card.closest<HTMLElement>(".canvas");
  if (!canvas) return;
  const origin = canvas.getBoundingClientRect();
  const area = openArea(canvas);
  card.style.maxHeight = `${area.h}px`;
  const w = card.offsetWidth;
  const h = Math.min(card.offsetHeight, area.h);
  const toScreen = (x: number, y: number) => ({ x: viewport.x + x * viewport.zoom, y: viewport.y + y * viewport.zoom });
  const pin = toScreen(point.x, point.y);
  const corner = toScreen(point.layer.x, point.layer.y);
  const layer = { x: corner.x, y: corner.y, w: point.layer.w * viewport.zoom, h: point.layer.h * viewport.zoom };
  const toasts = document.querySelector(".toasts")?.getBoundingClientRect();
  const avoid = [layer, ...(toasts && toasts.height > 0 ? [rectBox(toasts)].map((box) => ({ ...box, x: box.x - origin.left, y: box.y - origin.top })) : [])];

  const clampX = (x: number) => Math.min(Math.max(x, area.x), area.x + area.w - w);
  const clampY = (y: number) => Math.min(Math.max(y, area.y), area.y + area.h - h);
  const besideY = clampY(pin.y - 28);
  const candidates = [
    { x: layer.x + layer.w + CARD_GAP, y: besideY },
    { x: layer.x - CARD_GAP - w, y: besideY },
    { x: clampX(pin.x - 28), y: layer.y + layer.h + CARD_GAP },
    { x: clampX(pin.x - 28), y: layer.y - CARD_GAP - h },
  ];
  const fits = (box: Box) => box.x >= area.x && box.y >= area.y && box.x + box.w <= area.x + area.w && box.y + box.h <= area.y + area.h;
  const spot =
    candidates.map((c) => ({ ...c, w, h })).find((box) => fits(box) && !avoid.some((other) => overlaps(box, other))) ??
    candidates.map((c) => ({ ...c, w, h })).find((box) => fits(box) && !overlaps(box, layer)) ?? {
      x: clampX(pin.x + 36 + w <= area.x + area.w ? pin.x + 36 : pin.x - 36 - w),
      y: besideY,
    };
  card.style.left = `${Math.round(spot.x)}px`;
  card.style.top = `${Math.round(spot.y)}px`;
}

/** A card beside its layer; wheel turns inside it scroll the card instead of panning the canvas. */
function Card({ point, children, testId }: { point: Point; children: React.ReactNode; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const stop = (e: WheelEvent) => e.stopPropagation();
    element.addEventListener("wheel", stop, { passive: true });
    return () => element.removeEventListener("wheel", stop);
  }, []);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const place = () => placeCard({ card, point, viewport: useEditor.getState().viewport });
    place();
    const off = useEditor.subscribe((state, previous) => {
      if (state.viewport !== previous.viewport || state.toasts !== previous.toasts) place();
    });
    // Its own height changes as replies arrive; docks and the window change the room it has.
    const observer = new ResizeObserver(place);
    observer.observe(card);
    const canvas = card.closest(".canvas");
    if (canvas) observer.observe(canvas);
    for (const dock of Array.from(document.querySelectorAll('[data-testid^="dock-"][data-dock]'))) observer.observe(dock);
    return () => {
      off();
      observer.disconnect();
    };
  }, [point]);
  return (
    <div
      ref={ref}
      className="comment-card"
      data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

/**
 * Comment pins over the canvas. Pins are measured from the rendered layers only when the design, the comments or the
 * frames' sizes change; panning and zooming just update three custom properties on this layer.
 */
export const CommentLayer = memo(function CommentLayer() {
  const pinLayer = useRef<HTMLDivElement>(null);
  const { threads, model } = useEditor(useShallow((s) => ({ threads: s.comments, model: s.model })));
  const { filter, active, draft } = useComments(useShallow((s) => ({ filter: s.filter, active: s.active, draft: s.draft })));
  const shown = useMemo(() => threads.filter((thread) => matchesFilter(thread, filter) || thread.id === active), [threads, filter, active]);
  const [points, setPoints] = useState<Points>(() => new Map());

  useLayoutEffect(() => {
    const pins = pinLayer.current;
    if (!pins) return;
    applyViewport(pins, useEditor.getState().viewport);
    return useEditor.subscribe((state, previous) => {
      if (state.viewport !== previous.viewport) applyViewport(pins, state.viewport);
    });
  }, []);

  useEffect(() => {
    const targets: Target[] = shown.map((thread) => ({ key: thread.id, nodeId: thread.nodeId, offset: thread.offset }));
    if (draft) targets.push({ key: DRAFT, nodeId: draft.nodeId, offset: draft.offset });
    let frame = 0;
    const update = () => {
      const next = measure(targets);
      setPoints((current) => (samePoints(current, next) ? current : next));
    };
    // Two frames: the canvas draws changed frames in the first.
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(update);
      });
    };
    schedule();
    if (targets.length === 0) return () => cancelAnimationFrame(frame);
    const off = useEditor.subscribe((state, previous) => {
      if (state.renderVersion !== previous.renderVersion || state.canvasMode !== previous.canvasMode || state.previewProps !== previous.previewProps) schedule();
    });
    const observer = new ResizeObserver(schedule);
    for (const host of Array.from(document.querySelectorAll(".canvas .frame-host"))) observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      off();
      observer.disconnect();
    };
  }, [shown, draft, model]);

  useDismissComments(!!active || !!draft);

  const activeThread = active ? shown.find((thread) => thread.id === active) : undefined;
  const activePoint = activeThread ? points.get(activeThread.id) : undefined;
  const draftPoint = draft ? points.get(DRAFT) : undefined;

  return (
    <div className="comment-layer" data-testid="comment-layer">
      <div ref={pinLayer} className="comment-pins">
        {shown.map((thread) => {
          const point = points.get(thread.id);
          return point ? <Pin key={thread.id} thread={thread} point={point} active={thread.id === active} /> : null;
        })}
        {draft && draftPoint && <DraftPin point={draftPoint} />}
      </div>
      <div className="comment-cards">
        {activeThread && activePoint && (
          <Card point={activePoint} testId="comment-popover">
            <ThreadView thread={activeThread} onClose={() => useComments.getState().setActive(null)} />
          </Card>
        )}
        {draft && draftPoint && (
          <Card point={draftPoint} testId="comment-draft">
            <Composer key={draft.nodeId + draft.offset.x + draft.offset.y} draft={draft} />
          </Card>
        )}
      </div>
    </div>
  );
});

function DraftPin({ point }: { point: { x: number; y: number } }) {
  return (
    <span className="comment-pin is-draft" style={at(point)} data-testid="comment-draft-pin">
      <Plus size={14} />
    </span>
  );
}
