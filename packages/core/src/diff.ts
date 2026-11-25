import { execFileSync } from "node:child_process";
import { configSchema, type DesignNode, type LamsaConfig } from "@lamsa/schema";
import picomatch from "picomatch";
import { CONFIG_FILE, isDesignFile, type Project } from "./project.js";
import { rootOf, type NodeMap } from "./tree.js";

export type ChangeKind = "added" | "removed" | "changed";

/** One field of a node that differs, with style keys as `style.<property>`. Absent sides mean the field was unset. */
export interface ValueChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface NodeChange {
  id: string;
  file: string;
  kind: ChangeKind;
  name?: string;
  type: DesignNode["type"];
  /** For an unnamed text layer, the start of its text. */
  text?: string;
  /** The top-level frame the node sits in: in the new version, or the old one when the node was removed. */
  screen: string;
  /** Changed fields, sorted. */
  fields?: string[];
  values?: ValueChange[];
}

/** A top-level frame whose render may differ, with the layers to point out on each side. */
export interface ScreenChange {
  id: string;
  name?: string;
  file: string;
  kind: ChangeKind;
  /** Layers new in this screen, to outline in the new render. */
  added: string[];
  /** Layers gone from this screen, to outline in the old render. */
  removed: string[];
  /** Layers that differ, to outline in both renders. */
  changed: string[];
  /** Components whose change reaches this screen through an instance. */
  components: string[];
}

export interface DesignDiff {
  base: string;
  /** A git ref, or `working tree` for the files on disk. */
  head: string;
  changes: NodeChange[];
  screens: ScreenChange[];
  /** Top-level frames whose render may differ, including those using a changed component. */
  affectedRoots: string[];
  /** Top-level frames that only moved on the canvas, which doesn't change how they render. */
  repositioned: string[];
}

const CANVAS_FIELDS = new Set(["x", "y", "index"]);

/** A top-level frame moved or reordered on the canvas, and nothing else about it changed. */
const onlyRepositioned = (change: NodeChange) => change.kind === "changed" && change.id === change.screen && change.fields!.every((field) => CANVAS_FIELDS.has(field));

export const WORKING_TREE = "working tree";

interface Located {
  file: string;
  node: DesignNode;
}

type LocatedMap = Map<string, Located>;

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
}

function readJsonAtRef({ root, ref, path }: { root: string; ref: string; path: string }): unknown {
  try {
    return JSON.parse(git(root, ["show", `${ref}:./${path}`])) as unknown;
  } catch {
    return undefined;
  }
}

/** The design files a project had at a git ref, chosen by that ref's own `designs` globs. */
export function designFilesAtRef({ root, ref, fallback }: { root: string; ref: string; fallback: LamsaConfig }): Map<string, unknown> {
  let paths: string[];
  try {
    paths = git(root, ["ls-tree", "-r", "--name-only", ref, "--", "."]).split("\n").filter(Boolean);
  } catch {
    throw new Error(`unknown git ref ${ref}`);
  }
  const rawConfig = readJsonAtRef({ root, ref, path: CONFIG_FILE });
  const parsed = rawConfig === undefined ? undefined : configSchema.safeParse(rawConfig);
  const config = parsed?.success ? parsed.data : fallback;
  const isDesign = picomatch(config.designs, { ignore: ["**/node_modules/**", "**/.lamsa/**"] });
  const files = new Map<string, unknown>();
  for (const path of paths.filter((path) => isDesign(path)).sort()) files.set(path, readJsonAtRef({ root, ref, path }));
  return files;
}

function locate(files: Iterable<[string, unknown]>): LocatedMap {
  const nodes: LocatedMap = new Map();
  for (const [file, raw] of files) {
    if (!isDesignFile(raw)) continue;
    for (const [id, node] of Object.entries(raw.nodes)) nodes.set(id, { file, node });
  }
  return nodes;
}

const textOf = (node: DesignNode) =>
  node.type === "text" && !node.name ? { text: node.content.length > 40 ? `${node.content.slice(0, 39)}…` : node.content } : {};

const nodeMapOf = (nodes: LocatedMap): NodeMap => Object.fromEntries([...nodes].map(([id, { node }]) => [id, node]));

function changedValues(before: DesignNode, after: DesignNode): ValueChange[] {
  const values: ValueChange[] = [];
  const record = (field: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    values.push({ field, ...(a === undefined ? {} : { before: a }), ...(b === undefined ? {} : { after: b }) });
  };
  const fields = (node: DesignNode) => node as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = fields(before)[key];
    const b = fields(after)[key];
    if (key !== "style") {
      record(key, a, b);
      continue;
    }
    const styleA = (a ?? {}) as Record<string, unknown>;
    const styleB = (b ?? {}) as Record<string, unknown>;
    for (const property of new Set([...Object.keys(styleA), ...Object.keys(styleB)])) record(`style.${property}`, styleA[property], styleB[property]);
  }
  return values.sort((x, y) => x.field.localeCompare(y.field));
}

/** Compares two sets of design files node by node, matching nodes by ID. */
export function diffDesignFiles({
  before,
  after,
  base,
  head,
  only,
}: {
  before: Iterable<[string, unknown]>;
  after: Iterable<[string, unknown]>;
  base: string;
  head: string;
  /** Keep only changes in files matching these paths or globs. */
  only?: string[];
}): DesignDiff {
  const beforeNodes = locate(before);
  const afterNodes = locate(after);
  const beforeMap = nodeMapOf(beforeNodes);
  const afterMap = nodeMapOf(afterNodes);
  const inScope = only?.length ? picomatch(only.map((path) => path.replace(/^\.\//, ""))) : () => true;

  const changes: NodeChange[] = [];
  for (const [id, now] of afterNodes) {
    const was = beforeNodes.get(id);
    const common = { id, file: now.file, name: now.node.name, type: now.node.type, ...textOf(now.node), screen: rootOf(afterMap, id) };
    if (!was) {
      changes.push({ ...common, kind: "added" });
      continue;
    }
    const values = changedValues(was.node, now.node);
    if (was.file !== now.file) values.push({ field: "file", before: was.file, after: now.file });
    if (values.length > 0) changes.push({ ...common, kind: "changed", fields: values.map((value) => value.field), values });
  }
  for (const [id, was] of beforeNodes) {
    if (afterNodes.has(id)) continue;
    changes.push({ id, file: was.file, kind: "removed", name: was.node.name, type: was.node.type, ...textOf(was.node), screen: rootOf(beforeMap, id) });
  }
  const kept = changes.filter((change) => inScope(change.file));
  kept.sort((a, b) => a.file.localeCompare(b.file) || a.screen.localeCompare(b.screen) || a.id.localeCompare(b.id));

  const screens = new Map<string, ScreenChange>();
  const screenFor = (id: string): ScreenChange => {
    let screen = screens.get(id);
    if (!screen) {
      const node = afterMap[id] ?? beforeMap[id];
      const kind: ChangeKind = !beforeMap[id] ? "added" : !afterMap[id] ? "removed" : "changed";
      screen = { id, name: node?.name, file: (afterNodes.get(id) ?? beforeNodes.get(id))!.file, kind, added: [], removed: [], changed: [], components: [] };
      screens.set(id, screen);
    }
    return screen;
  };
  for (const change of kept) {
    if (onlyRepositioned(change)) continue;
    const screen = screenFor(change.screen);
    // A screen that is new or gone shows whole; outlining its layers would only add noise.
    if (screen.kind !== "changed" || change.id === screen.id) continue;
    screen[change.kind].push(change.id);
  }

  // A changed component changes every screen that places it, through any depth of nesting.
  const isComponent = (id: string) => {
    const node = afterMap[id];
    return node?.type === "frame" && Boolean(node.component);
  };
  const changedComponents = new Set([...screens.values()].filter((screen) => screen.kind === "changed" && isComponent(screen.id)).map((screen) => screen.id));
  const reached = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of Object.entries(afterMap)) {
      if (node.type !== "instance" || !changedComponents.has(node.componentId)) continue;
      const key = `${node.componentId}>${id}`;
      if (reached.has(key)) continue;
      reached.add(key);
      grew = true;
      const component = screens.get(node.componentId)!;
      const rootId = rootOf(afterMap, id);
      // New screens already show whole, and a file filter keeps out screens in other files.
      if (!beforeMap[rootId] || !inScope(afterNodes.get(rootId)!.file)) continue;
      const screen = screenFor(rootId);
      if (!screen.components.includes(component.id)) screen.components.push(component.id);
      // Inside an instance a component's layers render as `<instance>/<layer>`, so their IDs still find them.
      for (const kind of ["added", "removed", "changed"] as const) {
        for (const layer of component[kind]) if (!screen[kind].includes(layer)) screen[kind].push(layer);
      }
      if (component.changed.includes(component.id) || kept.some((change) => change.id === component.id)) {
        if (!screen.changed.includes(id)) screen.changed.push(id);
      }
      if (isComponent(screen.id)) changedComponents.add(screen.id);
    }
  }

  const ordered = [...screens.values()].sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  return {
    base,
    head,
    changes: kept,
    screens: ordered,
    affectedRoots: ordered.filter((screen) => screen.kind !== "removed").map((screen) => screen.id),
    repositioned: kept.filter((change) => onlyRepositioned(change) && !screens.has(change.id)).map((change) => change.id),
  };
}

/** Design changes between a git ref and either another ref or the files on disk. */
export function diffAgainstRef({ project, ref = "HEAD", head, only }: { project: Project; ref?: string; head?: string; only?: string[] }): DesignDiff {
  const before = designFilesAtRef({ root: project.root, ref, fallback: project.config });
  const after: Iterable<[string, unknown]> = head
    ? designFilesAtRef({ root: project.root, ref: head, fallback: project.config })
    : [...project.files.values()].map((file) => [file.path, file.raw] as [string, unknown]);
  return diffDesignFiles({ before, after, base: ref, head: head ?? WORKING_TREE, only });
}
