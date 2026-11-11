export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MAC: Record<string, string> = { mod: "⌘", shift: "⇧", alt: "⌥" };
const OTHER: Record<string, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt" };

/** Formats a shortcut like "mod+shift+z" for this platform: "⇧⌘Z" on macOS, "Ctrl+Shift+Z" elsewhere. */
export function shortcut(spec: string): string {
  const parts = spec.split(/\+(?=.)/);
  const key = parts.pop()!;
  const label = key.length === 1 ? key.toUpperCase() : key;
  if (isMac) {
    const order = ["alt", "shift", "mod"];
    const modifiers = order.filter((m) => parts.includes(m)).map((m) => MAC[m]);
    return [...modifiers, label].join("");
  }
  return [...parts.map((m) => OTHER[m] ?? m), label].join("+");
}
