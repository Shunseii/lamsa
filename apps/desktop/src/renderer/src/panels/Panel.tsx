import { createContext, forwardRef, useContext, useEffect, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

/** Where a panel sits; each dock has its own position and slides in and out from its own edge (styles.css). */
export type PanelDock = "left" | "right" | "centre";

/** How long a closing panel or dialog stays mounted so its exit transition (styles.css) can play. */
const EXIT_MS = 140;

const PresenceOpen = createContext(true);

/** False while a panel or dialog is playing its exit: it's still on screen but shouldn't take input. */
export const usePresenceOpen = () => useContext(PresenceOpen);

/** Keeps a panel or dialog mounted for its exit transition; `data-state` drives the CSS. */
export function Presence({ open, children }: { open: boolean; children: ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);
  if (!open && !mounted) return null;
  return (
    <div className="presence" data-state={open ? "open" : "closed"}>
      <PresenceOpen.Provider value={open}>{children}</PresenceOpen.Provider>
    </div>
  );
}

/** The floating surface every editor panel is drawn in. Render it inside a `Presence` so it animates in and out. */
export const Panel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { dock: PanelDock }>(function Panel(
  { dock, className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("panel", `panel-${dock}`, className)} {...props} />;
});
