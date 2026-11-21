/** Which editor panel lives in which dock. Pure functions, so the store and the tests share them. */

export const PANEL_IDS = ["agent", "layers", "files", "components", "properties", "preview"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const DOCK_IDS = ["left", "right", "centre"] as const;
export type DockId = (typeof DOCK_IDS)[number];

export interface DockState {
  tabs: PanelId[];
  active: PanelId | null;
  /** The width (side docks) or height (centre) the user dragged it to; null keeps the default. */
  size: number | null;
}

export type PanelLayout = Record<DockId, DockState>;

export const DEFAULT_LAYOUT: PanelLayout = {
  left: { tabs: ["agent", "layers", "files", "components"], active: "layers", size: null },
  right: { tabs: ["properties"], active: "properties", size: null },
  centre: { tabs: ["preview"], active: "preview", size: null },
};

export const DOCK_SIZE: Record<DockId, { min: number; max: number }> = {
  left: { min: 200, max: 480 },
  right: { min: 240, max: 480 },
  centre: { min: 160, max: 640 },
};

/** The stylesheet's sizes at full window width (styles.css narrows the side docks on smaller windows). */
export const DOCK_DEFAULT_SIZE: Record<DockId, number> = { left: 260, right: 296, centre: 340 };

/** Panels that need more room than their dock's default while they're the open tab, unless the user sized the dock. */
export const PREFERRED_WIDTH: Partial<Record<PanelId, number>> = { agent: 360, preview: 440 };

/** The width each side dock's tab strip needs to show its longest label, measured from the DOM (Dock.tsx). The bottom dock is
 * sized by height, so its strip's width is only kept in the stylesheet. */
const measuredMin: Partial<Record<DockId, number>> = {};

export function setMeasuredDockMin({ dock, size }: { dock: DockId; size: number }) {
  measuredMin[dock] = size;
}

/** The smallest a dock can be: its fixed floor, or more when its tabs need it. */
export const dockMin = (dock: DockId) => Math.max(DOCK_SIZE[dock].min, measuredMin[dock] ?? 0);

export const clampDockSize = ({ dock, size }: { dock: DockId; size: number }) =>
  Math.round(Math.min(DOCK_SIZE[dock].max, Math.max(dockMin(dock), size)));

export function dockOf(layout: PanelLayout, panel: PanelId): DockId | null {
  return DOCK_IDS.find((dock) => layout[dock].tabs.includes(panel)) ?? null;
}

/** The width (or height) a dock is drawn at, or null for its stylesheet default. */
export function dockSize(layout: PanelLayout, dock: DockId): number | null {
  const state = layout[dock];
  if (state.size !== null) return state.size;
  if (dock === "centre" || !state.active) return null;
  return PREFERRED_WIDTH[state.active] ?? null;
}

/** Moves a panel to `dock` (at `index`, else last) and opens it there; the dock it left keeps a neighbour open. */
export function movePanel({ layout, panel, dock, index }: { layout: PanelLayout; panel: PanelId; dock: DockId; index?: number }): PanelLayout {
  const next = { ...layout };
  for (const id of DOCK_IDS) {
    const state = layout[id];
    const at = state.tabs.indexOf(panel);
    if (at < 0) continue;
    const tabs = state.tabs.filter((tab) => tab !== panel);
    const active = state.active === panel ? (tabs[Math.max(0, at - 1)] ?? null) : state.active;
    next[id] = { ...state, tabs, active };
  }
  const target = next[dock];
  const from = layout[dock].tabs.indexOf(panel);
  // Indexes count the tabs as they were drawn, with the dragged one still in place.
  const adjusted = index === undefined ? target.tabs.length : from >= 0 && from < index ? index - 1 : index;
  const tabs = [...target.tabs];
  tabs.splice(Math.max(0, Math.min(adjusted, tabs.length)), 0, panel);
  next[dock] = { ...target, tabs, active: panel };
  return next;
}

export function activatePanel(layout: PanelLayout, panel: PanelId): PanelLayout {
  const dock = dockOf(layout, panel);
  if (!dock || layout[dock].active === panel) return layout;
  return { ...layout, [dock]: { ...layout[dock], active: panel } };
}

export function resizeDock({ layout, dock, size }: { layout: PanelLayout; dock: DockId; size: number | null }): PanelLayout {
  return { ...layout, [dock]: { ...layout[dock], size: size === null ? null : clampDockSize({ dock, size }) } };
}

const isPanel = (value: unknown): value is PanelId => PANEL_IDS.includes(value as PanelId);

/** Repairs a stored layout: unknown or repeated panels are dropped, missing ones go back to their default dock. */
export function normalizeLayout(raw: unknown): PanelLayout {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<DockId, Partial<DockState>>>;
  const seen = new Set<PanelId>();
  const layout = {} as PanelLayout;
  for (const dock of DOCK_IDS) {
    const entry = stored[dock] ?? {};
    const tabs = (Array.isArray(entry.tabs) ? entry.tabs : []).filter((tab): tab is PanelId => isPanel(tab) && !seen.has(tab));
    for (const tab of tabs) seen.add(tab);
    const size = typeof entry.size === "number" && entry.size > 0 ? clampDockSize({ dock, size: entry.size }) : null;
    const active = isPanel(entry.active) && tabs.includes(entry.active) ? entry.active : (tabs[0] ?? null);
    layout[dock] = { tabs, active, size };
  }
  for (const panel of PANEL_IDS) {
    if (seen.has(panel)) continue;
    const home = DOCK_IDS.find((dock) => DEFAULT_LAYOUT[dock].tabs.includes(panel)) ?? "left";
    const tabs = [...layout[home].tabs];
    tabs.splice(Math.min(DEFAULT_LAYOUT[home].tabs.indexOf(panel), tabs.length), 0, panel);
    layout[home] = { ...layout[home], tabs, active: layout[home].active ?? panel };
  }
  return layout;
}

const LAYOUT_KEY = "lamsa.panelLayout";
const LEGACY_LEFT_WIDTH_KEY = "lamsa.leftWidth";

/** The user's saved layout; a width saved before docks existed carries over to the left dock. */
export function readLayout(): PanelLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    if (stored) return normalizeLayout(JSON.parse(stored));
    const legacyWidth = Number(localStorage.getItem(LEGACY_LEFT_WIDTH_KEY));
    if (legacyWidth > 0) return resizeDock({ layout: DEFAULT_LAYOUT, dock: "left", size: legacyWidth });
  } catch {
    // Storage can be unavailable or hold something unparseable; the default layout is fine then.
  }
  return DEFAULT_LAYOUT;
}

export function writeLayout(layout: PanelLayout | null) {
  try {
    localStorage.removeItem(LEGACY_LEFT_WIDTH_KEY);
    if (layout === null) localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Not remembering the layout is harmless.
  }
}

export type DockShown = Record<DockId, boolean>;

/**
 * Which docks are on screen when the editor opens. The side docks are; the bottom dock only if the user put a panel there
 * that isn't the preview, which waits until something is played in it.
 */
export function initialShown(layout: PanelLayout): DockShown {
  const { active } = layout.centre;
  return { left: true, right: true, centre: active !== null && active !== "preview" };
}
