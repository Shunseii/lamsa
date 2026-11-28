import { useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { DOCK_DEFAULT_SIZE, DOCK_IDS, DOCK_SIZE, clampDockSize, dockMin, dockSize, type DockId } from "../lib/layout";
import { useEditor } from "../lib/store";

const SIZE_VAR: Record<DockId, string> = { left: "--left-size", right: "--right-size", centre: "--centre-h" };
const DOCK_LABEL: Record<DockId, string> = { left: "left panel", right: "right panel", centre: "bottom panel" };

const sizeRule = (sizes: (number | null)[]) => {
  const declarations = DOCK_IDS.flatMap((dock, i) => (sizes[i] === null ? [] : [`${SIZE_VAR[dock]}: ${sizes[i]}px;`]));
  return declarations.length ? `.editor > :not(.canvas) { ${declarations.join(" ")} }` : "";
};

/**
 * Each dock's size override. It targets the editor's non-canvas children, like the default sizes in styles.css,
 * so resizing or switching tabs never restyles the canvas's frames.
 */
export function DockSizeStyle() {
  const sizes = useEditor(useShallow((s) => DOCK_IDS.map((dock) => dockSize(s.layout, dock))));
  return <style data-dock-sizes="">{sizeRule(sizes)}</style>;
}

/** While a drag is resizing a dock, its size goes straight to a stylesheet; the store only hears about it on release. */
function liveSizeStyle(dock: DockId) {
  const style = document.createElement("style");
  const committed = document.querySelector("style[data-dock-sizes]");
  if (committed) committed.after(style);
  else document.head.appendChild(style);
  return {
    set: (size: number) => {
      style.textContent = `.editor > :not(.canvas) { ${SIZE_VAR[dock]}: ${size}px; }`;
    },
    remove: () => style.remove(),
  };
}

/**
 * Drag a dock's inner edge to resize it (its width, or the bottom dock's height); double-click goes back to the default.
 * Arrow keys resize it too.
 */
export function DockResize({ dock }: { dock: DockId }) {
  const setDockSize = useEditor((s) => s.setDockSize);
  const size = useEditor((s) => dockSize(s.layout, dock)) ?? DOCK_DEFAULT_SIZE[dock];
  const [readout, setReadout] = useState<{ size: number; x: number; y: number } | null>(null);
  const vertical = dock === "centre";
  const testId = `${dock}-panel`;

  const measure = (handle: HTMLElement) => {
    const rect = handle.parentElement!.getBoundingClientRect();
    return vertical ? rect.height : rect.width;
  };

  const start = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    // Captured, so the drag keeps its events over panels that stop pointer events from bubbling.
    handle.setPointerCapture(e.pointerId);
    const editor = handle.closest(".editor");
    const startPoint = vertical ? e.clientY : e.clientX;
    const startSize = measure(handle);
    const direction = dock === "left" ? 1 : -1;
    const live = liveSizeStyle(dock);
    let size: number | null = null;
    editor?.classList.add(vertical ? "is-resizing-rows" : "is-resizing");
    const cover = document.createElement("div");
    cover.className = "resize-cover";
    cover.style.cursor = vertical ? "ns-resize" : "ew-resize";
    document.body.append(cover);
    const move = (event: PointerEvent) => {
      size = clampDockSize({ dock, size: startSize + direction * ((vertical ? event.clientY : event.clientX) - startPoint) });
      live.set(size);
      setReadout({ size, x: event.clientX, y: event.clientY });
    };
    const up = () => {
      editor?.classList.remove("is-resizing", "is-resizing-rows");
      cover.remove();
      if (size !== null) setDockSize({ dock, size });
      live.remove();
      setReadout(null);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? { ArrowUp: 1, ArrowDown: -1 } : dock === "left" ? { ArrowRight: 1, ArrowLeft: -1 } : { ArrowLeft: 1, ArrowRight: -1 };
    const step = grow[e.key as keyof typeof grow];
    if (!step) return;
    e.preventDefault();
    setDockSize({ dock, size: measure(e.currentTarget) + step * (e.shiftKey ? 40 : 10) });
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable resize separator; <hr> can't take pointer handlers. */}
      <div
        className={`panel-resize panel-resize-${dock}`}
        role="separator"
        tabIndex={0}
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-label={`Resize ${DOCK_LABEL[dock]}`}
        aria-valuemin={dockMin(dock)}
        aria-valuemax={DOCK_SIZE[dock].max}
        aria-valuenow={readout?.size ?? size}
        onPointerDown={start}
        onKeyDown={onKeyDown}
        onDoubleClick={() => setDockSize({ dock, size: null })}
        title="Drag to resize · double-click to reset"
        data-testid={`${testId}-resize`}
      />
      {readout && (
        <div className="panel-resize-readout mono" style={{ left: readout.x + 10, top: readout.y - 14 }} data-testid={`${testId}-${vertical ? "height" : "width"}`}>
          {readout.size} px{" "}
          <span className="muted">
            · {dockMin(dock)}–{DOCK_SIZE[dock].max}
          </span>
        </div>
      )}
    </>
  );
}
