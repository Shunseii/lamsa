import { findElement } from "../canvas/FrameView";
import { rootOf } from "./model";
import { useEditor } from "./store";

function canvasBox(): DOMRect | undefined {
  return document.querySelector(".canvas")?.getBoundingClientRect();
}

export function zoomTo(zoom: number) {
  const { viewport, setViewport } = useEditor.getState();
  const box = canvasBox();
  const cx = (box?.width ?? 1200) / 2;
  const cy = (box?.height ?? 800) / 2;
  setViewport({ zoom, x: cx - ((cx - viewport.x) * zoom) / viewport.zoom, y: cy - ((cy - viewport.y) * zoom) / viewport.zoom });
}

export function zoomBy(factor: number) {
  const zoom = Math.min(8, Math.max(0.05, useEditor.getState().viewport.zoom * factor));
  zoomTo(zoom);
}

export function fitTo(target: "all" | "selection") {
  const { model, selection, viewport, setViewport, panels } = useEditor.getState();
  const box = canvasBox();
  if (!box) return;
  const ids = target === "selection" && selection.length ? selection : model.roots;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const id of ids) {
    const element = findElement(rootOf(model, id), id);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    const x = (rect.left - box.left - viewport.x) / viewport.zoom;
    const y = (rect.top - box.top - viewport.y) / viewport.zoom;
    left = Math.min(left, x);
    top = Math.min(top, y - 24 / viewport.zoom);
    right = Math.max(right, x + rect.width / viewport.zoom);
    bottom = Math.max(bottom, y + rect.height / viewport.zoom);
  }
  if (!Number.isFinite(left)) return;
  const insetLeft = panels.layers ? 290 : 24;
  const insetRight = panels.properties ? 330 : 24;
  const insetTop = 80;
  const insetBottom = panels.terminal ? 360 : 70;
  const availableW = Math.max(200, box.width - insetLeft - insetRight);
  const availableH = Math.max(200, box.height - insetTop - insetBottom);
  const zoom = Math.min(2, availableW / (right - left), availableH / (bottom - top));
  setViewport({
    zoom,
    x: insetLeft + (availableW - (right - left) * zoom) / 2 - left * zoom,
    y: insetTop + (availableH - (bottom - top) * zoom) / 2 - top * zoom,
  });
}
