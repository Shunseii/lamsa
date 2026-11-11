import { MousePointer2, Move, Palette } from "lucide-react";
import { useEditor } from "../lib/store";
import { cn } from "../lib/cn";

export function StatusBar() {
  const { files, pending, snapshot, selection, model, lastError, issues } = useEditor();
  const count = Object.keys(files).length;
  const invalid = Object.values(files).filter((f) => f.error).length;
  const errors = issues.filter((i) => i.severity === "error").length;
  const first = selection[0] ? model.nodes[selection[0]] : undefined;
  const state = lastError ? "save failed" : pending > 0 ? "saving…" : "saved";
  return (
    <div className="bar bar-status" data-testid="status-bar">
      <span className={cn("status-dot", lastError || invalid ? "is-danger" : "is-ok")} />
      <span>
        Watching {count} file{count === 1 ? "" : "s"} · {state}
        {invalid ? ` · ${invalid} invalid` : ""}
      </span>
      <span className="muted status-optional">
        <Palette size={13} /> {snapshot?.tokens.adapter} · {Object.keys(snapshot?.tokens.tokens ?? {}).length} tokens
      </span>
      {errors > 0 && <span className="badge badge-danger">{errors} problem{errors === 1 ? "" : "s"}</span>}
      <span className="grow" />
      <span className="muted">
        <MousePointer2 size={13} /> {selection.length} selected
      </span>
      {first && (first.parentId === undefined || first.style?.position === "absolute") && (
        <span className="muted status-optional">
          <Move size={13} /> x {first.x ?? first.style?.left ?? 0} y {first.y ?? first.style?.top ?? 0}
        </span>
      )}
    </div>
  );
}
