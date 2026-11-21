import type { Model } from "./model";

/** How long an agent change stays fully highlighted, then how long it takes to fade (matches `.ov-flash` in styles.css). */
export const HIGHLIGHT_HOLD_MS = 1500;
export const HIGHLIGHT_FADE_MS = 600;
export const HIGHLIGHT_MS = HIGHLIGHT_HOLD_MS + HIGHLIGHT_FADE_MS;

/** Past this many highlighted layers, a change is shown per top-level frame instead, so a big rewrite stays cheap to draw. */
export const MAX_HIGHLIGHTS = 40;

/** How long the agent's cursor stays where it last worked before it fades out. */
export const AGENT_CURSOR_LINGER_MS = 4000;
export const AGENT_CURSOR_FADE_MS = 600;

/**
 * The layers to highlight for a change from disk: the smallest changed layers that are on the canvas, except that an
 * added subtree shows as its top layer only. Large changes merge to their top-level frames, capped at MAX_HIGHLIGHTS.
 */
export function changeHighlights({ model, previous, changedIds }: { model: Model; previous: Model; changedIds: readonly string[] }): string[] {
  const shown = new Set(model.roots);
  const rootCache = new Map<string, string | null>();
  const shownRootOf = (id: string): string | null => {
    const path: string[] = [];
    let current: string | undefined = id;
    let found: string | null = null;
    while (current) {
      const cached = rootCache.get(current);
      if (cached !== undefined) {
        found = cached;
        break;
      }
      path.push(current);
      const parent: string | undefined = model.nodes[current]?.parentId;
      if (!parent) {
        found = shown.has(current) ? current : null;
        break;
      }
      current = parent;
    }
    for (const step of path) rootCache.set(step, found);
    return found;
  };

  const present = changedIds.filter((id) => model.nodes[id] && shownRootOf(id) !== null);
  const added = new Set(present.filter((id) => !previous.nodes[id]));
  const insideAdded = (id: string) => {
    for (let parent = model.nodes[id]?.parentId; parent; parent = model.nodes[parent]?.parentId) if (added.has(parent)) return true;
    return false;
  };
  const smallest = present.filter((id) => !insideAdded(id));
  if (smallest.length <= MAX_HIGHLIGHTS) return smallest;
  const frames = [...new Set(smallest.map((id) => shownRootOf(id)!))];
  return frames.slice(0, MAX_HIGHLIGHTS);
}
