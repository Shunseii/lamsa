import { useEditor } from "../lib/store";
import { runCommand, type CommandName } from "../lib/commands";

const ITEMS: { label: string; command: CommandName; keys: string; danger?: boolean }[] = [
  { label: "Copy", command: "copy", keys: "⌘C" },
  { label: "Paste", command: "paste", keys: "⌘V" },
  { label: "Duplicate", command: "duplicate", keys: "⌘D" },
  { label: "Group into frame", command: "group", keys: "⌘G" },
  { label: "Select parent", command: "select-parent", keys: "Esc" },
  { label: "Copy node ID", command: "copy-id", keys: "" },
  { label: "Zoom to selection", command: "zoom-selection", keys: "⇧2" },
  { label: "Delete", command: "delete", keys: "⌫", danger: true },
];

export function ContextMenu() {
  const { contextMenu, setContextMenu } = useEditor();
  if (!contextMenu) return null;
  return (
    <div className="menu context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} data-testid="context-menu" onMouseLeave={() => setContextMenu(null)}>
      {ITEMS.map((item, i) => (
        <div key={item.command}>
          {i === ITEMS.length - 1 && <div className="menu-sep" />}
          <button
            className={`menu-item ${item.danger ? "is-danger" : ""}`}
            onClick={() => {
              setContextMenu(null);
              void runCommand(item.command);
            }}
          >
            {item.label}
            {item.keys && <kbd>{item.keys}</kbd>}
          </button>
        </div>
      ))}
    </div>
  );
}
