import type { DesignNode } from "@lamsa/schema";
import { compareIndex } from "./order.js";

export type NodeMap = Record<string, DesignNode>;

export interface ChildIndex {
  roots: string[];
  children: Map<string, string[]>;
}

function byIndexThenId(nodes: NodeMap) {
  return (a: string, b: string) =>
    compareIndex(nodes[a]?.index, nodes[b]?.index) || (a < b ? -1 : a > b ? 1 : 0);
}

export function buildChildIndex(nodes: NodeMap): ChildIndex {
  const roots: string[] = [];
  const children = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === undefined) {
      roots.push(id);
      continue;
    }
    const list = children.get(node.parentId) ?? [];
    list.push(id);
    children.set(node.parentId, list);
  }
  const order = byIndexThenId(nodes);
  roots.sort(order);
  for (const list of children.values()) list.sort(order);
  return { roots, children };
}

export function childrenOf(index: ChildIndex, id: string): string[] {
  return index.children.get(id) ?? [];
}

export function descendants(index: ChildIndex, id: string): string[] {
  const result: string[] = [];
  const stack = [...childrenOf(index, id)].reverse();
  while (stack.length > 0) {
    const next = stack.pop()!;
    result.push(next);
    stack.push(...[...childrenOf(index, next)].reverse());
  }
  return result;
}

export function ancestors(nodes: NodeMap, id: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = nodes[id]?.parentId;
  while (current !== undefined && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = nodes[current]?.parentId;
  }
  return result;
}

export function rootOf(nodes: NodeMap, id: string): string {
  const chain = ancestors(nodes, id);
  return chain.length > 0 ? chain[chain.length - 1]! : id;
}

export function nodeLabel(id: string, node: DesignNode): string {
  const detail =
    node.type === "text"
      ? ` "${truncate(node.content, 40)}"`
      : node.type === "icon"
        ? ` ${node.icon}`
        : node.type === "instance"
          ? ` → ${node.componentId}`
          : node.type === "image"
            ? ` ${node.src}`
            : "";
  const component = node.type === "frame" && node.component ? " [component]" : "";
  const name = node.name ? ` ${JSON.stringify(node.name)}` : "";
  return `${node.type}${component} ${id}${name}${detail}${node.hidden ? " (hidden)" : ""}`;
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface TreeLine {
  id: string;
  depth: number;
  label: string;
}

export function treeLines({
  nodes,
  index,
  from,
  maxDepth = Infinity,
}: {
  nodes: NodeMap;
  index: ChildIndex;
  from: string[];
  maxDepth?: number;
}): TreeLine[] {
  const lines: TreeLine[] = [];
  const visit = (id: string, depth: number) => {
    const node = nodes[id];
    if (!node) return;
    lines.push({ id, depth, label: nodeLabel(id, node) });
    if (depth + 1 > maxDepth) return;
    for (const child of childrenOf(index, id)) visit(child, depth + 1);
  };
  for (const id of from) visit(id, 0);
  return lines;
}
