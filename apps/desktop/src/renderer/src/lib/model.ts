import { shareChildMap } from "@lamsa/renderer";
import type { DesignNode } from "@lamsa/schema";
import type { FileState } from "../../../shared/api";

export type NodeMap = Record<string, DesignNode>;

export interface Model {
  nodes: NodeMap;
  fileOf: Map<string, string>;
  roots: string[];
  children: Map<string, string[]>;
  /** Every file's `css` (its `@keyframes`), in path order. */
  fileCss: string;
}

const byIndex = (nodes: NodeMap) => (a: string, b: string) => {
  const ia = nodes[a]?.index ?? "";
  const ib = nodes[b]?.index ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

interface ModelBasis {
  open: readonly string[] | null | undefined;
  /** Nodes whose `parentId` names a node that doesn't exist: neither roots nor anyone's children. */
  orphans: Set<string>;
}

/** What `updateModel` needs beyond the model itself, kept out of `Model` so the model stays plain data. */
const bases = new WeakMap<Model, ModelBasis>();

function rootOrder({ nodes, fileOf }: Pick<Model, "nodes" | "fileOf">) {
  const order = byIndex(nodes);
  return (a: string, b: string) => {
    const fa = fileOf.get(a)!;
    const fb = fileOf.get(b)!;
    return fa < fb ? -1 : fa > fb ? 1 : order(a, b);
  };
}

function joinFileCss(files: Record<string, FileState>): string {
  return Object.keys(files)
    .sort()
    .map((path) => files[path]!.css ?? "")
    .filter((css) => css.trim())
    .join("\n");
}

function finish({ model, basis }: { model: Model; basis: ModelBasis }): Model {
  bases.set(model, basis);
  shareChildMap(model.nodes, model.children);
  return model;
}

/**
 * Every file's nodes are indexed (instances need components from files that aren't open), but only
 * frames in `open` files are roots, i.e. shown on the canvas and in the layers list. `null` means the
 * user hasn't picked files yet, so nothing is shown; leaving it out shows everything.
 */
export function buildModel(files: Record<string, FileState>, open?: readonly string[] | null): Model {
  const shown = open === undefined ? null : new Set(open ?? []);
  const nodes: NodeMap = {};
  const fileOf = new Map<string, string>();
  for (const path of Object.keys(files).sort()) {
    for (const [id, node] of Object.entries(files[path]!.nodes)) {
      if (fileOf.has(id)) continue;
      nodes[id] = node;
      fileOf.set(id, path);
    }
  }
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  const orphans = new Set<string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === undefined) {
      if (!shown || shown.has(fileOf.get(id)!)) roots.push(id);
      continue;
    }
    if (!nodes[node.parentId]) {
      orphans.add(id);
      continue;
    }
    const list = children.get(node.parentId) ?? [];
    list.push(id);
    children.set(node.parentId, list);
  }
  const order = byIndex(nodes);
  for (const list of children.values()) list.sort(order);
  roots.sort(rootOrder({ nodes, fileOf }));
  return finish({ model: { nodes, fileOf, roots, children, fileCss: joinFileCss(files) }, basis: { open, orphans } });
}

function sameOpen(a: readonly string[] | null | undefined, b: readonly string[] | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((path, i) => path === b[i]);
}

/**
 * The model for `files` when only the nodes in `changedIds` (in any file) were added, edited or removed since
 * `previous` was built. Same result as `buildModel`, but every node, owner and child list those ids don't
 * touch is carried over as is, so an edit costs what it changed rather than the size of the project.
 */
export function updateModel({
  previous,
  files,
  changedIds,
  open,
}: {
  previous: Model;
  files: Record<string, FileState>;
  changedIds: Iterable<string>;
  open?: readonly string[] | null;
}): Model {
  const basis = bases.get(previous);
  if (!basis || !sameOpen(basis.open, open)) return buildModel(files, open);
  const changed = new Set(changedIds);
  if (changed.size === 0) return finish({ model: { ...previous, fileCss: joinFileCss(files) }, basis });

  const paths = Object.keys(files).sort();
  const nodes: NodeMap = { ...previous.nodes };
  const fileOf = new Map(previous.fileOf);
  for (const id of changed) {
    const owner = paths.find((path) => files[path]!.nodes[id] !== undefined);
    if (owner === undefined) {
      delete nodes[id];
      fileOf.delete(id);
    } else {
      nodes[id] = files[owner]!.nodes[id]!;
      fileOf.set(id, owner);
    }
  }

  const children = new Map(previous.children);
  const orphans = new Set(basis.orphans);
  const parentsToList = new Set<string>();
  const appeared = new Set<string>();
  for (const id of changed) {
    const before = previous.nodes[id];
    const after = nodes[id];
    if (before?.parentId !== undefined) parentsToList.add(before.parentId);
    if (after?.parentId !== undefined) parentsToList.add(after.parentId);
    if (before && !after) {
      for (const kid of previous.children.get(id) ?? []) if (!changed.has(kid)) orphans.add(kid);
      children.delete(id);
    }
    if (!before && after) {
      appeared.add(id);
      parentsToList.add(id);
    }
    if (after?.parentId !== undefined && !nodes[after.parentId]) orphans.add(id);
    else orphans.delete(id);
  }
  const adopted: string[] = [];
  if (appeared.size) {
    for (const id of orphans) {
      if (!appeared.has(nodes[id]!.parentId!)) continue;
      orphans.delete(id);
      adopted.push(id);
    }
  }

  const order = byIndex(nodes);
  const childOf = (parentId: string) => (id: string) => nodes[id]?.parentId === parentId;
  for (const parentId of parentsToList) {
    if (!nodes[parentId]) {
      children.delete(parentId);
      continue;
    }
    const kept = (previous.children.get(parentId) ?? []).filter((id) => !changed.has(id));
    const list = [...kept, ...[...changed].filter(childOf(parentId)), ...adopted.filter(childOf(parentId))];
    if (list.length) children.set(parentId, list.sort(order));
    else children.delete(parentId);
  }

  const shown = open === undefined ? null : new Set(open ?? []);
  const isRoot = (id: string) => nodes[id] !== undefined && nodes[id]!.parentId === undefined && (!shown || shown.has(fileOf.get(id)!));
  const roots = [...previous.roots.filter((id) => !changed.has(id)), ...[...changed].filter(isRoot)];
  roots.sort(rootOrder({ nodes, fileOf }));
  return finish({ model: { nodes, fileOf, roots, children, fileCss: joinFileCss(files) }, basis: { open, orphans } });
}

export function childrenOf(model: Model, id: string): string[] {
  return model.children.get(id) ?? [];
}

export function descendantsOf(model: Model, id: string): string[] {
  const result: string[] = [];
  const stack = [...childrenOf(model, id)].reverse();
  while (stack.length) {
    const next = stack.pop()!;
    result.push(next);
    const kids = childrenOf(model, next);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }
  return result;
}

export function ancestorsOf(model: Model, id: string): string[] {
  const result: string[] = [];
  let current = model.nodes[id]?.parentId;
  while (current !== undefined && !result.includes(current)) {
    result.push(current);
    current = model.nodes[current]?.parentId;
  }
  return result;
}

export function rootOf(model: Model, id: string): string {
  const chain = ancestorsOf(model, id);
  return chain.length ? chain[chain.length - 1]! : id;
}

/** Instance internals are addressed `<instanceId>/<innerId>`; the base is the real node. */
export function baseId(displayId: string): string {
  return displayId.split("/")[0]!;
}

export function nodeTitle(id: string, node: DesignNode | undefined): string {
  if (!node) return id;
  if (node.name) return node.name;
  if (node.type === "text") return node.content.slice(0, 40) || "Text";
  if (node.type === "icon") return node.icon;
  if (node.type === "image") return node.src.split("/").pop() ?? "Image";
  if (node.type === "instance") return "Instance";
  return "Frame";
}

/** A layer is locked when it, or any layer it sits inside, has `locked: true`. */
export function isLocked(model: Model, id: string): boolean {
  if (model.nodes[id]?.locked) return true;
  return ancestorsOf(model, id).some((ancestor) => model.nodes[ancestor]?.locked);
}

export function isComponent(node: DesignNode | undefined): boolean {
  return node?.type === "frame" && !!node.component;
}

/** Every icon `nodes` can show: icon layers, and icons set by component prop overrides and instance overrides. */
export function iconNamesIn(nodes: Iterable<DesignNode>): string[] {
  const names = new Set<string>();
  for (const node of nodes) {
    if (node.type === "icon") names.add(node.icon);
    else if (node.type === "frame" && node.component) {
      for (const prop of Object.values(node.component.props ?? {})) {
        const groups = prop.type === "enum" ? Object.values(prop.overrides ?? {}) : prop.type === "boolean" ? Object.values(prop.overrides ?? {}) : [];
        for (const patches of groups) for (const patch of Object.values(patches ?? {})) if (patch.icon) names.add(patch.icon);
      }
    } else if (node.type === "instance") {
      for (const patch of Object.values(node.overrides ?? {})) if (patch.icon) names.add(patch.icon);
    }
  }
  return [...names];
}

export interface FileRegion {
  file: string;
  dx: number;
  left: number;
  top: number;
  /** World-space room to the right before the next file's frames start; Infinity for the last file. */
  room: number;
}

const FILE_GAP = 200;
const placedOffsets = new Map<string, number>();
let placedProject: string | undefined;

/**
 * Files sit side by side on the canvas; each file's own x/y are offset by `dx`.
 * A file keeps the offset it got when it first appeared, so moving its frames never shifts the file
 * (or the files next to it) under the pointer. The one exception is an overlap: when a file grows or
 * is moved into the next one, the next one is pushed right just far enough to clear it. A file that
 * is closed forgets its place, so reopening it puts it after the files that are open.
 *
 * `widthOf` gives a frame's rendered width when it's on screen; until then a fixed width is used.
 */
export function fileRegions(model: Model, project?: string, widthOf?: (id: string) => number | undefined): Map<string, FileRegion> {
  if (project !== placedProject) {
    placedOffsets.clear();
    placedProject = project;
  }
  const extents = new Map<string, { minX: number; maxX: number; minY: number }>();
  for (const id of model.roots) {
    const file = model.fileOf.get(id)!;
    const node = model.nodes[id]!;
    const width = widthOf?.(id) || (typeof node.style?.width === "number" ? node.style.width : 400);
    const extent = extents.get(file) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity };
    extent.minX = Math.min(extent.minX, node.x ?? 0);
    extent.maxX = Math.max(extent.maxX, (node.x ?? 0) + width);
    extent.minY = Math.min(extent.minY, node.y ?? 0);
    extents.set(file, extent);
  }
  for (const file of [...placedOffsets.keys()]) if (!extents.has(file)) placedOffsets.delete(file);
  let right = -Infinity;
  for (const [file, extent] of extents) {
    const dx = placedOffsets.get(file);
    if (dx !== undefined) right = Math.max(right, extent.maxX + dx);
  }
  for (const [file, extent] of extents) {
    if (placedOffsets.has(file)) continue;
    const dx = (right === -Infinity ? 0 : right + FILE_GAP) - extent.minX;
    placedOffsets.set(file, dx);
    right = extent.maxX + dx;
  }
  const ordered = [...extents].sort(([a, ea], [b, eb]) => ea.minX + placedOffsets.get(a)! - (eb.minX + placedOffsets.get(b)!));
  let edge = -Infinity;
  for (const [file, extent] of ordered) {
    let dx = placedOffsets.get(file)!;
    if (edge !== -Infinity && extent.minX + dx < edge + FILE_GAP) {
      dx = edge + FILE_GAP - extent.minX;
      placedOffsets.set(file, dx);
    }
    edge = Math.max(edge, extent.maxX + dx);
  }
  const regions = new Map<string, FileRegion>();
  const lefts = [...extents].map(([file, extent]) => extent.minX + placedOffsets.get(file)!);
  for (const [file, extent] of extents) {
    const dx = placedOffsets.get(file)!;
    const left = extent.minX + dx;
    const nextLeft = Math.min(...lefts.filter((other) => other > left));
    regions.set(file, { file, dx, left, top: extent.minY, room: nextLeft - left });
  }
  return regions;
}

export interface DefaultHidden {
  componentId: string;
  prop: string;
  /** The prop's default, which hides the layer. */
  value: string | boolean;
  /** A prop value that shows the layer, when one exists. */
  showWith?: string | boolean;
}

/**
 * Why a layer inside a main component is invisible on the canvas: the component's default
 * props hide it (or one of its ancestors). Instances that pick another value still show it.
 */
export function hiddenByDefault(model: Model, id: string, preview: Record<string, string | boolean> = {}): DefaultHidden | null {
  const componentId = rootOf(model, id);
  const component = model.nodes[componentId];
  if (component?.type !== "frame" || !component.component) return null;
  const chain = [id, ...ancestorsOf(model, id)];
  const hides = (patches: Record<string, { hidden?: boolean }> | undefined) => chain.some((n) => patches?.[n]?.hidden);
  for (const [prop, def] of Object.entries(component.component.props ?? {})) {
    if (def.type === "boolean") {
      const current = typeof preview[prop] === "boolean" ? (preview[prop] as boolean) : def.default;
      if (!hides(current ? def.overrides?.true : def.overrides?.false)) continue;
      const other = !current;
      return { componentId, prop, value: current, showWith: hides(other ? def.overrides?.true : def.overrides?.false) ? undefined : other };
    }
    if (def.type === "enum") {
      const current = typeof preview[prop] === "string" ? (preview[prop] as string) : def.default;
      if (!hides(def.overrides?.[current])) continue;
      return { componentId, prop, value: current, showWith: def.options.find((option) => !hides(def.overrides?.[option])) };
    }
  }
  return null;
}
