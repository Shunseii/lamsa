import { Diamond, Frame, Image as ImageIcon, Shapes, Type } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useEditor } from "../../lib/store";
import { fitTo } from "../../lib/viewport";

export function LayerTypeIcon({ type, size = 12 }: { type: string; size?: number }) {
  if (type === "text") return <Type size={size} />;
  if (type === "image") return <ImageIcon size={size} />;
  if (type === "icon") return <Shapes size={size} />;
  if (type === "instance" || type === "component") return <Diamond size={size} className="accent" />;
  return <Frame size={size} />;
}

/** Opens the layers' file if needed, selects them, and brings them into view. */
export async function revealLayers({ file, ids }: { file: string; ids: string[] }) {
  const editor = useEditor.getState();
  if (editor.openFiles && !editor.openFiles.includes(file)) await editor.addFiles([file]);
  const state = useEditor.getState();
  const present = ids.filter((id) => state.model.nodes[id]);
  if (!present.length) return;
  state.select(present);
  setTimeout(() => fitTo("selection"), 60);
}

/** A layer mentioned in a chat message; clicking it selects the layer on the canvas. */
export function LayerPill({ id, name }: { id: string; name: string }) {
  const { type, file } = useEditor(useShallow((s) => ({ type: s.model.nodes[id]?.type, file: s.model.fileOf.get(id) })));
  const missing = !type || !file;
  return (
    <button
      type="button"
      className="agent-pill"
      disabled={missing}
      title={missing ? `${id} · not in the open files` : `${id} · ${file}`}
      onClick={() => file && void revealLayers({ file, ids: [id] })}
      data-testid="agent-layer-pill"
      data-node-id={id}
    >
      <LayerTypeIcon type={type ?? "frame"} />
      <span className="truncate">{name}</span>
    </button>
  );
}
