import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import {
  configSchema,
  type DesignFile,
  type DesignNode,
  type LamsaConfig,
} from "@lamsa/schema";
import { glob } from "tinyglobby";
import { stableStringify, writeFileAtomic } from "./json.js";

export const CONFIG_FILE = "lamsa.config.json";

export interface LoadedFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Parsed JSON as found on disk; may not satisfy the schema yet. */
  raw: unknown;
  /** Set when the file is not valid JSON. */
  parseError?: string;
}

export interface NodeLocation {
  file: string;
  node: DesignNode;
}

export interface Project {
  root: string;
  config: LamsaConfig;
  files: Map<string, LoadedFile>;
}

export function findProjectRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(root: string): Promise<LamsaConfig> {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return configSchema.parse({});
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return configSchema.parse(raw);
}

export function toRepoPath(root: string, path: string): string {
  return relative(root, resolve(root, path)).split("\\").join("/");
}

export async function listDesignFiles(root: string, config: LamsaConfig): Promise<string[]> {
  const found = await glob(config.designs, {
    cwd: root,
    ignore: ["**/node_modules/**", "**/.lamsa/**"],
    dot: false,
  });
  return found.map((p) => p.split("\\").join("/")).sort();
}

export async function readDesignFile(root: string, path: string): Promise<LoadedFile> {
  const text = await readFile(join(root, path), "utf8");
  try {
    return { path, raw: JSON.parse(text) as unknown };
  } catch (error) {
    return { path, raw: undefined, parseError: (error as Error).message };
  }
}

export async function loadProject(root: string): Promise<Project> {
  const config = await loadConfig(root);
  const paths = await listDesignFiles(root, config);
  const files = new Map<string, LoadedFile>();
  for (const path of paths) files.set(path, await readDesignFile(root, path));
  return { root, config, files };
}

export function isDesignFile(value: unknown): value is DesignFile {
  return (
    !!value &&
    typeof value === "object" &&
    "nodes" in value &&
    !!(value as { nodes: unknown }).nodes &&
    typeof (value as { nodes: unknown }).nodes === "object"
  );
}

/** Every node across all files. Later files lose on duplicate IDs; validation reports duplicates. */
export function indexNodes(project: Project): Map<string, NodeLocation> {
  const index = new Map<string, NodeLocation>();
  for (const file of project.files.values()) {
    if (!isDesignFile(file.raw)) continue;
    for (const [id, node] of Object.entries(file.raw.nodes)) {
      if (!index.has(id)) index.set(id, { file: file.path, node });
    }
  }
  return index;
}

export function allNodes(project: Project): Record<string, DesignNode> {
  const nodes: Record<string, DesignNode> = {};
  for (const [id, location] of indexNodes(project)) nodes[id] = location.node;
  return nodes;
}

/** File-level CSS (`@keyframes` and friends) from every design file, in path order. */
export function allFileCss(project: Project): string {
  return [...project.files.values()]
    .sort((a, b) => (a.path < b.path ? -1 : 1))
    .map((file) => (isDesignFile(file.raw) && typeof file.raw.css === "string" ? file.raw.css : ""))
    .filter((css) => css.trim())
    .join("\n");
}

export async function saveDesignFile(root: string, path: string, file: DesignFile): Promise<void> {
  await writeFileAtomic(join(root, path), stableStringify(file));
}
