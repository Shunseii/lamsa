import { Keyboard, X } from "lucide-react";
import { useRef } from "react";
import { isMac, shortcut } from "../lib/keys";
import { useEditor } from "../lib/store";
import { useDismiss } from "./Popover";

interface Group {
  title: string;
  rows: [label: string, keys: string][];
}

const MOD = isMac ? "⌘" : "Ctrl";
const SHIFT = isMac ? "⇧" : "Shift";

const GROUPS: Group[] = [
  {
    title: "Tools",
    rows: [
      ["Select", "V"],
      ["Hand", "H"],
      ["Frame", "F"],
      ["Text", "T"],
      ["Rectangle", "R"],
      ["Image", "I"],
      ["Component", "C"],
    ],
  },
  {
    title: "Edit",
    rows: [
      ["Undo", shortcut("mod+z")],
      ["Redo", shortcut("mod+shift+z")],
      ["Copy", shortcut("mod+c")],
      ["Cut", shortcut("mod+x")],
      ["Paste", shortcut("mod+v")],
      ["Duplicate", shortcut("mod+d")],
      ["Group", shortcut("mod+g")],
      ["Select all", shortcut("mod+a")],
      ["Delete", isMac ? "⌫ Delete" : "Delete / Backspace"],
      ["Nudge", "← ↑ → ↓"],
      ["Nudge 10px", `${SHIFT} + arrows`],
      ["Select parent", "Esc"],
      ["Hide / show", shortcut("mod+shift+h")],
      ["Lock / unlock", shortcut("mod+shift+l")],
    ],
  },
  {
    title: "View",
    rows: [
      ["Pan", "Hold Space + drag · middle button + drag"],
      ["Zoom in / out", `${shortcut("mod+=")} / ${shortcut("mod+-")}`],
      ["Zoom to fit", shortcut("shift+1")],
      ["Zoom to selection", shortcut("shift+2")],
      ["Zoom to 100%", shortcut("shift+0")],
      ["Layers panel", shortcut("mod+[")],
      ["Properties panel", shortcut("mod+]")],
      ["Focus mode", shortcut("mod+\\")],
      ["Agent terminal", shortcut("mod+j")],
      ["Keyboard shortcuts", "?"],
      ["Open another project", shortcut("mod+o")],
    ],
  },
  {
    title: "Animation preview",
    rows: [
      ["Preview selection", "P"],
      ["Play again", "R"],
      ["Full screen", "F"],
      ["Zoom", "Scroll · + / −"],
      ["Pan", "Middle button + drag"],
      ["Reset view", "0"],
      ["Step through frames (Flow)", "← →"],
      ["Select a layer", `${MOD} click`],
      ["Close", "Esc"],
    ],
  },
];

export function ShortcutsHelp() {
  const setHelp = useEditor((s) => s.setHelp);
  const dialog = useRef<HTMLDivElement>(null);
  useDismiss({ ref: dialog, onClose: () => setHelp(false) });
  return (
    <div className="scrim">
      <div ref={dialog} className="dialog shortcuts" role="dialog" aria-label="Keyboard shortcuts" data-testid="shortcuts-help">
        <div className="dialog-title">
          <Keyboard size={16} />
          Keyboard shortcuts
          <button className="icon-btn small push-right" onClick={() => setHelp(false)} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h3 className="shortcuts-heading">{group.title}</h3>
              {group.rows.map(([label, keys]) => (
                <div key={label} className="shortcuts-row">
                  <span>{label}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
