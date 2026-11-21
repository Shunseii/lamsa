import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import {
  CONFIG_FILE,
  fontSetup,
  formatFileCss,
  isDesignFile,
  readDesignFile,
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
import { isCssChange, type AddFilesResult, type Change, type ExternalChange, type FileState, type ProjectIssue, type ProjectSnapshot } from "../shared/api.js";

function parseDesign(text: string): { nodes?: Record<string, DesignNode>; css?: string; error?: string } {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isDesignFile(raw)) return { error: "missing a \"nodes\" map" };
    const nodes = raw.nodes as unknown;
    if (Array.isArray(nodes)) return { error: "nested node list; run `lamsa fmt`" };
    return { nodes: raw.nodes, css: typeof raw.css === "string" ? raw.css : undefined };
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
  /** Files shown in the editor; null until the user picks them. Saved in the session file. */
  private open: string[] | null = null;
  /** Files added by hand that the config's `designs` globs don't match (they may be outside the repo). */
  private extras = new Set<string>();
  private selection: { selection: string[]; file?: string } = { selection: [] };

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

  async openProject(root: string, { file }: { file?: string } = {}): Promise<ProjectSnapshot> {
    await this.close();
    const session = await readSession(root);
    this.selection = { selection: session?.selection ?? [], file: session?.file };
    this.extras = new Set((session?.open ?? []).filter((path) => path.endsWith(".lamsa.json")));
    await this.load(root);
    for (const path of this.extras) if (!this.files.has(path)) this.extras.delete(path);
    const open = session?.open?.filter((path) => this.files.has(path)) ?? null;
    // With one file (or none) there's nothing to choose, so it opens without asking.
    this.open = open ?? (this.files.size <= 1 ? [...this.files.keys()] : null);
    this.primeHistory();
    this.watch();
    if (file) await this.addFiles([file]);
    return this.snapshot();
  }

  /** A path as the editor keys it: relative to the repo root, with `/`. */
  private keyOf(path: string): string {
    return relative(this.require().root, resolve(this.require().root, path)).split("\\").join("/");
  }

  private async persistSession() {
    const project = this.project;
    if (!project) return;
    await writeSession(project.root, { ...this.selection, ...(this.open ? { open: this.open } : {}) });
  }

  async addFiles(paths: string[]): Promise<AddFilesResult> {
    const project = this.require();
    const errors: string[] = [];
    const added: FileState[] = [];
    const matched = new Set(await listDesignFiles(project.root, project.config));
    const open = new Set(this.open ?? []);
    for (const raw of paths) {
      const path = this.keyOf(raw);
      const absolute = join(project.root, path);
      if (!path.endsWith(".lamsa.json")) {
        errors.push(`${path} isn't a lamsa design file (*.lamsa.json)`);
        continue;
      }
      if (!this.files.has(path)) {
        if (!existsSync(absolute)) {
          errors.push(`${path} doesn't exist`);
          continue;
        }
        const loaded = await readDesignFile(project.root, path);
        if (loaded.parseError || !isDesignFile(loaded.raw)) {
          errors.push(`${path} isn't a valid design file${loaded.parseError ? `: ${loaded.parseError}` : ""}`);
          continue;
        }
        const state: FileState = { path, nodes: loaded.raw.nodes, css: loaded.raw.css };
        this.files.set(path, state);
        project.files.set(path, loaded);
        this.previousNodes.set(path, state.nodes);
        if (!matched.has(path)) {
          this.extras.add(path);
          if (path.startsWith("../")) this.watcher?.add(absolute);
        }
      }
      if (!open.has(path)) added.push(this.files.get(path)!);
      open.add(path);
    }
    this.open = [...open];
    await this.persistSession();
    return { files: added, open: this.open, issues: this.issues(), errors };
  }

  async setOpenFiles(paths: string[]): Promise<string[]> {
    this.open = paths.map((path) => this.keyOf(path)).filter((path) => this.files.has(path));
    await this.persistSession();
    return this.open;
  }

  async closeFile(path: string): Promise<string[]> {
    const key = this.keyOf(path);
    this.open = (this.open ?? [...this.files.keys()]).filter((p) => p !== key);
    await this.persistSession();
    return this.open;
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
    this.project = undefined;
    this.files.clear();
    this.written.clear();
    this.open = null;
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
        this.files.set(path, { path, nodes: loaded.raw.nodes, css: loaded.raw.css });
      }
    }
    for (const path of this.extras) {
      if (this.files.has(path) || !existsSync(join(root, path))) continue;
      const loaded = await readDesignFile(root, path);
      if (loaded.parseError || !isDesignFile(loaded.raw)) continue;
      this.project.files.set(path, loaded);
      this.files.set(path, { path, nodes: loaded.raw.nodes, css: loaded.raw.css });
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
      open: this.open,
    };
  }

  get config(): Project["config"] | undefined {
    return this.project?.config;
  }

  /** Each loaded file's current nodes, without the validation and font work a full snapshot does. */
  nodesByFile(): Map<string, Record<string, DesignNode>> {
    return new Map([...this.files].map(([path, file]) => [path, file.nodes]));
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
    for (const path of this.extras) if (path.startsWith("../")) dirs.add(join(project.root, path));
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
    const path = relative(project.root, absolute).split("\\").join("/");
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
    if (exists && !designPaths.includes(path) && !this.extras.has(path)) return;
    const isNew = exists && !this.files.has(path);
    let openChanged = false;

    let next: FileState;
    if (!exists) {
      this.files.delete(path);
      project.files.delete(path);
      next = { path, nodes: {}, error: "deleted" };
      if (this.open?.includes(path)) {
        this.open = this.open.filter((p) => p !== path);
        openChanged = true;
      }
    } else {
      const text = await readFile(absolute, "utf8");
      if (text === this.written.get(path)) return;
      const parsed = parseDesign(text);
      const previous = this.files.get(path);
      next = parsed.nodes
        ? { path, nodes: parsed.nodes, css: parsed.css }
        : { path, nodes: previous?.nodes ?? {}, css: previous?.css, error: parsed.error };
      this.files.set(path, next);
      project.files.set(path, parsed.nodes ? { path, raw: JSON.parse(text) as unknown } : { path, raw: undefined, parseError: parsed.error });
    }
    const before = this.previousNodes.get(path) ?? {};
    const changedIds = diffIds(before, next.nodes);
    this.previousNodes.set(path, next.nodes);
    // A file created while the editor is open (usually by the agent) is meant to be seen, so it opens.
    if (isNew && this.open && !this.open.includes(path)) {
      this.open = [...this.open, path];
      openChanged = true;
    }
    if (openChanged) await this.persistSession();
    this.events.external({ path, file: next, changedIds, issues: this.issues(), ...(openChanged && this.open ? { open: this.open } : {}) });
  }

  private previousNodes = new Map<string, Record<string, DesignNode>>();

  /**
   * Applies node-level writes onto the current disk contents (not our cached
   * copy), so a concurrent external edit to other nodes is never overwritten.
   */
  applyChanges(changes: Change[]): Promise<{ ok: boolean; error?: string; issues: ProjectIssue[] }> {
    const run = async () => {
      const project = this.require();
      const byFile = new Map<string, Change[]>();
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
          if (isCssChange(change)) {
            const { css: _old, ...rest } = file;
            const css = formatFileCss(change.css);
            file = css.trim() ? { ...rest, css } : rest;
          } else if (change.node === null) delete file.nodes[change.id];
          else file.nodes[change.id] = change.node;
        }
        this.written.set(path, stableStringify(file));
        await saveDesignFile(project.root, path, file);
        this.files.set(path, { path, nodes: file.nodes, css: file.css });
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
    this.selection = { selection, file };
    await this.persistSession();
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

