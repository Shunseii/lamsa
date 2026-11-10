import type { DesignNode } from "@lamsa/schema";
import type { FileState } from "../../../shared/api";

export type NodeMap = Record<string, DesignNode>;

export interface Model {
  nodes: NodeMap;
  fileOf: Map<string, string>;
  roots: string[];
  children: Map<string, string[]>;
}

const byIndex = (nodes: NodeMap) => (a: string, b: string) => {
  const ia = nodes[a]?.index ?? "";
  const ib = nodes[b]?.index ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

export function buildModel(files: Record<string, FileState>): Model {
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
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === undefined || !nodes[node.parentId]) {
      if (node.parentId === undefined) roots.push(id);
      continue;
    }
    const list = children.get(node.parentId) ?? [];
    list.push(id);
    children.set(node.parentId, list);
  }
  const order = byIndex(nodes);
  for (const list of children.values()) list.sort(order);
  roots.sort((a, b) => {
    const fa = fileOf.get(a)!;
    const fb = fileOf.get(b)!;
    return fa < fb ? -1 : fa > fb ? 1 : order(a, b);
  });
  return { nodes, fileOf, roots, children };
}

export function childrenOf(model: Model, id: string): string[] {
  return model.children.get(id) ?? [];
}

export function descendantsOf(model: Model, id: string): string[] {
  const result: string[] = [];
  const stack = [...childrenOf(model, id)];
  while (stack.length) {
    const next = stack.shift()!;
    result.push(next);
    stack.unshift(...childrenOf(model, next));
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

export function isComponent(node: DesignNode | undefined): boolean {
  return node?.type === "frame" && !!node.component;
}

export function iconNamesIn(nodes: NodeMap): string[] {
  const names = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.type === "icon") names.add(node.icon);
  }
  for (const node of Object.values(nodes)) {
    if (node.type !== "frame" || !node.component) continue;
    for (const prop of Object.values(node.component.props ?? {})) {
      const groups = prop.type === "enum" ? Object.values(prop.overrides ?? {}) : prop.type === "boolean" ? Object.values(prop.overrides ?? {}) : [];
      for (const patches of groups) for (const patch of Object.values(patches ?? {})) if (patch.icon) names.add(patch.icon);
    }
  }
  for (const node of Object.values(nodes)) {
    if (node.type === "instance") for (const patch of Object.values(node.overrides ?? {})) if (patch.icon) names.add(patch.icon);
  }
  return [...names];
}

export interface FileRegion {
  file: string;
  dx: number;
  left: number;
  top: number;
}

/** Files sit side by side on the canvas; each file's own x/y are offset by `dx`. */
export function fileRegions(model: Model): Map<string, FileRegion> {
  const regions = new Map<string, FileRegion>();
  const files = [...new Set(model.roots.map((id) => model.fileOf.get(id)!))];
  let cursor = 0;
  for (const file of files) {
    const roots = model.roots.filter((id) => model.fileOf.get(id) === file);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    for (const id of roots) {
      const node = model.nodes[id]!;
      const width = typeof node.style?.width === "number" ? node.style.width : 400;
      minX = Math.min(minX, node.x ?? 0);
      maxX = Math.max(maxX, (node.x ?? 0) + width);
      minY = Math.min(minY, node.y ?? 0);
    }
    const dx = cursor - minX;
    regions.set(file, { file, dx, left: cursor, top: minY });
    cursor += maxX - minX + 200;
  }
  return regions;
}
