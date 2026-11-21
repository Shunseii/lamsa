import { ChevronDown, PanelBottom, PanelLeft, PanelRight } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "../lib/cn";
import { DOCK_IDS, dockOf, setMeasuredDockMin, type DockId, type PanelId } from "../lib/layout";
import { useEditor } from "../lib/store";
import { Panel, Presence } from "./Panel";
import { DockResize } from "./PanelResize";
import { Popover } from "./Popover";
import { PANELS, panelShortcut } from "./registry";
import { shortcut } from "../lib/keys";
import { Tip } from "./Toolbar";

export const DOCK_NAMES: Record<DockId, string> = { left: "left", right: "right", centre: "bottom" };
const DOCK_ICONS: Record<DockId, ReactNode> = {
  left: <PanelLeft size={14} />,
  right: <PanelRight size={14} />,
  centre: <PanelBottom size={14} />,
};
const zoneLabel = (dock: DockId) => (dock === "centre" ? "Dock at the bottom" : `Dock ${DOCK_NAMES[dock]}`);

/** Whether a dock is on screen: it has tabs, and the user hasn't hidden it. */
export const useDockOpen = (dock: DockId) => useEditor((s) => s.layout[dock].tabs.length > 0 && s.panels[dock]);

/** The three docks and the drop zones a dragged tab can land on. */
export function Docks() {
  return (
    <>
      {DOCK_IDS.map((dock) => (
        <Dock key={dock} dock={dock} />
      ))}
      <DockZones />
    </>
  );
}

function Dock({ dock }: { dock: DockId }) {
  const open = useDockOpen(dock);
  const fullscreen = useEditor((s) => s.previewFullscreen && s.layout[dock].active === "preview");
  return (
    <Presence open={open}>
      <Panel dock={dock} className={cn({ "is-fullscreen": fullscreen })} data-dock={dock} data-testid={`dock-${dock}`}>
        <TabStrip dock={dock} />
        {dock === "centre" && <HideBottomDock />}
        <ActiveBody dock={dock} />
        <DockResize dock={dock} />
      </Panel>
    </Presence>
  );
}

/** The bottom dock's own hide button: its top-bar toggle is far away, and folds into More in narrow windows. */
function HideBottomDock() {
  const hide = () => {
    const { togglePanel, setPreviewFullscreen } = useEditor.getState();
    setPreviewFullscreen(false);
    togglePanel("centre", false);
  };
  return (
    <Tip className="dock-hide" label="Hide bottom panel" keys={shortcut("mod+'")}>
      <button className="icon-btn" onClick={hide} aria-label="Hide bottom panel" data-testid="hide-bottom-panel">
        <ChevronDown size={16} />
      </button>
    </Tip>
  );
}

function ActiveBody({ dock }: { dock: DockId }) {
  const active = useEditor((s) => s.layout[dock].active);
  if (!active) return null;
  const { Body } = PANELS[active];
  return (
    <div className="dock-content" role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
      <Body />
    </div>
  );
}

const MIN_VAR: Record<DockId, string> = { left: "--left-min", right: "--right-min", centre: "--centre-min" };
const measuredMins: Partial<Record<DockId, number>> = {};

/**
 * The width a dock needs so its tab strip fits with its longest label open: every tab's icon, plus the widest label.
 * Inactive labels are collapsed but still rendered, so their full width is their text's scrollWidth.
 */
function stripMinWidth(strip: HTMLElement) {
  const panel = strip.parentElement!;
  const style = getComputedStyle(strip);
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-panel-tab]"));
  let icons = 0;
  let widest = 0;
  for (const tab of tabs) {
    const label = tab.querySelector<HTMLElement>(".tab-label");
    icons += tab.offsetWidth - (label?.offsetWidth ?? 0);
    widest = Math.max(widest, label?.firstElementChild?.scrollWidth ?? 0);
  }
  const gaps = (Number.parseFloat(style.columnGap) || 0) * Math.max(0, tabs.length - 1);
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const border = panel.offsetWidth - panel.clientWidth;
  return Math.ceil(padding + icons + gaps + widest + border);
}

/**
 * Publishes a dock's minimum width to the stylesheet, so no width can go below it, and a side dock's to the layout too, for
 * resizing (the bottom dock is resized by height).
 */
function useDockMinWidth({ dock, strip, tabs }: { dock: DockId; strip: React.RefObject<HTMLDivElement | null>; tabs: PanelId[] }) {
  useLayoutEffect(() => {
    if (tabs.length === 0) return;
    const update = () => {
      if (!strip.current) return;
      const size = stripMinWidth(strip.current);
      if (dock !== "centre") setMeasuredDockMin({ dock, size });
      measuredMins[dock] = size;
      let style = document.querySelector<HTMLStyleElement>("style[data-dock-mins]");
      if (!style) {
        style = document.createElement("style");
        style.dataset.dockMins = "";
        document.head.appendChild(style);
      }
      const declarations = Object.entries(measuredMins).map(([id, min]) => `${MIN_VAR[id as DockId]}: ${min}px;`);
      style.textContent = `.editor > :not(.canvas) { ${declarations.join(" ")} }`;
    };
    update();
    void document.fonts.ready.then(update);
  }, [dock, strip, tabs]);
}

function TabStrip({ dock }: { dock: DockId }) {
  const { tabs, active } = useEditor(useShallow((s) => ({ tabs: s.layout[dock].tabs, active: s.layout[dock].active })));
  const badges = useEditor(useShallow((s) => tabs.map((panel) => PANELS[panel].badge?.count(s) ?? 0)));
  const [menu, setMenu] = useState<{ panel: PanelId; anchor: HTMLElement } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const strip = useRef<HTMLDivElement>(null);
  useDockMinWidth({ dock, strip, tabs });

  const focusTab = (panel: PanelId) => strip.current?.querySelector<HTMLElement>(`[data-panel-tab="${panel}"]`)?.focus();

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>, panel: PanelId) => {
    const at = tabs.indexOf(panel);
    const next = { ArrowRight: tabs[(at + 1) % tabs.length], ArrowLeft: tabs[(at - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[e.key];
    if (next) {
      e.preventDefault();
      useEditor.getState().showPanel(next);
      focusTab(next);
      return;
    }
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      setMenu({ panel, anchor: e.currentTarget });
    }
  };

  return (
    <div ref={strip} className="tabs" role="tablist" aria-label={`${DOCK_NAMES[dock]} panels`}>
      {tabs.map((panel) => {
        const { title, icon: Icon, badge } = PANELS[panel];
        const isActive = panel === active;
        const count = badges[tabs.indexOf(panel)] ?? 0;
        const label = badge && count > 0 ? `${title} · ${badge.describe(count)}` : title;
        return (
          <Tip key={panel} label={label} keys={panelShortcut(panel)}>
            <button
              id={`tab-${panel}`}
              className={cn("tab", { "is-active": isActive })}
              role="tab"
              aria-selected={isActive}
              aria-controls={isActive ? `panel-${panel}` : undefined}
              aria-label={label}
              tabIndex={isActive ? 0 : -1}
              data-panel-tab={panel}
              onClick={() => useEditor.getState().showPanel(panel)}
              onPointerDown={(e) => startTabDrag({ panel, event: e })}
              onKeyDown={(e) => onKeyDown(e, panel)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ panel, anchor: e.currentTarget });
              }}
            >
              <Icon size={16} />
              {count > 0 && (
                <span className="tab-badge" aria-hidden data-testid={`${panel}-tab-badge`}>
                  {count > 99 ? "99+" : count}
                </span>
              )}
              <span className="tab-label" aria-hidden={!isActive}>
                <span>{title}</span>
              </span>
            </button>
          </Tip>
        );
      })}
      {menu && (
        <Popover anchor={menu.anchor} width={220} onClose={closeMenu} testId="panel-tab-menu">
          {DOCK_IDS.filter((target) => target !== dock).map((target) => (
            <button
              key={target}
              className="menu-item"
              data-dock-target={target}
              onClick={() => {
                const { panel } = menu;
                setMenu(null);
                useEditor.getState().movePanel({ panel, dock: target });
                requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-panel-tab="${panel}"]`)?.focus());
              }}
            >
              <span className="muted">{DOCK_ICONS[target]}</span>
              Move to the {DOCK_NAMES[target]}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

/** Drop targets for a dragged tab. Hidden until a drag starts; the drag drives them through the DOM, not React state. */
function DockZones() {
  return (
    <div className="dock-zones" data-testid="dock-zones">
      {DOCK_IDS.map((dock) => (
        <div key={dock} className={`dock-zone dock-zone-${dock}`} data-zone={dock} data-testid={`dock-zone-${dock}`}>
          <span className="dock-zone-label">
            {DOCK_ICONS[dock]}
            {zoneLabel(dock)}
          </span>
        </div>
      ))}
    </div>
  );
}

const DRAG_THRESHOLD = 4;

/** Where among a dock's tabs a drop at `x` lands, when the pointer is over its tab strip; undefined drops it last. */
function tabIndexAt({ dock, x, y }: { dock: DockId; x: number; y: number }): number | undefined {
  const strip = document.querySelector(`[data-dock="${dock}"] [role="tablist"]`);
  if (!strip) return undefined;
  const rect = strip.getBoundingClientRect();
  if (y < rect.top - 8 || y > rect.bottom + 8) return undefined;
  const tabs = Array.from(strip.querySelectorAll("[data-panel-tab]"));
  return tabs.filter((tab) => {
    const box = tab.getBoundingClientRect();
    return box.left + box.width / 2 < x;
  }).length;
}

/**
 * Drags a tab to another dock. The pointer only moves a ghost and flips data attributes on the drop zones, so neither
 * React nor the canvas does any work until the drop, which is a single store update.
 */
function startTabDrag({ panel, event }: { panel: PanelId; event: ReactPointerEvent<HTMLElement> }) {
  if (event.button !== 0) return;
  const tab = event.currentTarget;
  const zones = document.querySelector<HTMLElement>(".dock-zones");
  if (!zones) return;
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false;
  let over: DockId | null = null;
  let rects: [DockId, DOMRect][] = [];
  let ghost: HTMLElement | null = null;

  const begin = () => {
    dragging = true;
    zones.dataset.dragging = "";
    rects = Array.from(zones.querySelectorAll<HTMLElement>("[data-zone]")).map((zone) => [zone.dataset.zone as DockId, zone.getBoundingClientRect()]);
    tab.classList.add("is-dragged");
    ghost = document.createElement("div");
    ghost.className = "dock-ghost";
    ghost.dataset.testid = "dock-ghost";
    const icon = tab.querySelector("svg")?.cloneNode(true);
    if (icon) ghost.append(icon);
    ghost.append(PANELS[panel].title);
    zones.append(ghost);
  };

  const setOver = (dock: DockId | null) => {
    if (dock === over) return;
    if (over) zones.querySelector(`[data-zone="${over}"]`)?.removeAttribute("data-over");
    if (dock) zones.querySelector(`[data-zone="${dock}"]`)?.setAttribute("data-over", "");
    over = dock;
  };

  const move = (e: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_THRESHOLD) return;
      begin();
    }
    ghost!.style.translate = `${e.clientX + 12}px ${e.clientY + 8}px`;
    setOver(rects.find(([, r]) => e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)?.[0] ?? null);
  };

  const finish = (drop: { x: number; y: number } | null) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", onKey, true);
    if (!dragging) return;
    const target = over;
    setOver(null);
    delete zones.dataset.dragging;
    tab.classList.remove("is-dragged");
    ghost?.remove();
    // The click that ends a drag mustn't also activate whatever tab it was released over.
    window.addEventListener("click", stopClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stopClick, true), 0);
    if (!drop || !target) return;
    const state = useEditor.getState();
    const index = tabIndexAt({ dock: target, ...drop });
    if (dockOf(state.layout, panel) === target && index === undefined) state.showPanel(panel);
    else state.movePanel({ panel, dock: target, index });
  };
  const stopClick = (e: MouseEvent) => e.stopPropagation();
  const up = (e: PointerEvent) => finish({ x: e.clientX, y: e.clientY });
  const cancel = () => finish(null);
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || !dragging) return;
    e.stopPropagation();
    finish(null);
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", onKey, true);
}
