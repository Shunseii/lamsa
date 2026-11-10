import { FORMAT_VERSION, SCHEMA_URL, type DesignFile, type DesignNode } from "@lamsa/schema";
import { flattenNested, type NestedNode } from "./normalize.js";
import { keyBetween } from "./order.js";
import { isDesignFile, type Project } from "./project.js";
import { buildChildIndex, childrenOf, descendants, type NodeMap } from "./tree.js";

export class EditError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly nodeId?: string,
    readonly notFound = false,
  ) {
    super(message);
  }
}

export interface Placement {
  parentId?: string;
  /** Required for top-level nodes. */
  file?: string;
  before?: string;
  after?: string;
}

function designFile(project: Project, path: string): DesignFile {
  const loaded = project.files.get(path);
  if (!loaded) throw new EditError(`design file ${path} is not part of this project`);
  if (loaded.parseError || !isDesignFile(loaded.raw)) {
    throw new EditError(`${path} is not a valid design file`, "run `lamsa validate` and fix it first");
  }
  return loaded.raw;
}

function locate(project: Project, id: string): { path: string; file: DesignFile; node: DesignNode } {
  for (const [path, loaded] of project.files) {
    if (!isDesignFile(loaded.raw)) continue;
    const node = loaded.raw.nodes[id];
    if (node) return { path, file: loaded.raw, node };
  }
  throw new EditError(`node ${id} not found`, "run `lamsa tree` to list node IDs", id, true);
}

function allIds(project: Project): Set<string> {
  const ids = new Set<string>();
  for (const loaded of project.files.values()) {
    if (isDesignFile(loaded.raw)) for (const id of Object.keys(loaded.raw.nodes)) ids.add(id);
  }
  return ids;
}

export function ensureFile(project: Project, path: string): DesignFile {
  const existing = project.files.get(path);
  if (existing) return designFile(project, path);
  const file: DesignFile = { $schema: SCHEMA_URL, version: FORMAT_VERSION, nodes: {} };
  project.files.set(path, { path, raw: file });
  return file;
}

function siblingKeys({
  nodes,
  parentId,
  before,
  after,
}: {
  nodes: NodeMap;
  parentId: string | undefined;
  before?: string;
  after?: string;
}): { low: string | null; high: string | null } {
  const index = buildChildIndex(nodes);
  const siblings = parentId === undefined ? index.roots : childrenOf(index, parentId);
  const keyOf = (id: string) => nodes[id]?.index ?? null;
  const anchor = before ?? after;
  if (anchor !== undefined) {
    const position = siblings.indexOf(anchor);
    if (position === -1) {
      throw new EditError(
        `${anchor} is not a sibling at the target position`,
        "--before/--after must name a child of the target parent",
        anchor,
      );
    }
    if (before !== undefined) {
      return { low: position > 0 ? keyOf(siblings[position - 1]!) : null, high: keyOf(anchor) };
    }
    return {
      low: keyOf(anchor),
      high: position < siblings.length - 1 ? keyOf(siblings[position + 1]!) : null,
    };
  }
  const last = siblings[siblings.length - 1];
  return { low: last !== undefined ? keyOf(last) : null, high: null };
}

function nextCanvasX(nodes: NodeMap): number {
  let right = -80;
  for (const node of Object.values(nodes)) {
    if (node.parentId !== undefined) continue;
    const width = typeof node.style?.width === "number" ? node.style.width : 400;
    right = Math.max(right, (node.x ?? 0) + width);
  }
  return right + 80;
}

export interface AddResult {
  file: string;
  rootIds: string[];
  created: string[];
}

export function addTree({
  project,
  input,
  placement,
}: {
  project: Project;
  input: NestedNode | NestedNode[];
  placement: Placement;
}): AddResult {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) throw new EditError("nothing to add");

  let path: string;
  if (placement.parentId !== undefined) {
    const parent = locate(project, placement.parentId);
    if (parent.node.type !== "frame") {
      throw new EditError(
        `${placement.parentId} is a ${parent.node.type}; only frames have children`,
        "pick a frame as --parent",
        placement.parentId,
      );
    }
    path = parent.path;
  } else {
    if (!placement.file) {
      throw new EditError("top-level nodes need a file", "pass --file <path> or --parent <frame id>");
    }
    path = placement.file;
  }

  const file = ensureFile(project, path);
  const { low, high } = siblingKeys({
    nodes: file.nodes,
    parentId: placement.parentId,
    before: placement.before,
    after: placement.after,
  });
  const flat = flattenNested({
    input: list,
    parentId: placement.parentId,
    before: low,
    after: high,
    taken: allIds(project),
  });

  if (placement.parentId === undefined) {
    let x = nextCanvasX(file.nodes);
    for (const id of flat.rootIds) {
      const node = flat.nodes[id]!;
      if (node.x === undefined) node.x = x;
      if (node.y === undefined) node.y = 0;
      const width = (node.style as Record<string, unknown> | undefined)?.width;
      x = (node.x as number) + (typeof width === "number" ? width : 400) + 80;
    }
  }

  Object.assign(file.nodes, flat.nodes as Record<string, DesignNode>);
  return { file: path, rootIds: flat.rootIds, created: Object.keys(flat.nodes) };
}

export interface MoveResult {
  from: string;
  to: string;
  moved: string[];
}

export function moveNode({
  project,
  id,
  placement,
}: {
  project: Project;
  id: string;
  placement: Placement;
}): MoveResult {
  const source = locate(project, id);
  const subtree = [id, ...descendants(buildChildIndex(source.file.nodes), id)];

  let targetPath: string;
  if (placement.parentId !== undefined) {
    if (subtree.includes(placement.parentId)) {
      throw new EditError(`cannot move ${id} into itself or its own subtree`, undefined, id);
    }
    const parent = locate(project, placement.parentId);
    if (parent.node.type !== "frame") {
      throw new EditError(`${placement.parentId} is a ${parent.node.type}; only frames have children`, undefined, placement.parentId);
    }
    targetPath = parent.path;
  } else {
    targetPath = placement.file ?? source.path;
  }

  const target = ensureFile(project, targetPath);
  const nodes = { ...target.nodes };
  delete nodes[id];
  const { low, high } = siblingKeys({
    nodes,
    parentId: placement.parentId,
    before: placement.before,
    after: placement.after,
  });

  const moved: Record<string, DesignNode> = {};
  for (const nodeId of subtree) {
    moved[nodeId] = source.file.nodes[nodeId]!;
    delete source.file.nodes[nodeId];
  }
  const root = { ...moved[id]! };
  root.index = keyBetween(low, high);
  if (placement.parentId === undefined) {
    delete root.parentId;
    if (root.x === undefined) root.x = nextCanvasX(target.nodes);
    if (root.y === undefined) root.y = 0;
  } else {
    root.parentId = placement.parentId;
    delete root.x;
    delete root.y;
  }
  moved[id] = root;
  Object.assign(target.nodes, moved);
  return { from: source.path, to: targetPath, moved: subtree };
}

export interface DeleteResult {
  deleted: string[];
  files: string[];
  /** Instances elsewhere that pointed at a deleted component. */
  danglingInstances: string[];
}

export function deleteNodes({ project, ids }: { project: Project; ids: string[] }): DeleteResult {
  const deleted: string[] = [];
  const files = new Set<string>();
  for (const id of ids) {
    if (deleted.includes(id)) continue;
    const source = locate(project, id);
    const subtree = [id, ...descendants(buildChildIndex(source.file.nodes), id)];
    for (const nodeId of subtree) {
      delete source.file.nodes[nodeId];
      deleted.push(nodeId);
    }
    files.add(source.path);
  }
  const removed = new Set(deleted);
  const danglingInstances: string[] = [];
  for (const loaded of project.files.values()) {
    if (!isDesignFile(loaded.raw)) continue;
    for (const [nodeId, node] of Object.entries(loaded.raw.nodes)) {
      if (node.type === "instance" && removed.has(node.componentId)) danglingInstances.push(nodeId);
    }
  }
  return { deleted, files: [...files], danglingInstances };
}
