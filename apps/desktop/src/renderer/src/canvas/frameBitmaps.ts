import { create } from "zustand";
import { api, useEditor } from "../lib/store";
import { localFontCss, shadowRoots } from "./FrameView";

/**
 * Below this zoom the canvas shows each frame as a bitmap instead of its live DOM. 16px body text is then under 4px
 * tall on screen, too small to read, while a large design's live DOM (tens of thousands of elements) makes every pan
 * and zoom step repaint and re-layer all of it, which at this distance is all of it on screen at once.
 */
export const BITMAP_ZOOM = 0.25;
/** Bitmaps start drawing at this zoom, so zooming out past BITMAP_ZOOM usually finds them ready. */
export const PREPARE_ZOOM = BITMAP_ZOOM * 2;
/** Keeps one very large frame from taking a huge bitmap: it gets a lower resolution instead. */
const MAX_SIDE = 4096;
/** Text styles a frame inherits from the canvas around it, which the snapshot page has to repeat. */
const INHERITED = ["font-size", "font-weight", "font-style", "letter-spacing", "word-spacing", "text-align", "text-transform", "white-space", "direction"];

export interface FrameBitmap {
  url: string;
  /** The frame's size in CSS pixels when it was drawn. */
  width: number;
  height: number;
}

export const useFrameBitmaps = create<{
  /** Bitmaps of the frames whose current render has been drawn; a frame that renders again loses its bitmap. */
  bitmaps: Record<string, FrameBitmap>;
  /** Bitmaps are being drawn, so frames will still swap to them. */
  drawing: boolean;
}>(() => ({ bitmaps: {}, drawing: false }));

/** How many times each frame has rendered, so a bitmap drawn from an older render is thrown away. */
const renders = new Map<string, number>();
const pending = new Set<string>();
let preparing = false;

function drop(id: string) {
  const bitmap = useFrameBitmaps.getState().bitmaps[id];
  if (!bitmap) return;
  URL.revokeObjectURL(bitmap.url);
  useFrameBitmaps.setState(({ bitmaps }) => {
    const { [id]: _dropped, ...rest } = bitmaps;
    return { bitmaps: rest };
  });
}

/** FrameView calls this after rendering a frame anew. */
export function frameRendered(id: string) {
  renders.set(id, (renders.get(id) ?? 0) + 1);
  drop(id);
  if (!preparing) return;
  pending.add(id);
  void drawPending();
}

export function frameRemoved(id: string) {
  renders.delete(id);
  pending.delete(id);
  drop(id);
}

/** Draws bitmaps for every frame that lacks one while `on`; stops drawing otherwise. Cached bitmaps stay either way. */
export function prepareBitmaps(on: boolean) {
  preparing = on;
  pending.clear();
  if (!on) return;
  const { bitmaps } = useFrameBitmaps.getState();
  for (const id of shadowRoots.keys()) if (!bitmaps[id]) pending.add(id);
  void drawPending();
}

/** The pending frame nearest the middle of the canvas, so what's on screen is drawn first. */
function nextPending(): string {
  const canvas = document.querySelector(".canvas")?.getBoundingClientRect();
  let best = pending.values().next().value as string;
  if (!canvas) return best;
  const middle = { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 };
  let bestDistance = Infinity;
  for (const id of pending) {
    const box = shadowRoots.get(id)?.host.getBoundingClientRect();
    if (!box) continue;
    const distance = Math.hypot(Math.max(box.left - middle.x, 0, middle.x - box.right), Math.max(box.top - middle.y, 0, middle.y - box.bottom));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = id;
    }
  }
  return best;
}

async function drawPending() {
  if (useFrameBitmaps.getState().drawing) return;
  useFrameBitmaps.setState({ drawing: true });
  try {
    while (preparing && pending.size) {
      const id = nextPending();
      pending.delete(id);
      await draw(id);
    }
  } finally {
    useFrameBitmaps.setState({ drawing: false });
  }
}

async function draw(id: string) {
  const root = shadowRoots.get(id);
  const host = root?.host as HTMLElement | undefined;
  const snapshot = useEditor.getState().snapshot;
  if (!root || !host?.isConnected || !snapshot) return;
  const render = renders.get(id);
  const width = host.offsetWidth;
  const height = host.offsetHeight;
  if (!width || !height) return;
  const style = getComputedStyle(host);
  try {
    const png = await api().frameSnapshot({
      html: root.innerHTML,
      fontCss: localFontCss(snapshot.fontCss),
      fontLinks: snapshot.fontLinks,
      width,
      height,
      scale: Math.min(BITMAP_ZOOM * devicePixelRatio, MAX_SIDE / Math.max(width, height)),
      inherited: Object.fromEntries(INHERITED.map((property) => [property, style.getPropertyValue(property)])),
    });
    // The frame changed while it was being drawn; its new render is already queued.
    if (!png || renders.get(id) !== render || !shadowRoots.has(id)) return;
    const url = URL.createObjectURL(new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }));
    const image = new Image();
    image.src = url;
    // Decoded before it's shown, so swapping the live frame for it never flashes an empty box.
    await image.decode();
    if (renders.get(id) !== render) {
      URL.revokeObjectURL(url);
      return;
    }
    drop(id);
    useFrameBitmaps.setState(({ bitmaps }) => ({ bitmaps: { ...bitmaps, [id]: { url, width, height } } }));
  } catch {
    // No bitmap: the frame keeps showing its live DOM.
  }
}
