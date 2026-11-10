import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  CONFIG_FILE,
  fontSetup,
  isDesignFile,
  listDesignFiles,
  loadProject,
  loadTokens,
  lucideIconSvg,
  readSession,
  saveDesignFile,
  stableStringify,
  validateProject,
  writeSession,
  type Project,
} from "@lamsa/core";
import { FORMAT_VERSION, SCHEMA_URL, emptyTokenSet, type DesignFile, type DesignNode, type TokenSet } from "@lamsa/schema";
import chokidar, { type FSWatcher } from "chokidar";
import type { ExternalChange, FileState, NodeChange, ProjectIssue, ProjectSnapshot } from "../shared/api.js";

function parseDesign(text: string): { nodes?: Record<string, DesignNode>; error?: string } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isDesignFile(raw)) return { error: "missing a \"nodes\" map" };
    const nodes = raw.nodes as unknown;
    if (Array.isArray(nodes)) return { error: "nested node list; run `lamsa fmt`" };
    return { nodes: raw.nodes };
  } catch (error) {
    return { error: `not valid JSON: ${(error as Error).message}` };
  }
}

export class ProjectService {
  private project?: Project;
  private tokens: TokenSet = emptyTokenSet;
  private tokenError?: string;
  private files = new Map<string, FileState>();
  /** Text we last wrote per file, to ignore our own watcher echoes. */
  private written = new Map<string, string>();
  private watcher?: FSWatcher;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly events: {
      external: (change: ExternalChange) => void;
      reloaded: (snapshot: ProjectSnapshot) => void;
    },
  ) {}

  get root(): string | undefined {
    return this.project?.root;
  }

  static isProject(root: string): boolean {
    return existsSync(join(root, CONFIG_FILE));
  }

  async open(root: string): Promise<ProjectSnapshot> {
    await this.close();
    await this.load(root);
    this.primeHistory();
    this.watch();
    return this.snapshot();
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    this.project = undefined;
    this.files.clear();
    this.written.clear();
  }

  private async load(root: string) {
    this.project = await loadProject(root);
    try {
      this.tokens = await loadTokens(root, this.project.config);
      this.tokenError = undefined;
    } catch (error) {
      this.tokens = emptyTokenSet;
      this.tokenError = (error as Error).message;
    }
    const previous = new Map(this.files);
    this.files.clear();
    for (const [path, loaded] of this.project.files) {
      if (loaded.parseError || !isDesignFile(loaded.raw) || Array.isArray(loaded.raw.nodes)) {
        this.files.set(path, {
          path,
          nodes: previous.get(path)?.nodes ?? {},
          error: loaded.parseError ? `not valid JSON: ${loaded.parseError}` : "not a design file; run `lamsa validate`",
        });
      } else {
        this.files.set(path, { path, nodes: loaded.raw.nodes });
      }
    }
  }

  snapshot(): ProjectSnapshot {
    const project = this.require();
    const fonts = fontSetup(project.config);
    return {
      root: project.root,
      name: basename(project.root),
      config: project.config,
      files: Object.fromEntries(this.files),
      tokens: this.tokens,
      tokenError: this.tokenError,
      fontCss: fonts.css,
      fontLinks: fonts.links,
      issues: this.issues(),
    };
  }

  private require(): Project {
    if (!this.project) throw new Error("no project open");
    return this.project;
  }

  private issues(): ProjectIssue[] {
    const project = this.require();
    return validateProject({ project, tokens: this.tokens });
  }

  private watch() {
    const project = this.require();
    const dirs = new Set<string>([project.root]);
    this.watcher = chokidar.watch([...dirs], {
      ignoreInitial: true,
      ignored: (path) =>
        /(^|[/\\])(node_modules|\.git|\.lamsa)([/\\]|$)/.test(path) ||
        (/\.[^/\\]+$/.test(basename(path)) &&
          !path.endsWith(".lamsa.json") &&
          !path.endsWith(".css") &&
          !path.endsWith(CONFIG_FILE)),
      awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 },
    });
    const onChange = (path: string) => {
      this.queue = this.queue.then(() => this.handleDiskChange(path)).catch(() => {});
    };
    this.watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
  }

  private async handleDiskChange(absolute: string) {
    const project = this.project;
    if (!project) return;
    const path = absolute.slice(project.root.length + 1).split("\\").join("/");
    const tokenSource = this.tokens.source;
    if (path === CONFIG_FILE || path === tokenSource || (path.endsWith(".css") && !tokenSource)) {
      await this.load(project.root);
      this.primeHistory();
      this.events.reloaded(this.snapshot());
      return;
    }
    if (!path.endsWith(".lamsa.json")) return;
    const designPaths = await listDesignFiles(project.root, project.config);
    const exists = existsSync(absolute);
    if (exists && !designPaths.includes(path)) return;

    let next: FileState;
    if (!exists) {
      this.files.delete(path);
      project.files.delete(path);
      next = { path, nodes: {}, error: "deleted" };
    } else {
      const text = await readFile(absolute, "utf8");
      if (text === this.written.get(path)) return;
      const parsed = parseDesign(text);
      const previous = this.files.get(path);
      next = parsed.nodes
        ? { path, nodes: parsed.nodes }
        : { path, nodes: previous?.nodes ?? {}, error: parsed.error };
      this.files.set(path, next);
      project.files.set(path, parsed.nodes ? { path, raw: JSON.parse(text) as unknown } : { path, raw: undefined, parseError: parsed.error });
    }
    const before = this.previousNodes.get(path) ?? {};
    const changedIds = diffIds(before, next.nodes);
    this.previousNodes.set(path, next.nodes);
    this.events.external({ path, file: next, changedIds, issues: this.issues() });
  }

  private previousNodes = new Map<string, Record<string, DesignNode>>();

  /**
   * Applies node-level writes onto the current disk contents (not our cached
   * copy), so a concurrent external edit to other nodes is never overwritten.
   */
  applyChanges(changes: NodeChange[]): Promise<{ ok: boolean; error?: string; issues: ProjectIssue[] }> {
    const run = async () => {
      const project = this.require();
      const byFile = new Map<string, NodeChange[]>();
      for (const change of changes) byFile.set(change.file, [...(byFile.get(change.file) ?? []), change]);
      for (const [path, list] of byFile) {
        const absolute = join(project.root, path);
        let file: DesignFile = { $schema: SCHEMA_URL, version: FORMAT_VERSION, nodes: {} };
        if (existsSync(absolute)) {
          const parsed = parseDesign(await readFile(absolute, "utf8"));
          if (!parsed.nodes) {
            return { ok: false, error: `${path} is invalid on disk (${parsed.error}); fix it before editing`, issues: this.issues() };
          }
          const raw = JSON.parse(await readFile(absolute, "utf8")) as DesignFile;
          file = { ...raw, nodes: parsed.nodes };
        }
        for (const change of list) {
          if (change.node === null) delete file.nodes[change.id];
          else file.nodes[change.id] = change.node;
        }
        this.written.set(path, stableStringify(file));
        await saveDesignFile(project.root, path, file);
        this.files.set(path, { path, nodes: file.nodes });
        this.previousNodes.set(path, file.nodes);
        project.files.set(path, { path, raw: file });
      }
      return { ok: true, issues: this.issues() };
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  icons(names: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of names) {
      const svg = lucideIconSvg(name);
      if (svg) result[name] = svg;
    }
    return result;
  }

  async setSelection(selection: string[], file?: string) {
    const project = this.project;
    if (!project) return;
    await writeSession(project.root, { selection, file });
  }

  async lastSession() {
    return this.project ? readSession(this.project.root) : undefined;
  }

  assetPath(relative: string): string | undefined {
    const project = this.project;
    if (!project) return undefined;
    const absolute = join(project.root, decodeURIComponent(relative));
    if (!absolute.startsWith(project.root)) return undefined;
    return absolute;
  }

  get assetsDir(): string | undefined {
    return this.project ? join(this.project.root, this.project.config.assetsDir) : undefined;
  }

  primeHistory() {
    for (const [path, state] of this.files) this.previousNodes.set(path, state.nodes);
  }
}

function diffIds(before: Record<string, DesignNode>, after: Record<string, DesignNode>): string[] {
  const ids = new Set<string>();
  for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[id]) !== JSON.stringify(after[id])) ids.add(id);
  }
  return [...ids];
}

