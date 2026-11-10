import type { DesignNode } from "@lamsa/schema";
import { Component, CornerDownLeft, EyeOff, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { insertNodes, newId } from "../lib/edits";
import { isComponent, nodeTitle } from "../lib/model";
import { useEditor } from "../lib/store";

export async function insertInstance(componentId: string, props: Record<string, string | boolean> = {}) {
  const { model, selection, commit, select, files } = useEditor.getState();
  const id = newId(model);
  const target = selection[0];
  const parent = target && model.nodes[target]?.type === "frame" && !isComponent(model.nodes[target]) ? target : model.nodes[target ?? ""]?.parentId;
  const node: DesignNode = { type: "instance", componentId, ...(Object.keys(props).length ? { props } : {}) };
  const file = model.fileOf.get(target ?? "") ?? Object.keys(files)[0] ?? "designs/main.lamsa.json";
  const changes = parent
    ? insertNodes({ model, entries: [{ root: { id, node } }], parentId: parent })
    : insertNodes({ model, entries: [{ root: { id, node: { ...node, x: 0, y: 0 } as DesignNode } }], file });
  await commit("Insert component", changes);
  select([id]);
}

export function ComponentPicker() {
  const { model, setPicker, selection } = useEditor();
  const [query, setQuery] = useState("");
  const all = Object.entries(model.nodes).filter(([, n]) => isComponent(n));
  const hidden = all.filter(([, n]) => n.type === "frame" && n.component?.internal).length;
  const visible = all.filter(([id, n]) => !(n.type === "frame" && n.component?.internal) && nodeTitle(id, n).toLowerCase().includes(query.toLowerCase()));
  const [activeId, setActiveId] = useState<string | undefined>(visible[0]?.[0]);
  const active = activeId ? model.nodes[activeId] : undefined;
  const [props, setProps] = useState<Record<string, string | boolean>>({});

  const groups = useMemo(() => {
    const map = new Map<string, [string, DesignNode][]>();
    for (const entry of visible) {
      const file = model.fileOf.get(entry[0])!;
      map.set(file, [...(map.get(file) ?? []), entry]);
    }
    return map;
  }, [visible, model]);

  const target = selection[0] ? nodeTitle(selection[0], model.nodes[selection[0]]) : "the canvas";
  const definitions = active?.type === "frame" ? (active.component?.props ?? {}) : {};

  const insert = () => {
    if (!activeId) return;
    void insertInstance(activeId, props).then(() => setPicker(false));
  };

  return (
    <div className="picker" data-testid="component-picker" onKeyDown={(e) => e.key === "Escape" && setPicker(false)}>
      <label className="search">
        <Search size={14} />
        <input autoFocus placeholder={`Search ${all.length - hidden} components`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && insert()} />
      </label>
      <div className="picker-body">
        <div className="picker-list">
          {[...groups].map(([file, entries]) => (
            <div key={file}>
              <div className="overline">{file.split("/").pop()}</div>
              {entries.map(([id, node]) => (
                <button
                  key={id}
                  className={`menu-item ${id === activeId ? "is-active" : ""}`}
                  onClick={() => {
                    setActiveId(id);
                    setProps({});
                  }}
                  onDoubleClick={insert}
                >
                  <Component size={14} className="accent" /> {nodeTitle(id, node)}
                </button>
              ))}
            </div>
          ))}
          {visible.length === 0 && <p className="muted pad">No components match.</p>}
          {hidden > 0 && (
            <div className="muted small pad">
              <EyeOff size={12} /> {hidden} internal helper{hidden === 1 ? "" : "s"} hidden
            </div>
          )}
        </div>
        <div className="picker-detail">
          {active && activeId ? (
            <>
              <div className="title-sm">{nodeTitle(activeId, active)}</div>
              <div className="muted mono small">
                {model.fileOf.get(activeId)} · id {activeId}
              </div>
              {Object.entries(definitions).map(([name, def]) => (
                <div className="field" key={name}>
                  <span className="field-label">{name}</span>
                  {def.type === "enum" ? (
                    <div className="segmented small">
                      {def.options.map((option) => (
                        <button key={option} className={(props[name] ?? def.default) === option ? "is-on" : ""} onClick={() => setProps({ ...props, [name]: option })}>
                          {option}
                        </button>
                      ))}
                    </div>
                  ) : def.type === "boolean" ? (
                    <input type="checkbox" checked={Boolean(props[name] ?? def.default)} onChange={(e) => setProps({ ...props, [name]: e.target.checked })} />
                  ) : (
                    <input className="input" value={String(props[name] ?? def.default)} onChange={(e) => setProps({ ...props, [name]: e.target.value })} />
                  )}
                </div>
              ))}
              <div className="picker-footer">
                <span className="muted small">Inserts into {target}</span>
                <button className="btn btn-accent" onClick={insert}>
                  <CornerDownLeft size={14} /> Insert
                </button>
              </div>
            </>
          ) : (
            <p className="muted">Pick a component.</p>
          )}
        </div>
      </div>
    </div>
  );
}
