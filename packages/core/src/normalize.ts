import { FORMAT_VERSION, SCHEMA_URL, type DesignFile, type DesignNode } from "@lamsa/schema";
import { newId } from "./ids.js";
import { keysBetween } from "./order.js";

/** A node as an agent may write it: optional `id`, nested `children`. */
export type NestedNode = Record<string, unknown> & {
  id?: string;
  children?: NestedNode[];
};

export interface FlattenResult {
  nodes: Record<string, Record<string, unknown>>;
  rootIds: string[];
}

export function flattenNested({
  input,
  parentId,
  before = null,
  after = null,
  taken,
}: {
  input: NestedNode[];
  parentId?: string;
  before?: string | null;
  after?: string | null;
  taken: Set<string>;
}): FlattenResult {
  const nodes: Record<string, Record<string, unknown>> = {};
  const rootIds: string[] = [];

  const visit = (
    list: NestedNode[],
    parent: string | undefined,
    low: string | null,
    high: string | null,
    isRoot: boolean,
  ) => {
    const keys = parent === undefined && !isRoot ? [] : keysBetween(low, high, list.length);
    list.forEach((entry, i) => {
      const { id: givenId, children, ...rest } = entry;
      const id = typeof givenId === "string" && givenId.length > 0 ? givenId : newId(taken);
      if (taken.has(id)) throw new Error(`node ID ${id} is already used; drop "id" to get a fresh one`);
      taken.add(id);
      const node: Record<string, unknown> = { ...rest };
      if (parent !== undefined) {
        node.parentId = parent;
        node.index = keys[i];
      } else if (isRoot && parentId === undefined && rest.index === undefined) {
        node.index = keys[i];
      }
      nodes[id] = node;
      if (isRoot) rootIds.push(id);
      if (Array.isArray(children) && children.length > 0) visit(children, id, null, null, false);
    });
  };

  visit(input, parentId, before, after, true);
  return { nodes, rootIds };
}

export interface FormatResult {
  file: DesignFile;
  changes: string[];
}

function isNestedArray(value: unknown): value is NestedNode[] {
  return Array.isArray(value);
}

/**
 * Normalise a raw design file: flatten nested `children`, assign missing
 * indexes, set version and $schema. With `fix`, drop nodes whose parent is
 * missing (and their subtrees). Key sorting happens on write.
 */
export function formatDesignFile({
  raw,
  fix = false,
  takenIds = new Set<string>(),
}: {
  raw: unknown;
  fix?: boolean;
  takenIds?: Set<string>;
}): FormatResult {
  const changes: string[] = [];
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  let nodes: Record<string, Record<string, unknown>> = {};

  const taken = new Set(takenIds);
  if (isNestedArray(source.nodes)) {
    const flat = flattenNested({ input: source.nodes, taken });
    nodes = flat.nodes;
    changes.push(`converted nested node list to a flat map (${Object.keys(nodes).length} nodes)`);
  } else if (source.nodes && typeof source.nodes === "object") {
    const entries = Object.entries(source.nodes as Record<string, Record<string, unknown>>);
    for (const [id] of entries) taken.add(id);
    for (const [id, value] of entries) {
      const { children, id: _ignored, ...rest } = (value ?? {}) as NestedNode;
      nodes[id] = rest;
      if (isNestedArray(children) && children.length > 0) {
        const flat = flattenNested({ input: children, parentId: id, taken });
        Object.assign(nodes, flat.nodes);
        changes.push(`flattened ${Object.keys(flat.nodes).length} nested children of ${id}`);
      }
    }
  } else {
    changes.push("added empty nodes map");
  }

  const missingIndex = new Map<string, string[]>();
  const lastIndex = new Map<string, string>();
  for (const [id, node] of Object.entries(nodes)) {
    const parent = typeof node.parentId === "string" ? node.parentId : "";
    if (typeof node.index === "string") {
      const current = lastIndex.get(parent);
      if (current === undefined || node.index > current) lastIndex.set(parent, node.index);
    } else if (parent !== "") {
      missingIndex.set(parent, [...(missingIndex.get(parent) ?? []), id]);
    }
  }
  for (const [parent, ids] of missingIndex) {
    const keys = keysBetween(lastIndex.get(parent) ?? null, null, ids.length);
    ids.forEach((id, i) => {
      nodes[id]!.index = keys[i];
    });
    changes.push(`assigned order index to ${ids.length} child(ren) of ${parent}`);
  }

  if (fix) {
    const removed = removeOrphans(nodes);
    if (removed.length > 0) changes.push(`removed ${removed.length} orphaned node(s): ${removed.join(", ")}`);
  }

  if (source.version === undefined) changes.push(`set version ${FORMAT_VERSION}`);
  const file = {
    $schema: typeof source.$schema === "string" ? source.$schema : SCHEMA_URL,
    version: typeof source.version === "number" ? source.version : FORMAT_VERSION,
    nodes: nodes as Record<string, DesignNode>,
  } satisfies DesignFile;
  return { file, changes };
}

function removeOrphans(nodes: Record<string, Record<string, unknown>>): string[] {
  const removed: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of Object.entries(nodes)) {
      const parent = node.parentId;
      if (typeof parent === "string" && !(parent in nodes)) {
        delete nodes[id];
        removed.push(id);
        changed = true;
      }
    }
  }
  return removed;
}
