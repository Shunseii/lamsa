import { Check, FileJson, FolderOpen, Files, X } from "lucide-react";
import { useRef, useState } from "react";
import { useDismiss } from "./Popover";
import { cn } from "../lib/cn";
import { api, useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";

/**
 * Asked once per project: which design files to open. The choice is saved in the session, and more
 * files can be added later from the layers panel or the Files tab.
 */
export function OpenFilesDialog() {
  const files = useEditor((s) => s.files);
  const snapshot = useEditor((s) => s.snapshot);
  const setOpenFiles = useEditor((s) => s.setOpenFiles);
  const addFiles = useEditor((s) => s.addFiles);
  const paths = Object.keys(files).sort();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const all = picked.size === paths.length;
  const dialog = useRef<HTMLDivElement>(null);
  // Dismissing opens nothing; files can be added later from the layers panel. The check skips a
  // stray click while the dialog is fading out after a choice was made.
  const dismiss = () => {
    if (useEditor.getState().openFiles === null) void setOpenFiles([]);
  };
  useDismiss({ ref: dialog, onClose: dismiss });

  const open = async (list: string[]) => {
    await setOpenFiles(list);
    setTimeout(() => fitTo("all"), 80);
  };

  return (
    <div className="scrim">
      <div ref={dialog} className="dialog open-files" role="dialog" aria-label="Open design files" data-testid="open-files-dialog">
        <div className="dialog-title">
          <Files size={16} />
          Open design files
          <button className="icon-btn small push-right" onClick={dismiss} aria-label="Close" title="Close  Esc" data-testid="open-files-close">
            <X size={16} />
          </button>
        </div>
        <div className="muted small">
          {snapshot?.name} has {paths.length} design files. Pick the ones to work on; you can add more any time from the layers panel.
        </div>
        <div className="open-files-list">
          <button className="open-files-row is-all" onClick={() => setPicked(all ? new Set() : new Set(paths))}>
            <span className={cn("checkbox", { "is-on": all })}>{all && <Check size={11} />}</span>
            All files
          </button>
          {paths.map((path) => (
            <button
              key={path}
              className="open-files-row"
              data-file={path}
              onClick={() =>
                setPicked((current) => {
                  const next = new Set(current);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
            >
              <span className={cn("checkbox", { "is-on": picked.has(path) })}>{picked.has(path) && <Check size={11} />}</span>
              <FileJson size={14} className="muted" />
              <span className="truncate">{path.split("/").pop()}</span>
              <span className="mono muted small truncate push-right">{path.split("/").slice(0, -1).join("/")}</span>
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button
            className="ghost-btn"
            onClick={() =>
              void api()
                .pickDesignFiles()
                .then(async (chosen) => {
                  if (!chosen.length) return;
                  await setOpenFiles([...picked]);
                  await addFiles(chosen);
                  setTimeout(() => fitTo("all"), 80);
                })
            }
          >
            <FolderOpen size={14} /> Browse…
          </button>
          <button className="btn btn-accent" disabled={picked.size === 0} onClick={() => void open([...picked])} data-testid="open-files-confirm">
            Open {picked.size || ""} file{picked.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}
