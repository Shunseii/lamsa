import { applyPatch, instancePatches } from "@lamsa/renderer";
import type { DesignNode, Style } from "@lamsa/schema";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { customAlphabet } from "nanoid";
import type { NodeChange } from "../../../shared/api";
import { childrenOf, descendantsOf, isComponent, type Model } from "./model";

const nanoid = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 8);

export function newId(model: Model, taken: Set<string> = new Set()): string {
  for (;;) {
    const id = nanoid();
    if (!model.nodes[id] && !taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

function change(model: Model, id: string, node: DesignNode | null, file?: string): NodeChange {
  return { file: file ?? model.fileOf.get(id)!, id, node };
}

export function patchNodes(model: Model, ids: string[], patch: (node: DesignNode) => DesignNode): NodeChange[] {
  return ids.filter((id) => model.nodes[id]).map((id) => change(model, id, patch(model.nodes[id]!)));
}

export function setStyle(model: Model, ids: string[], values: Record<string, string | number | undefined>): NodeChange[] {
  return patchNodes(model, ids, (node) => {
    const style: Style = { ...node.style };
    for (const [property, value] of Object.entries(values)) {
      if (value === undefined || value === "") delete style[property];
      else style[property] = value;
    }
    const next = { ...node, style } as DesignNode;
    if (Object.keys(style).length === 0) delete (next as { style?: Style }).style;
    return next;
  });
}

/** Parses a field value: plain numbers become px numbers, everything else stays a string. */
export function parseStyleInput(raw: string): string | number | undefined {
  const value = raw.trim();
  if (value === "") return undefined;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (/^-?\d+(\.\d+)?px$/.test(value)) return Number(value.slice(0, -2));
  return value;
}

export function siblingKeyRange(
  model: Model,
  parentId: string | undefined,
  beforeId: string | null,
  exclude: Set<string> = new Set(),
): { low: string | null; high: string | null } {
  const siblings = (parentId === undefined ? model.roots : childrenOf(model, parentId)).filter((id) => !exclude.has(id));
  const key = (id: string | undefined) => (id ? (model.nodes[id]?.index ?? null) : null);
  if (beforeId === null) return { low: key(siblings.at(-1)), high: null };
  const position = siblings.indexOf(beforeId);
  if (position === -1) return { low: key(siblings.at(-1)), high: null };
  const low = key(siblings[position - 1]);
  const high = key(beforeId);
  if (low !== null && high !== null && low >= high) return { low: null, high };
  return { low, high };
}

export interface NewNode {
  id: string;
  node: DesignNode;
}

/** Inserts root-level entries under `parentId` (or top level in `file`) before `beforeId` (null = end). */
export function insertNodes({
  model,
  entries,
  parentId,
  file,
  beforeId = null,
}: {
  model: Model;
  entries: { root: NewNode; descendants?: NewNode[] }[];
  parentId?: string;
  file?: string;
  beforeId?: string | null;
}): NodeChange[] {
  const target = parentId !== undefined ? model.fileOf.get(parentId)! : file!;
  const { low, high } = siblingKeyRange(model, parentId, beforeId);
  const keys = generateNKeysBetween(low, high, entries.length);
  const changes: NodeChange[] = [];
  entries.forEach((entry, i) => {
    const root = { ...entry.root.node, index: keys[i] } as DesignNode;
    if (parentId !== undefined) root.parentId = parentId;
    else delete root.parentId;
    changes.push({ file: target, id: entry.root.id, node: root });
    for (const descendant of entry.descendants ?? []) changes.push({ file: target, id: descendant.id, node: descendant.node });
  });
  return changes;
}

export function deleteSubtrees(model: Model, ids: string[]): NodeChange[] {
  const all = new Set<string>();
  for (const id of ids) {
    if (!model.nodes[id]) continue;
    all.add(id);
    for (const d of descendantsOf(model, id)) all.add(d);
  }
  return [...all].map((id) => change(model, id, null));
}

/** Topmost IDs: drops any selected node whose ancestor is also selected. */
export function topmost(model: Model, ids: string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => {
    let parent = model.nodes[id]?.parentId;
    while (parent !== undefined) {
      if (set.has(parent)) return false;
      parent = model.nodes[parent]?.parentId;
    }
    return true;
  });
}

/** Points a copied component's prop targets and overrides at the copies of its inner nodes. Mutates `node`. */
function remapComponentRefs(node: DesignNode, mapping: Map<string, string>): DesignNode {
  if (node.type !== "frame" || !node.component) return node;
  for (const prop of Object.values(node.component.props ?? {})) {
    if (prop.type === "text") prop.target = mapping.get(prop.target) ?? prop.target;
    const groups = prop.type === "enum" ? prop.overrides : prop.type === "boolean" ? prop.overrides : undefined;
    for (const [key, patches] of Object.entries(groups ?? {})) {
      if (!patches) continue;
      (groups as Record<string, Record<string, unknown>>)[key] = Object.fromEntries(
        Object.entries(patches).map(([target, patch]) => [mapping.get(target) ?? target, patch]),
      );
    }
  }
  return node;
}

export function cloneSubtree(model: Model, id: string, taken = new Set<string>()): { root: NewNode; descendants: NewNode[] } {
  const mapping = new Map<string, string>([[id, newId(model, taken)]]);
  for (const d of descendantsOf(model, id)) mapping.set(d, newId(model, taken));
  const remap = (node: DesignNode): DesignNode => {
    const next = remapComponentRefs(structuredClone(node), mapping);
    if (next.parentId && mapping.has(next.parentId)) next.parentId = mapping.get(next.parentId);
    return next;
  };
  const root = { id: mapping.get(id)!, node: remap(model.nodes[id]!) };
  const descendants = descendantsOf(model, id).map((d) => ({ id: mapping.get(d)!, node: remap(model.nodes[d]!) }));
  return { root, descendants };
}

export function duplicate(model: Model, ids: string[]): { changes: NodeChange[]; created: string[] } {
  const changes: NodeChange[] = [];
  const created: string[] = [];
  const taken = new Set<string>();
  for (const id of topmost(model, ids)) {
    const node = model.nodes[id]!;
    const clone = cloneSubtree(model, id, taken);
    if (node.parentId === undefined) {
      const width = typeof node.style?.width === "number" ? node.style.width : 400;
      clone.root.node = { ...clone.root.node, x: (node.x ?? 0) + width + 80 } as DesignNode;
      changes.push(...insertNodes({ model, entries: [clone], file: model.fileOf.get(id) }));
    } else {
      const siblings = childrenOf(model, node.parentId);
      const next = siblings[siblings.indexOf(id) + 1] ?? null;
      changes.push(...insertNodes({ model, entries: [clone], parentId: node.parentId, beforeId: next }));
    }
    created.push(clone.root.id);
  }
  return { changes, created };
}

/** Moves `id` (with its subtree) under `parentId` before `beforeId`, across files if needed. */
export function reparent({
  model,
  id,
  parentId,
  beforeId,
  file,
}: {
  model: Model;
  id: string;
  parentId: string | undefined;
  beforeId: string | null;
  file?: string;
}): NodeChange[] {
  const node = model.nodes[id];
  if (!node) return [];
  if (parentId !== undefined && (parentId === id || descendantsOf(model, id).includes(parentId))) return [];
  if (parentId !== undefined && model.nodes[parentId]?.type !== "frame") return [];
  const fromFile = model.fileOf.get(id)!;
  const toFile = parentId !== undefined ? model.fileOf.get(parentId)! : (file ?? fromFile);
  const { low, high } = siblingKeyRange(model, parentId, beforeId, new Set([id]));
  const moved = { ...node, index: generateKeyBetween(low, high) } as DesignNode;
  if (parentId === undefined) delete moved.parentId;
  else {
    moved.parentId = parentId;
    delete moved.x;
    delete moved.y;
  }
  if (fromFile === toFile) return [change(model, id, moved, toFile)];
  const changes: NodeChange[] = [{ file: fromFile, id, node: null }, { file: toFile, id, node: moved }];
  for (const d of descendantsOf(model, id)) {
    changes.push({ file: fromFile, id: d, node: null }, { file: toFile, id: d, node: model.nodes[d]! });
  }
  return changes;
}

/** Moves `ids` (in the given order) into `parentId` before `beforeId`, keeping each subtree together. */
export function reparentMany({
  model,
  ids,
  parentId,
  beforeId,
}: {
  model: Model;
  ids: string[];
  parentId: string;
  beforeId: string | null;
}): NodeChange[] {
  const parent = model.nodes[parentId];
  if (parent?.type !== "frame") return [];
  const moving = ids.filter((id) => model.nodes[id] && id !== parentId && !descendantsOf(model, id).includes(parentId));
  if (!moving.length) return [];
  const { low, high } = siblingKeyRange(model, parentId, beforeId, new Set(moving));
  const keys = generateNKeysBetween(low, high, moving.length);
  const toFile = model.fileOf.get(parentId)!;
  const changes: NodeChange[] = [];
  moving.forEach((id, i) => {
    const moved = { ...model.nodes[id]!, parentId, index: keys[i]! } as DesignNode;
    delete moved.x;
    delete moved.y;
    const fromFile = model.fileOf.get(id)!;
    if (fromFile === toFile) {
      changes.push(change(model, id, moved, toFile));
      return;
    }
    changes.push({ file: fromFile, id, node: null }, { file: toFile, id, node: moved });
    for (const d of descendantsOf(model, id)) {
      changes.push({ file: fromFile, id: d, node: null }, { file: toFile, id: d, node: model.nodes[d]! });
    }
  });
  return changes;
}

export type GroupResult = { changes: NodeChange[]; frameId?: string; error?: string };

/**
 * Wraps sibling layers in a new flex frame. Top-level frames are wrapped in a new top-level frame
 * that keeps their canvas positions: each becomes an absolutely positioned child, sized by `sizeOf`.
 */
export function groupIntoFrame({
  model,
  ids,
  sizeOf,
}: {
  model: Model;
  ids: string[];
  sizeOf: (id: string) => { width: number; height: number } | null;
}): GroupResult {
  const picked = topmost(model, ids).filter((id) => model.nodes[id]);
  if (!picked.length) return { changes: [] };
  const parentId = model.nodes[picked[0]!]!.parentId;
  if (picked.some((id) => model.nodes[id]!.parentId !== parentId)) {
    return { changes: [], error: "These layers are in different frames. Move them into the same frame first." };
  }
  if (parentId === undefined) return groupRoots({ model, ids: picked, sizeOf });

  const ordered = childrenOf(model, parentId).filter((id) => picked.includes(id));
  const frameId = newId(model);
  const { low, high } = siblingKeyRange(model, parentId, ordered[0]!);
  const frame: DesignNode = {
    type: "frame",
    name: "Group",
    parentId,
    index: generateKeyBetween(low, high),
    style: { display: "flex", "flex-direction": "column" },
  };
  const file = model.fileOf.get(parentId)!;
  const keys = generateNKeysBetween(null, null, ordered.length);
  const changes: NodeChange[] = [{ file, id: frameId, node: frame }];
  for (const [i, id] of ordered.entries()) changes.push({ file, id, node: { ...model.nodes[id]!, parentId: frameId, index: keys[i] } as DesignNode });
  return { changes, frameId };
}

function groupRoots({
  model,
  ids,
  sizeOf,
}: {
  model: Model;
  ids: string[];
  sizeOf: (id: string) => { width: number; height: number } | null;
}): GroupResult {
  const file = model.fileOf.get(ids[0]!)!;
  if (ids.some((id) => model.fileOf.get(id) !== file)) {
    return { changes: [], error: "These frames are in different design files." };
  }
  if (ids.some((id) => isComponent(model.nodes[id]))) {
    return { changes: [], error: "Main components stay at the top level of the canvas." };
  }
  const boxes = ids.map((id) => {
    const node = model.nodes[id]!;
    const size = sizeOf(id) ?? { width: 0, height: 0 };
    return { id, node, x: node.x ?? 0, y: node.y ?? 0, ...size };
  });
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const frameId = newId(model);
  const frame: DesignNode = {
    type: "frame",
    name: "Group",
    x: left,
    y: top,
    style: { position: "relative", width: Math.round(right - left), height: Math.round(bottom - top) },
  };
  const ordered = model.roots.filter((id) => ids.includes(id));
  const keys = generateNKeysBetween(null, null, ordered.length);
  const changes: NodeChange[] = [{ file, id: frameId, node: frame }];
  ordered.forEach((id, i) => {
    const box = boxes.find((b) => b.id === id)!;
    const { x: _x, y: _y, ...rest } = box.node;
    const style: Style = { ...rest.style, position: "absolute", left: box.x - left, top: box.y - top };
    if (style.width === undefined) style.width = Math.round(box.width);
    changes.push({ file, id, node: { ...rest, parentId: frameId, index: keys[i], style } as DesignNode });
  });
  return { changes, frameId };
}

/** Replaces an instance with concrete copies of its component's nodes, props and overrides applied. */
export function detachInstance(model: Model, id: string): NodeChange[] {
  const instance = model.nodes[id];
  if (instance?.type !== "instance") return [];
  const component = model.nodes[instance.componentId];
  if (!component || component.type !== "frame") return [];
  const patches = instancePatches(instance, component);
  const taken = new Set<string>();
  const mapping = new Map<string, string>();
  for (const d of descendantsOf(model, instance.componentId)) mapping.set(d, newId(model, taken));
  const file = model.fileOf.get(id)!;
  const rootPatch = patches.get(instance.componentId);
  const { component: _definition, ...frameRest } = component;
  const root: DesignNode = {
    ...frameRest,
    name: instance.name ?? component.name,
    parentId: instance.parentId,
    index: instance.index,
    x: instance.x,
    y: instance.y,
    style: { ...component.style, ...rootPatch?.style, ...instance.style },
  } as DesignNode;
  if (instance.parentId === undefined) delete root.parentId;
  const changes: NodeChange[] = [{ file, id, node: root }];
  for (const [innerId, newInnerId] of mapping) {
    const inner = applyPatch(model.nodes[innerId]!, patches.get(innerId));
    const parent = inner.parentId === instance.componentId ? id : mapping.get(inner.parentId!)!;
    changes.push({ file, id: newInnerId, node: { ...inner, parentId: parent } as DesignNode });
  }
  return changes;
}

type Nested = Record<string, unknown> & { children?: Nested[] };

export function toNested(model: Model, id: string): Nested {
  const { parentId: _p, index: _i, ...rest } = model.nodes[id]!;
  const children = childrenOf(model, id).map((child) => toNested(model, child));
  return { id, ...rest, ...(children.length ? { children } : {}) };
}

export function fromNested(model: Model, input: Nested[]): { root: NewNode; descendants: NewNode[] }[] {
  const taken = new Set<string>();
  return input.map((entry) => {
    const descendants: NewNode[] = [];
    const mapping = new Map<string, string>();
    const visit = (value: Nested, parent: string | undefined): string => {
      const { children, id: sourceId, parentId: _p, index: _i, ...rest } = value as Nested & { id?: string; parentId?: string; index?: string };
      const id = newId(model, taken);
      if (typeof sourceId === "string") mapping.set(sourceId, id);
      const kids = Array.isArray(children) ? children : [];
      const keys = generateNKeysBetween(null, null, kids.length);
      const node = { ...rest } as DesignNode;
      if (parent !== undefined) {
        descendants.push({ id, node: { ...node, parentId: parent } as DesignNode });
      }
      kids.forEach((kid, i) => {
        const childId = visit(kid, id);
        const entryIndex = descendants.findIndex((d) => d.id === childId);
        descendants[entryIndex] = { id: childId, node: { ...descendants[entryIndex]!.node, index: keys[i] } as DesignNode };
      });
      if (parent === undefined) rootNode = { id, node };
      return id;
    };
    let rootNode: NewNode | undefined;
    visit(entry, undefined);
    return { root: { ...rootNode!, node: remapComponentRefs(structuredClone(rootNode!.node), mapping) }, descendants };
  });
}
