import { FileJson, FolderOpen, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { api, useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";
import { Popover } from "./Popover";

/** Design files that are loaded but not open, by path. */
export function closedFiles(files: Record<string, unknown>, openFiles: string[] | null): string[] {
  const open = new Set(openFiles ?? []);
  return Object.keys(files)
    .filter((path) => !open.has(path))
    .sort();
}

/** Shows newly opened files' frames: selects them and zooms to them. */
export function revealFiles(paths: string[]) {
  const { model, select } = useEditor.getState();
  const roots = model.roots.filter((id) => paths.includes(model.fileOf.get(id) ?? ""));
  if (!roots.length) return;
  select(roots);
  requestAnimationFrame(() => fitTo("selection"));
}

/**
 * Adds a design file to the session: one of the project's files that isn't open yet, or any
 * `*.lamsa.json` on disk through the system file picker.
 */
export function AddFileMenu({ appearance = "ghost" }: { appearance?: "icon" | "ghost" | "primary" }) {
  const compact = appearance === "icon";
  const files = useEditor((s) => s.files);
  const openFiles = useEditor((s) => s.openFiles);
  const addFiles = useEditor((s) => s.addFiles);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closed = closedFiles(files, openFiles);

  const add = async (paths: string[]) => {
    setOpen(false);
    if (!paths.length) return;
    const before = new Set(useEditor.getState().openFiles ?? []);
    await addFiles(paths);
    revealFiles((useEditor.getState().openFiles ?? []).filter((path) => !before.has(path)));
  };

  return (
    <>
      <button
        ref={button}
        className={compact ? "icon-btn small" : appearance === "primary" ? "btn btn-accent" : "ghost-btn small"}
        onClick={() => setOpen((o) => !o)}
        aria-label="Add design file"
        title="Add design file"
        data-testid="add-file"
      >
        <Plus size={compact ? 16 : 14} />
        {!compact && (appearance === "primary" ? " Open a file" : " Add file")}
      </button>
      {open && (
        <Popover anchor={button.current} width={280} onClose={() => setOpen(false)} testId="add-file-menu">
          <div className="popover-list">
            {closed.length > 0 && <div className="menu-heading">In this project</div>}
            {closed.map((path) => (
              <button key={path} className="menu-item" onClick={() => void add([path])} data-file={path} title={path}>
                <FileJson size={14} className="muted" />
                <span className="truncate">{path.split("/").pop()}</span>
                <span className="mono muted small truncate push-right">{path.split("/").slice(0, -1).join("/")}</span>
              </button>
            ))}
            {closed.length > 0 && <div className="menu-sep" />}
            <button className="menu-item" onClick={() => void api().pickDesignFiles().then(add)} data-testid="browse-files">
              <FolderOpen size={14} className="muted" />
              Browse…
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
