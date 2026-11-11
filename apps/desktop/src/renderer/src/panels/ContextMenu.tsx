import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Model } from "../lib/model";
import { useEditor } from "../lib/store";
import { runCommand, type CommandName } from "../lib/commands";
import { isMac, shortcut } from "../lib/keys";
import { useDismiss } from "./Popover";

interface Item {
  label: string;
  command: CommandName;
  keys?: string;
  danger?: boolean;
}

/** Only the actions that apply to the current selection, in groups separated by dividers. */
function itemsFor(model: Model, selection: string[]): Item[][] {
  if (selection.length === 0) {
    return [
      [{ label: "Paste", command: "paste", keys: shortcut("mod+v") }],
      [
        { label: "Select all", command: "select-all", keys: shortcut("mod+a") },
        { label: "Zoom to fit all", command: "zoom-fit", keys: shortcut("shift+1") },
      ],
    ];
  }
  const nodes = selection.map((id) => model.nodes[id]).filter((n) => !!n);
  const parents = new Set(nodes.map((n) => n.parentId));
  const sharedParent = parents.size === 1 && !parents.has(undefined);
  const single = nodes.length === 1 ? nodes[0] : undefined;
  const instances = nodes.filter((n) => n.type === "instance").length;
  const groups: Item[][] = [
    [
      { label: "Copy", command: "copy", keys: shortcut("mod+c") },
      { label: "Cut", command: "cut", keys: shortcut("mod+x") },
      { label: "Paste", command: "paste", keys: shortcut("mod+v") },
      { label: "Duplicate", command: "duplicate", keys: shortcut("mod+d") },
    ],
    [
      ...(sharedParent ? [{ label: "Group into frame", command: "group" as const, keys: shortcut("mod+g") }] : []),
      ...(nodes.some((n) => n.parentId !== undefined) ? [{ label: "Select parent", command: "select-parent" as const, keys: "Esc" }] : []),
    ],
    [
      ...(single?.type === "instance" ? [{ label: "Go to main component", command: "go-to-main" as const }] : []),
      ...(instances ? [{ label: instances > 1 ? "Detach instances" : "Detach instance", command: "detach" as const }] : []),
    ],
    [
      { label: selection.length > 1 ? "Copy node IDs" : "Copy node ID", command: "copy-id" },
      { label: "Zoom to selection", command: "zoom-selection", keys: shortcut("shift+2") },
    ],
    [{ label: selection.length > 1 ? `Delete ${selection.length} layers` : "Delete", command: "delete", keys: isMac ? "⌫" : "Delete", danger: true }],
  ];
  return groups.filter((group) => group.length > 0);
}

export function ContextMenu() {
  const contextMenu = useEditor((s) => s.contextMenu);
  if (!contextMenu) return null;
  return <OpenContextMenu x={contextMenu.x} y={contextMenu.y} />;
}

function OpenContextMenu({ x, y }: { x: number; y: number }) {
  const setContextMenu = useEditor((s) => s.setContextMenu);
  const model = useEditor((s) => s.model);
  const selection = useEditor((s) => s.selection);
  const groups = useMemo(() => itemsFor(model, selection), [model, selection]);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const close = useCallback(() => setContextMenu(null), [setContextMenu]);
  useDismiss({ ref, onClose: close });
  useLayoutEffect(() => {
    const menu = ref.current?.getBoundingClientRect();
    if (!menu) return;
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - menu.width - margin)),
      top: Math.max(margin, y + menu.height > window.innerHeight - margin ? y - menu.height : y),
    });
  }, [x, y]);
  return (
    <div ref={ref} className="menu context-menu" style={position} data-testid="context-menu">
      {groups.map((group, g) => (
        <div key={g}>
          {g > 0 && <div className="menu-sep" />}
          {group.map((item) => (
            <button
              key={item.command}
              className={`menu-item ${item.danger ? "is-danger" : ""}`}
              onClick={() => {
                setContextMenu(null);
                void runCommand(item.command);
              }}
            >
              {item.label}
              {item.keys && <kbd>{item.keys}</kbd>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
