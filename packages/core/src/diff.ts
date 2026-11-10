import { execFileSync } from "node:child_process";
import type { DesignNode } from "@lamsa/schema";
import { isDesignFile, type Project } from "./project.js";
import { rootOf, type NodeMap } from "./tree.js";

export interface NodeChange {
  id: string;
  file: string;
  kind: "added" | "removed" | "changed";
  name?: string;
  type: DesignNode["type"];
  /** Changed top-level fields, with style keys as `style.<property>`. */
  fields?: string[];
}

export interface DesignDiff {
  base: string;
  changes: NodeChange[];
  /** Top-level frames whose render may differ, including those using a changed component. */
  affectedRoots: string[];
}

function readAtRef(root: string, ref: string, path: string): unknown {
  try {
    const text = execFileSync("git", ["show", `${ref}:./${path}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function listAtRef(root: string, ref: string): string[] {
  try {
    return execFileSync("git", ["ls-tree", "-r", "--name-only", ref, "--", "."], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((p) => p.endsWith(".lamsa.json"));
  } catch {
    return [];
  }
}

function changedFields(before: DesignNode, after: DesignNode): string[] {
  const fields = new Set<string>();
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const a = (before as Record<string, unknown>)[key];
    const b = (after as Record<string, unknown>)[key];
    if (key === "style") {
      const sa = (a ?? {}) as Record<string, unknown>;
      const sb = (b ?? {}) as Record<string, unknown>;
      for (const prop of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
        if (JSON.stringify(sa[prop]) !== JSON.stringify(sb[prop])) fields.add(`style.${prop}`);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      fields.add(key);
    }
  }
  return [...fields].sort();
}

export function diffAgainstRef({ project, ref = "HEAD" }: { project: Project; ref?: string }): DesignDiff {
  const beforeNodes = new Map<string, { file: string; node: DesignNode }>();
  for (const path of listAtRef(project.root, ref)) {
    const raw = readAtRef(project.root, ref, path);
    if (!isDesignFile(raw)) continue;
    for (const [id, node] of Object.entries(raw.nodes)) beforeNodes.set(id, { file: path, node });
  }
  const afterNodes = new Map<string, { file: string; node: DesignNode }>();
  const current: NodeMap = {};
  for (const loaded of project.files.values()) {
    if (!isDesignFile(loaded.raw)) continue;
    for (const [id, node] of Object.entries(loaded.raw.nodes)) {
      afterNodes.set(id, { file: loaded.path, node });
      current[id] = node;
    }
  }

  const changes: NodeChange[] = [];
  for (const [id, after] of afterNodes) {
    const before = beforeNodes.get(id);
    if (!before) {
      changes.push({ id, file: after.file, kind: "added", name: after.node.name, type: after.node.type });
      continue;
    }
    const fields = changedFields(before.node, after.node);
    if (before.file !== after.file) fields.push("file");
    if (fields.length > 0) {
      changes.push({ id, file: after.file, kind: "changed", name: after.node.name, type: after.node.type, fields });
    }
  }
  for (const [id, before] of beforeNodes) {
    if (!afterNodes.has(id)) {
      changes.push({ id, file: before.file, kind: "removed", name: before.node.name, type: before.node.type });
    }
  }

  const touchedRoots = new Set<string>();
  const changedComponents = new Set<string>();
  for (const change of changes) {
    if (!current[change.id]) continue;
    const root = rootOf(current, change.id);
    touchedRoots.add(root);
    if (current[root]?.type === "frame" && (current[root] as { component?: unknown }).component) {
      changedComponents.add(root);
    }
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, node] of Object.entries(current)) {
      if (node.type !== "instance" || !changedComponents.has(node.componentId)) continue;
      const root = rootOf(current, id);
      if (!touchedRoots.has(root)) {
        touchedRoots.add(root);
        grew = true;
      }
      const rootNode = current[root];
      if (rootNode?.type === "frame" && rootNode.component && !changedComponents.has(root)) {
        changedComponents.add(root);
        grew = true;
      }
    }
  }

  changes.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));
  return { base: ref, changes, affectedRoots: [...touchedRoots].sort() };
}
