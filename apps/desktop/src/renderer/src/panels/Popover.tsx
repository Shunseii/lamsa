import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;
const GAP = 4;

interface Placement {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

/**
 * Closes a floating menu on Escape or a click outside it. That outside click only closes the menu:
 * it never reaches the canvas or panels underneath, so it can't change the selection.
 */
/** The click that closes a menu shouldn't also press whatever was under it (e.g. a section header). */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.addEventListener("pointerdown", () => window.removeEventListener("click", swallow, true), { capture: true, once: true });
}

export function useDismiss({ ref, anchor, onClose }: { ref: React.RefObject<HTMLElement | null>; anchor?: HTMLElement | null; onClose: () => void }) {
  useLayoutEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      e.stopPropagation();
      swallowNextClick();
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ref, anchor, onClose]);
}

/**
 * A menu anchored to `anchor`, rendered at the document root so panel overflow can't clip it.
 * It opens below the anchor (or above when there's more room), right-aligned with it, and stays open
 * until something is picked, Escape is pressed, or the user clicks outside it.
 */
export function Popover({
  anchor,
  width,
  onClose,
  children,
  testId,
}: {
  anchor: HTMLElement | null;
  width: number;
  onClose: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - GAP - MARGIN;
      const above = rect.top - GAP - MARGIN;
      const left = Math.min(Math.max(MARGIN, rect.right - width), window.innerWidth - width - MARGIN);
      setPlacement(
        below >= 240 || below >= above
          ? { top: rect.bottom + GAP, left, maxHeight: below }
          : { bottom: window.innerHeight - rect.top + GAP, left, maxHeight: above },
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, width]);

  useDismiss({ ref, anchor, onClose });

  if (!placement) return null;
  return createPortal(
    <div ref={ref} className="popover" data-testid={testId} style={{ ...placement, width }}>
      {children}
    </div>,
    document.body,
  );
}
