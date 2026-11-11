import type { DesignNode } from "@lamsa/schema";
import {
  ChevronRight,
  Component,
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  FileJson,
  Frame,
  Image as ImageIcon,
  Search,
  Shapes,
  Type,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { reparent } from "../lib/edits";
import { toggleFlag } from "../lib/commands";
import { shortcut } from "../lib/keys";
import {
  childrenOf,
  descendantsOf,
  hiddenByDefault,
  isComponent,
  isLocked,
  nodeTitle,
  rootOf,
} from "../lib/model";
import { useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";
import { insertInstance } from "./ComponentPicker";
import { cn } from "../lib/cn";

function NodeIcon({ node }: { node: DesignNode }) {
  if (node.type === "text") return <Type size={14} />;
  if (node.type === "image") return <ImageIcon size={14} />;
  if (node.type === "icon") return <Shapes size={14} />;
  if (node.type === "instance" || isComponent(node))
    return <Component size={14} className="accent" />;
  return <Frame size={14} />;
}

type Drop = { id: string; where: "before" | "after" | "inside" } | null;

export function LayersPanel() {
  const { leftTab, setLeftTab } = useEditor();
  return (
    <div className="panel panel-left" data-testid="layers-panel">
      <div className="tabs">
        {(["layers", "files", "components"] as const).map((tab) => (
          <button
            key={tab}
            className={cn("tab", { "is-active": leftTab === tab })}
            onClick={() => setLeftTab(tab)}
          >
            {tab[0]!.toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>
      {leftTab === "layers" && <LayersTree />}
      {leftTab === "files" && <FilesList />}
      {leftTab === "components" && <ComponentsList />}
    </div>
  );
}

function LayersTree() {
  const { model, selection, select, files, setHover, commit, previewProps } =
    useEditor();
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const anchor = useRef<string | null>(null);

  const matches = useMemo(() => {
    if (!filter) return null;
    const needle = filter.toLowerCase();
    const keep = new Set<string>();
    for (const [id, node] of Object.entries(model.nodes)) {
      if (`${nodeTitle(id, node)} ${id}`.toLowerCase().includes(needle)) {
        keep.add(id);
        let parent = node.parentId;
        while (parent) {
          keep.add(parent);
          parent = model.nodes[parent]?.parentId;
        }
      }
    }
    return keep;
  }, [filter, model]);

  const onDrop = () => {
    if (!dragging || !drop) return;
    const target = model.nodes[drop.id];
    if (!target) return;
    let changes;
    if (drop.where === "inside") {
      changes = reparent({
        model,
        id: dragging,
        parentId: drop.id,
        beforeId: null,
      });
    } else {
      const parentId = target.parentId;
      const siblings = parentId
        ? childrenOf(model, parentId)
        : model.roots.filter(
            (r) => model.fileOf.get(r) === model.fileOf.get(drop.id),
          );
      const position = siblings.indexOf(drop.id);
      const beforeId =
        drop.where === "before" ? drop.id : (siblings[position + 1] ?? null);
      changes = reparent({
        model,
        id: dragging,
        parentId,
        beforeId,
        file: model.fileOf.get(drop.id),
      });
    }
    setDragging(null);
    setDrop(null);
    void commit("Move layer", changes);
  };

  /** Layer ids in the order their rows appear, skipping collapsed and filtered-out rows. */
  const visibleOrder = (): string[] => {
    const order: string[] = [];
    const walk = (id: string) => {
      if (!model.nodes[id] || (matches && !matches.has(id))) return;
      order.push(id);
      if (!collapsed.has(id) || matches !== null)
        for (const kid of childrenOf(model, id)) walk(kid);
    };
    for (const path of Object.keys(files).sort())
      for (const id of model.roots) if (model.fileOf.get(id) === path) walk(id);
    return order;
  };

  const row = (id: string, depth: number): React.ReactNode => {
    const node = model.nodes[id];
    if (!node || (matches && !matches.has(id))) return null;
    const kids = childrenOf(model, id);
    const open = !collapsed.has(id) || matches !== null;
    const selected = selection.includes(id);
    const dropHere = drop?.id === id ? drop.where : null;
    const defaultHidden = hiddenByDefault(
      model,
      id,
      previewProps[rootOf(model, id)],
    );
    return (
      <div key={id}>
        <div
          className={cn("layer-row", dropHere && `drop-${dropHere}`, {
            "is-selected": selected,
            "is-hidden": node.hidden || defaultHidden,
            "is-locked": isLocked(model, id),
          })}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={(e) => {
            setDragging(id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (
              !dragging ||
              dragging === id ||
              descendantsOf(model, dragging).includes(id)
            )
              return;
            e.preventDefault();
            const rect = (
              e.currentTarget as HTMLElement
            ).getBoundingClientRect();
            const y = (e.clientY - rect.top) / rect.height;
            const canNest = node.type === "frame";
            setDrop({
              id,
              where:
                canNest && y > 0.3 && y < 0.7
                  ? "inside"
                  : y < 0.5
                    ? "before"
                    : "after",
            });
          }}
          onDragLeave={() => setDrop((d) => (d?.id === id ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            onDrop();
          }}
          onDragEnd={() => {
            setDragging(null);
            setDrop(null);
          }}
          onMouseEnter={() => setHover(id)}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            if (e.shiftKey) {
              const order = visibleOrder();
              const from = order.indexOf(
                anchor.current ?? selection.at(-1) ?? id,
              );
              const to = order.indexOf(id);
              if (from === -1 || to === -1) select([id]);
              else
                select(order.slice(Math.min(from, to), Math.max(from, to) + 1));
              return;
            }
            anchor.current = id;
            if (e.ctrlKey || e.metaKey)
              select(
                selected
                  ? selection.filter((s) => s !== id)
                  : [...selection, id],
              );
            else select([id]);
          }}
          onDoubleClick={() => fitTo("selection")}
          onContextMenu={(e) => {
            e.preventDefault();
            if (!selected) {
              anchor.current = id;
              select([id]);
            }
            useEditor.getState().setContextMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <span
            className={cn("twisty", { "is-empty": !kids.length, "is-open": open })}
            onClick={(e) => {
              e.stopPropagation();
              const next = new Set(collapsed);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setCollapsed(next);
            }}
          >
            <ChevronRight size={12} />
          </span>
          <NodeIcon node={node} />
          <span className="layer-name">{nodeTitle(id, node)}</span>
          {node.type === "instance" && (
            <span className="layer-meta">
              {nodeTitle(node.componentId, model.nodes[node.componentId])}
            </span>
          )}
          <span
            className="layer-actions"
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <button
              className={cn("layer-action", { "is-on": node.locked })}
              aria-label={node.locked ? "Unlock layer" : "Lock layer"}
              title={`${node.locked ? "Unlock" : "Lock"} (${shortcut("mod+shift+l")})`}
              onClick={(e) => {
                e.stopPropagation();
                void toggleFlag({ ids: [id], field: "locked" });
              }}
            >
              {node.locked ? <Lock size={12} /> : <LockOpen size={12} />}
            </button>
            {!node.hidden && defaultHidden ? (
              <button
                className="layer-action is-on is-locked-by-prop"
                aria-label="Hidden by a prop"
                title={`Hidden by a prop (${defaultHidden.prop} = ${String(defaultHidden.value)})`}
                disabled
              >
                <EyeOff size={12} />
              </button>
            ) : (
              <button
                className={cn("layer-action", { "is-on": node.hidden })}
                aria-label={node.hidden ? "Show layer" : "Hide layer"}
                title={`${node.hidden ? "Show" : "Hide"} (${shortcut("mod+shift+h")})`}
                onClick={(e) => {
                  e.stopPropagation();
                  void toggleFlag({ ids: [id], field: "hidden" });
                }}
              >
                {node.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            )}
          </span>
        </div>
        {open && kids.map((kid) => row(kid, depth + 1))}
      </div>
    );
  };

  const byFile = new Map<string, string[]>();
  for (const path of Object.keys(files).sort()) byFile.set(path, []);
  for (const id of model.roots) byFile.get(model.fileOf.get(id)!)?.push(id);

  return (
    <div className="panel-body">
      <label className="search">
        <Search size={14} />
        <input
          placeholder="Filter layers"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </label>
      <div className="layer-list">
        {[...byFile].map(([path, roots]) => (
          <div key={path}>
            <div className="layer-file">
              <FileJson size={14} />
              <span>{path.split("/").pop()}</span>
              {files[path]?.error && (
                <span className="badge badge-danger">invalid</span>
              )}
            </div>
            {roots.map((id) => row(id, 1))}
          </div>
        ))}
      </div>
    </div>
  );
}

function FilesList() {
  const { files, issues, model, select } = useEditor();
  return (
    <div className="panel-body">
      <div className="list">
        {Object.keys(files)
          .sort()
          .map((path) => {
            const fileIssues = issues.filter((i) => i.file === path);
            const roots = model.roots.filter(
              (id) => model.fileOf.get(id) === path,
            );
            return (
              <button
                key={path}
                className="list-row"
                onClick={() => {
                  select(roots);
                  requestAnimationFrame(() => fitTo("selection"));
                }}
              >
                <FileJson size={14} />
                <span className="list-main">
                  <span>{path.split("/").pop()}</span>
                  <span className="muted mono small">{path}</span>
                </span>
                <span className="muted small">{roots.length} top-level</span>
                {fileIssues.some((i) => i.severity === "error") && (
                  <span className="badge badge-danger">
                    {fileIssues.length}
                  </span>
                )}
              </button>
            );
          })}
      </div>
    </div>
  );
}

function ComponentsList() {
  const { model, select } = useEditor();
  const components = Object.entries(model.nodes).filter(
    ([, node]) =>
      isComponent(node) && !(node.type === "frame" && node.component?.internal),
  );
  return (
    <div className="panel-body">
      <div className="list">
        {components.length === 0 && (
          <p className="muted pad">
            No components yet. A top-level frame with a "component" block
            becomes one.
          </p>
        )}
        {components.map(([id, node]) => (
          <div key={id} className="list-row">
            <Component size={14} className="accent" />
            <span className="list-main">
              <span>{nodeTitle(id, node)}</span>
              <span className="muted mono small">{model.fileOf.get(id)}</span>
            </span>
            <button
              className="ghost-btn small"
              onClick={() => void insertInstance(id)}
            >
              Insert
            </button>
            <button
              className="ghost-btn small"
              onClick={() => {
                select([id]);
                requestAnimationFrame(() => fitTo("selection"));
              }}
            >
              Go to
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
