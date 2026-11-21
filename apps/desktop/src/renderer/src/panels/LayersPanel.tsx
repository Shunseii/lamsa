import { useShallow } from "zustand/react/shallow";
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
  X,
} from "lucide-react";
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { reparent } from "../lib/edits";
import type { NodeChange } from "../../../shared/api";
import { toggleFlag } from "../lib/commands";
import { shortcut } from "../lib/keys";
import {
  ancestorsOf,
  childrenOf,
  descendantsOf,
  hiddenByDefault,
  isComponent,
  isLocked,
  nodeTitle,
  rootOf,
  type Model,
} from "../lib/model";
import { useEditor } from "../lib/store";
import { fitTo } from "../lib/viewport";
import { AddFileMenu, closedFiles, revealFiles } from "./AddFileMenu";
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
  return (
    <div className="dock-body" data-testid="layers-panel">
      <LayersTree />
    </div>
  );
}

export function FilesPanel() {
  return (
    <div className="dock-body" data-testid="files-panel">
      <FilesList />
    </div>
  );
}

export function ComponentsPanel() {
  return (
    <div className="dock-body" data-testid="components-panel">
      <ComponentsList />
    </div>
  );
}

const LOCK_SHORTCUT = shortcut("mod+shift+l");
const HIDE_SHORTCUT = shortcut("mod+shift+h");

interface RowHandlers {
  click(event: React.MouseEvent, id: string): void;
  contextMenu(event: React.MouseEvent, id: string): void;
  toggleCollapsed(id: string): void;
  dragStart(event: React.DragEvent, id: string): void;
  dragOver(event: React.DragEvent, id: string): void;
  dragLeave(id: string): void;
  drop(event: React.DragEvent): void;
  dragEnd(): void;
}

interface LayerRowProps {
  id: string;
  depth: number;
  model: Model;
  preview: Record<string, string | boolean> | undefined;
  selected: boolean;
  open: boolean;
  dropHere: "before" | "after" | "inside" | null;
  handlers: React.RefObject<RowHandlers | null>;
}

/** One row of the tree. Memoised so a selection or hover change re-renders only the rows it touches. */
const LayerRow = memo(function LayerRow({ id, depth, model, preview, selected, open, dropHere, handlers }: LayerRowProps) {
  const node = model.nodes[id]!;
  const hasKids = childrenOf(model, id).length > 0;
  const defaultHidden = hiddenByDefault(model, id, preview);
  const on = () => handlers.current!;
  return (
    <div
      className={cn("layer-row", dropHere && `drop-${dropHere}`, {
        "is-selected": selected,
        "is-hidden": node.hidden || defaultHidden,
        "is-locked": isLocked(model, id),
      })}
      data-layer-id={id}
      draggable
      onDragStart={(e) => on().dragStart(e, id)}
      onDragOver={(e) => on().dragOver(e, id)}
      onDragLeave={() => on().dragLeave(id)}
      onDrop={(e) => on().drop(e)}
      onDragEnd={() => on().dragEnd()}
      onMouseEnter={() => useEditor.getState().setHover(id)}
      onMouseLeave={() => useEditor.getState().setHover(null)}
      onClick={(e) => on().click(e, id)}
      onDoubleClick={() => fitTo("selection")}
      onContextMenu={(e) => on().contextMenu(e, id)}
    >
      <span
        className={cn("twisty", { "is-empty": !hasKids, "is-open": open })}
        style={{ marginLeft: depth * INDENT }}
        onClick={(e) => {
          e.stopPropagation();
          on().toggleCollapsed(id);
        }}
      >
        <ChevronRight size={12} />
      </span>
      <NodeIcon node={node} />
      <span className="layer-name">{nodeTitle(id, node)}</span>
      <span className="layer-trail">
        {node.type === "instance" && (
          <span className="layer-meta">{nodeTitle(node.componentId, model.nodes[node.componentId])}</span>
        )}
        <span className="layer-actions" onDoubleClick={(e) => e.stopPropagation()}>
          <button
            className={cn("layer-action", { "is-on": node.locked })}
            aria-label={node.locked ? "Unlock layer" : "Lock layer"}
            title={`${node.locked ? "Unlock" : "Lock"} (${LOCK_SHORTCUT})`}
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
              title={`${node.hidden ? "Show" : "Hide"} (${HIDE_SHORTCUT})`}
              onClick={(e) => {
                e.stopPropagation();
                void toggleFlag({ ids: [id], field: "hidden" });
              }}
            >
              {node.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
        </span>
      </span>
    </div>
  );
});

type ListItem = { kind: "file"; path: string } | { kind: "row"; id: string; depth: number; open: boolean };

/** Heights from styles.css: `.layer-file` is 34px tall; `.layer-row` is 28px plus a 2px bottom margin. */
const FILE_HEIGHT = 34;
const ROW_HEIGHT = 28;
const ROW_PITCH = 30;
/** Lists up to this long render every row; longer ones render the rows in view plus this margin. */
const RENDER_ALL_BELOW = 400;
const OVERSCAN_PX = 600;

/** Row geometry from styles.css, used to size the list's scroll width without measuring rows. Each level indents the twisty (a margin, not row padding, so the pinned trail can slide over the indent). */
const LIST_PADDING = 6;
const ROW_INSET = 8;
const INDENT = 14;
/** Twisty and type icon (14px each), each followed by the row's 6px gap. */
const ROW_LEAD = 40;
const NAME_MIN = 64;
/** Once the list scrolls sideways anyway, the deepest names get this much room instead. */
const NAME_ROOMY = 160;
/** The 6px gap, the lock and hide buttons (20px + 1px + 20px), and the row's 8px right padding. */
const ROW_TRAIL = 55;

/** Width of the list content: the panel's width while every row keeps its minimum name width, wider (with roomier names) once the deepest row doesn't fit. */
function contentWidth({ deepest, viewWidth }: { deepest: number; viewWidth: number }) {
  const rowWithoutName = LIST_PADDING * 2 + ROW_INSET + deepest * INDENT + ROW_LEAD + ROW_TRAIL;
  return rowWithoutName + NAME_MIN <= viewWidth ? 0 : rowWithoutName + NAME_ROOMY;
}

/** Scrolls the list sideways so a row's twisty, icon and the start of its name are in view, keeping two levels of indent for context. */
function revealHorizontally({ scroller, depth }: { scroller: HTMLElement; depth: number }) {
  const rowStart = LIST_PADDING + ROW_INSET + depth * INDENT;
  const nameEnd = rowStart + ROW_LEAD + NAME_MIN;
  const visibleEnd = scroller.scrollLeft + scroller.clientWidth - ROW_TRAIL - LIST_PADDING;
  if (rowStart < scroller.scrollLeft || nameEnd > visibleEnd) scroller.scrollLeft = rowStart - INDENT * 2;
}

const itemHeight = (item: ListItem) => (item.kind === "file" ? FILE_HEIGHT : ROW_PITCH);

/** Index of the last item starting at or above `y`. */
function itemAt(offsets: number[], y: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** Where the list starts inside its scrolling panel body, below the sticky search row. */
function listTopIn(scroller: HTMLElement, list: HTMLElement): number {
  return list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

function LayersTree() {
  const { model, selection, select, files, commit, previewProps, openFiles, closeFile } = useEditor(
    useShallow((s) => ({ model: s.model, selection: s.selection, select: s.select, files: s.files, commit: s.commit, previewProps: s.previewProps, openFiles: s.openFiles, closeFile: s.closeFile })),
  );
  const [filter, setFilter] = useState("");
  const appliedFilter = useDeferredValue(filter);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const anchor = useRef<string | null>(null);

  const matches = useMemo(() => {
    if (!appliedFilter) return null;
    const needle = appliedFilter.toLowerCase();
    const keep = new Set<string>();
    for (const [id, node] of Object.entries(model.nodes)) {
      if (`${nodeTitle(id, node)} ${id}`.toLowerCase().includes(needle)) {
        keep.add(id);
        let parent = node.parentId;
        while (parent && !keep.has(parent)) {
          keep.add(parent);
          parent = model.nodes[parent]?.parentId;
        }
      }
    }
    return keep;
  }, [appliedFilter, model]);

  /** File headers and rows in display order, skipping collapsed and filtered-out layers, and the depth of the deepest row. */
  const { items, deepest } = useMemo(() => {
    const result: ListItem[] = [];
    let deepest = 0;
    for (const path of [...(openFiles ?? [])].sort()) {
      result.push({ kind: "file", path });
      const walk = (id: string, depth: number) => {
        if (!model.nodes[id] || (matches && !matches.has(id))) return;
        const open = !collapsed.has(id) || matches !== null;
        result.push({ kind: "row", id, depth, open });
        if (depth > deepest) deepest = depth;
        if (open) for (const kid of childrenOf(model, id)) walk(kid, depth + 1);
      };
      for (const id of model.roots) if (model.fileOf.get(id) === path) walk(id, 1);
    }
    return { items: result, deepest };
  }, [openFiles, model, matches, collapsed]);

  const offsets = useMemo(() => {
    const result: number[] = [];
    let y = 0;
    for (const item of items) {
      result.push(y);
      y += itemHeight(item);
    }
    result.push(y);
    return result;
  }, [items]);

  const selected = useMemo(() => new Set(selection), [selection]);
  const draggedSubtree = useMemo(() => new Set(dragging ? descendantsOf(model, dragging) : []), [dragging, model]);

  const list = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, width: 0 });
  const measureView = () => {
    const scroller = scrollerRef.current;
    if (!scroller || !list.current) return;
    const top = scroller.scrollTop - listTopIn(scroller, list.current);
    const { clientHeight: height, clientWidth: width } = scroller;
    setView((current) => (current.top === top && current.height === height && current.width === width ? current : { top, height, width }));
  };
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    measureView();
    const observer = new ResizeObserver(measureView);
    observer.observe(scroller);
    scroller.addEventListener("scroll", measureView, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measureView);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderAll = items.length <= RENDER_ALL_BELOW;
  const first = renderAll ? 0 : itemAt(offsets, Math.max(0, view.top - OVERSCAN_PX));
  const last = renderAll ? items.length - 1 : itemAt(offsets, view.top + view.height + OVERSCAN_PX);
  const shown = items.slice(first, last + 1);

  // Selecting a layer outside this list (canvas, preview, agent) opens its collapsed parents and scrolls its row to the middle.
  const reveal = useRef<string | null>(null);
  /** The row last clicked here; selecting it needs no scroll, since it is already under the pointer. */
  const clickedInList = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = selection.at(-1);
    const fromList = id !== undefined && clickedInList.current === id;
    clickedInList.current = null;
    if (fromList || !id || !model.nodes[id]) return;
    reveal.current = id;
    const closed = ancestorsOf(model, id).filter((a) => collapsed.has(a));
    if (closed.length) setCollapsed((current) => new Set([...current].filter((c) => !closed.includes(c))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  // Runs after the effect above, and again once opened parents have put the row in the list.
  useLayoutEffect(() => {
    const id = reveal.current;
    if (!id) return;
    const index = items.findIndex((item) => item.kind === "row" && item.id === id);
    const item = items[index];
    const scroller = scrollerRef.current;
    if (index === -1 || !scroller || !list.current) return;
    reveal.current = null;
    const rowMiddle = listTopIn(scroller, list.current) + offsets[index]! + ROW_HEIGHT / 2;
    scroller.scrollTop = rowMiddle - scroller.getBoundingClientRect().height / 2;
    if (item?.kind === "row") revealHorizontally({ scroller, depth: item.depth });
    measureView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, items]);

  // A dragged row can scroll out of the rendered range and unmount, and then it gets no dragend.
  useEffect(() => {
    if (!dragging) return;
    const end = () => {
      setDragging(null);
      setDrop(null);
    };
    window.addEventListener("dragend", end);
    return () => window.removeEventListener("dragend", end);
  }, [dragging]);

  const onDrop = () => {
    if (!dragging || !drop) return;
    const target = model.nodes[drop.id];
    if (!target) return;
    let changes: NodeChange[];
    if (drop.where === "inside") {
      changes = reparent({ model, id: dragging, parentId: drop.id, beforeId: null });
    } else {
      const parentId = target.parentId;
      const siblings = parentId
        ? childrenOf(model, parentId)
        : model.roots.filter((r) => model.fileOf.get(r) === model.fileOf.get(drop.id));
      const position = siblings.indexOf(drop.id);
      const beforeId = drop.where === "before" ? drop.id : (siblings[position + 1] ?? null);
      changes = reparent({ model, id: dragging, parentId, beforeId, file: model.fileOf.get(drop.id) });
    }
    setDragging(null);
    setDrop(null);
    void commit("Move layer", changes);
  };

  const handlers = useRef<RowHandlers>(null);
  handlers.current = {
    click(e, id) {
      const pick = (ids: string[]) => {
        clickedInList.current = ids.at(-1) ?? null;
        select(ids);
      };
      if (e.shiftKey) {
        const order = items.flatMap((item) => (item.kind === "row" ? [item.id] : []));
        const from = order.indexOf(anchor.current ?? selection.at(-1) ?? id);
        const to = order.indexOf(id);
        if (from === -1 || to === -1) pick([id]);
        else pick(order.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
      anchor.current = id;
      if (e.ctrlKey || e.metaKey) pick(selected.has(id) ? selection.filter((s) => s !== id) : [...selection, id]);
      else pick([id]);
    },
    contextMenu(e, id) {
      e.preventDefault();
      clickedInList.current = id;
      if (!selected.has(id)) {
        anchor.current = id;
        select([id]);
      }
      useEditor.getState().setContextMenu({ x: e.clientX, y: e.clientY });
    },
    toggleCollapsed(id) {
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCollapsed(next);
    },
    dragStart(e, id) {
      setDragging(id);
      e.dataTransfer.effectAllowed = "move";
    },
    dragOver(e, id) {
      if (!dragging || dragging === id || draggedSubtree.has(id)) return;
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const y = (e.clientY - rect.top) / rect.height;
      const canNest = model.nodes[id]?.type === "frame";
      const where = canNest && y > 0.3 && y < 0.7 ? "inside" : y < 0.5 ? "before" : "after";
      if (drop?.id !== id || drop.where !== where) setDrop({ id, where });
    },
    dragLeave(id) {
      setDrop((d) => (d?.id === id ? null : d));
    },
    drop(e) {
      e.preventDefault();
      onDrop();
    },
    dragEnd() {
      setDragging(null);
      setDrop(null);
    },
  };

  /** Wide enough for the deepest row; the visible width lets the search row and file headers stay put while it scrolls sideways. */
  const contentStyle = {
    minWidth: contentWidth({ deepest, viewWidth: view.width }),
    ...(view.width > 0 && { "--layers-view-w": `${view.width}px` }),
  } as React.CSSProperties;

  return (
    <div ref={scrollerRef} className="panel-body layers-body">
      <div className="layers-content" style={contentStyle}>
      <div className="search-row">
        <label className="search">
          <Search size={14} />
          <input placeholder="Filter layers" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <AddFileMenu appearance="icon" />
      </div>
      <div ref={list} className="layer-list">
        {first > 0 && <div aria-hidden style={{ height: offsets[first] }} />}
        {shown.map((item) =>
          item.kind === "file" ? (
            <div key={`file:${item.path}`} className="layer-file" title={item.path}>
              <FileJson size={14} />
              <span>{item.path.split("/").pop()}</span>
              {files[item.path]?.error && <span className="badge badge-danger">invalid</span>}
              <button className="icon-btn tiny layer-file-close push-right" onClick={() => void closeFile(item.path)} aria-label={`Close ${item.path}`} title="Close file (it stays on disk)">
                <X size={12} />
              </button>
            </div>
          ) : (
            <LayerRow
              key={item.id}
              id={item.id}
              depth={item.depth}
              model={model}
              preview={previewProps[rootOf(model, item.id)]}
              selected={selected.has(item.id)}
              open={item.open}
              dropHere={drop?.id === item.id ? drop.where : null}
              handlers={handlers}
            />
          ),
        )}
        {last < items.length - 1 && <div aria-hidden style={{ height: offsets[items.length]! - offsets[last + 1]! }} />}
      </div>
      </div>
    </div>
  );
}

function FilesList() {
  const { files, issues, model, select, openFiles, closeFile, addFiles } = useEditor(
    useShallow((s) => ({ files: s.files, issues: s.issues, model: s.model, select: s.select, openFiles: s.openFiles, closeFile: s.closeFile, addFiles: s.addFiles })),
  );
  const closed = closedFiles(files, openFiles);
  return (
    <div className="panel-body">
      <div className="list" data-testid="open-files">
        {[...(openFiles ?? [])].sort().map((path) => {
          const fileIssues = issues.filter((i) => i.file === path);
          const roots = model.roots.filter((id) => model.fileOf.get(id) === path);
          return (
            <div key={path} className="list-row file-row" data-file={path}>
              <button
                className="file-open"
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
                {fileIssues.some((i) => i.severity === "error") && <span className="badge badge-danger">{fileIssues.length}</span>}
              </button>
              <button className="icon-btn tiny file-close" onClick={() => void closeFile(path)} aria-label={`Close ${path}`} title="Close file (it stays on disk)">
                <X size={12} />
              </button>
            </div>
          );
        })}
        <div className="files-add">
          <AddFileMenu />
        </div>
        {closed.length > 0 && (
          <>
            <div className="files-heading">Not open</div>
            {closed.map((path) => (
              <button
                key={path}
                className="list-row is-closed"
                data-file={path}
                title="Open this file"
                onClick={() => void addFiles([path]).then(() => revealFiles([path]))}
              >
                <FileJson size={14} />
                <span className="list-main">
                  <span>{path.split("/").pop()}</span>
                  <span className="muted mono small">{path}</span>
                </span>
                <span className="muted small">open</span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function ComponentsList() {
  const { model, select } = useEditor(
    useShallow((s) => ({ model: s.model, select: s.select })),
  );
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
