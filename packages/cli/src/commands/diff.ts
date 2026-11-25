import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  allNodes,
  diffAgainstRef,
  findProjectRoot,
  fontSetup,
  loadProject,
  loadTokens,
  type DesignDiff,
  type NodeChange,
  type ScreenChange,
  type ValueChange,
} from "@lamsa/core";
import type { DesignNode } from "@lamsa/schema";
import { openWorkspace, type Workspace } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";
import { renderFrames, type Mark, type RenderedFrame } from "../render.js";
import { diffMarkdown, diffPage } from "./diff-page.js";

export const MARK_COLORS = { added: "#16a34a", removed: "#dc2626", changed: "#d97706" } as const;

/** What `lamsa diff` found for one screen, with its images once rendered. */
export interface ScreenReport extends ScreenChange {
  changes: NodeChange[];
  before?: string;
  after?: string;
  beforeMarked?: string;
  afterMarked?: string;
  /** Rendered sizes in pixels, so both sides can be shown at the same scale. */
  beforeSize?: { width: number; height: number };
  afterSize?: { width: number; height: number };
  /** False when the before and after renders came out identical. */
  visible?: boolean;
}

const OUTPUT_FILE = /\.(before|after)(\.marked)?\.png$|^(index\.html|report\.md)$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function workspaceAt(root: string): Promise<Workspace> {
  const project = await loadProject(root);
  return { project, tokens: await loadTokens(root, project.config), fonts: fontSetup(project.config) };
}

/** Checks `ref` out into a temporary worktree, runs `use` on the project there, then removes it. */
async function atRef<T>({ root, ref, use }: { root: string; ref: string; use: (workspace: Workspace | undefined) => Promise<T> }): Promise<T> {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  const worktree = mkdtempSync(join(tmpdir(), "lamsa-ref-"));
  try {
    try {
      git(top, ["worktree", "add", "--detach", "--force", worktree, ref]);
    } catch (error) {
      throw new CliError(`could not check out ${ref}: ${(error as Error).message}`, ExitCode.notFound, "fetch the ref first (e.g. git fetch origin main)");
    }
    const projectRoot = findProjectRoot(join(worktree, relative(top, root)));
    return await use(projectRoot && existsSync(projectRoot) ? await workspaceAt(projectRoot) : undefined);
  } finally {
    try {
      git(top, ["worktree", "remove", "--force", worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

const pngSize = (path: string) => {
  const header = readFileSync(path).subarray(16, 24);
  return { width: header.readUInt32BE(0), height: header.readUInt32BE(4) };
};

const MAX_VALUE = 40;

export function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  const text = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
}

/** One change in words: `width 342 → "100%"`, `moved into Form`, `reordered`. */
export function describeValue({ value, names }: { value: ValueChange; names: (id: unknown) => string }): string {
  if (value.field === "index") return "reordered";
  if (value.field === "parentId") return `moved into ${names(value.after)}`;
  if (value.field === "file") return `moved to ${String(value.after)}`;
  const field = value.field.replace(/^style\./, "");
  return `${field} ${formatValue(value.before)} → ${formatValue(value.after)}`;
}

const label = (node: { name?: string; type: string; id: string; text?: string; content?: string }) =>
  node.name ?? (node.text !== undefined ? JSON.stringify(node.text) : node.type === "text" && node.content ? JSON.stringify(node.content.slice(0, 40)) : `${node.type} ${node.id}`);

function screenLines({ screen, names }: { screen: ScreenReport; names: (id: unknown) => string }): string[] {
  const symbol = { added: "+", removed: "-", changed: "~" } as const;
  const head = `${symbol[screen.kind]} ${screen.name ?? screen.id}  ${screen.file}${screen.visible === false ? "  (no visible change)" : ""}`;
  if (screen.kind !== "changed") return [head];
  const lines = [head];
  const shown = screen.changes.filter((change) => change.id !== screen.id || change.kind === "changed");
  for (const change of shown.slice(0, 12)) {
    const detail = change.kind === "changed" ? change.values!.map((value) => describeValue({ value, names })).join(" · ") : change.type;
    lines.push(`    ${symbol[change.kind]} ${label(change)}  ${detail}`);
  }
  if (shown.length > 12) lines.push(`    … ${shown.length - 12} more`);
  if (screen.components.length) lines.push(`    via ${screen.components.map(names).join(", ")}`);
  return lines;
}

export function summarize(diff: DesignDiff): string {
  const count = (kind: ScreenChange["kind"]) => diff.screens.filter((screen) => screen.kind === kind).length;
  const parts = [
    `${count("changed")} changed`,
    count("added") && `${count("added")} new`,
    count("removed") && `${count("removed")} removed`,
  ].filter(Boolean);
  const plural = (n: number, word: string) => `${word}${n === 1 ? "" : "s"}`;
  const screens = `${parts.join(" · ")} ${plural(diff.screens.length, "screen")}`;
  const moved = diff.repositioned.length ? ` · ${diff.repositioned.length} moved on the canvas` : "";
  return `${screens}${moved} · ${diff.changes.length} layer ${plural(diff.changes.length, "change")} (${diff.base} → ${diff.head})`;
}

function openInBrowser(path: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [path], { detached: true, stdio: "ignore" }).unref();
}

export async function diffCommand({
  out,
  base,
  head,
  only,
  render,
  outDir,
  open,
  imageBaseUrl,
  scale,
  exitCode,
}: {
  out: Output;
  base: string;
  /** A git ref; the working tree when absent. */
  head?: string;
  only?: string[];
  render: boolean;
  outDir: string;
  open: boolean;
  imageBaseUrl?: string;
  scale: number;
  /** Exit with 1 when there are changes, like `git diff --exit-code`. */
  exitCode: boolean;
}): Promise<number> {
  const current = await openWorkspace();
  const root = current.project.root;
  let diff: DesignDiff;
  try {
    diff = diffAgainstRef({ project: current.project, ref: base, head, only });
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.notFound, "check the ref with `git log`, or fetch it first");
  }

  const after = allNodes(current.project);
  const nameOf = (nodes: Record<string, DesignNode>) => (id: unknown) => {
    const node = typeof id === "string" ? nodes[id] : undefined;
    return node ? label({ ...node, id: id as string }) : String(id);
  };
  const screens: ScreenReport[] = diff.screens.map((screen) => ({
    ...screen,
    changes: diff.changes.filter((change) => change.screen === screen.id),
  }));

  const dir = resolve(root, outDir);
  if (render && screens.length > 0) {
    mkdirSync(dir, { recursive: true });
    for (const file of readdirSync(dir)) if (OUTPUT_FILE.test(file)) rmSync(join(dir, file));
    const log = (message: string) => process.stderr.write(message + "\n");
    const marksFor = (side: "before" | "after") =>
      Object.fromEntries(
        screens
          .filter((screen) => screen.kind === "changed")
          .map((screen): [string, Mark[]] => [
            screen.id,
            [
              { ids: side === "before" ? screen.removed : screen.added, color: side === "before" ? MARK_COLORS.removed : MARK_COLORS.added },
              { ids: screen.changed, color: MARK_COLORS.changed },
            ],
          ]),
      );
    const draw = async ({ workspace, side }: { workspace: Workspace | undefined; side: "before" | "after" }): Promise<RenderedFrame[]> => {
      if (!workspace) return [];
      const nodes = allNodes(workspace.project);
      const ids = screens
        .filter((screen) => screen.kind !== (side === "before" ? "added" : "removed"))
        .map((screen) => screen.id)
        .filter((id) => nodes[id] && nodes[id]!.parentId === undefined);
      if (!ids.length) return [];
      return renderFrames({
        workspace,
        ids,
        outDir: dir,
        scale,
        naming: (id) => `${id}.${side}.png`,
        marks: marksFor(side),
        markedNaming: (id) => `${id}.${side}.marked.png`,
        log,
      });
    };
    const afterFrames = head ? await atRef({ root, ref: head, use: (workspace) => draw({ workspace, side: "after" }) }) : await draw({ workspace: current, side: "after" });
    const beforeFrames = await atRef({ root, ref: base, use: (workspace) => draw({ workspace, side: "before" }) });
    const fileName = (frame: RenderedFrame | undefined, marked: boolean) => {
      const path = marked ? frame?.markedPath : frame?.path;
      return path ? relative(dir, path) : undefined;
    };
    for (const screen of screens) {
      const before = beforeFrames.find((frame) => frame.id === screen.id);
      const afterFrame = afterFrames.find((frame) => frame.id === screen.id);
      screen.before = fileName(before, false);
      screen.after = fileName(afterFrame, false);
      screen.beforeMarked = fileName(before, true);
      screen.afterMarked = fileName(afterFrame, true);
      screen.beforeSize = before && pngSize(before.path);
      screen.afterSize = afterFrame && pngSize(afterFrame.path);
      if (screen.kind === "changed" && before && afterFrame) {
        screen.visible = !readFileSync(before.path).equals(readFileSync(afterFrame.path));
      }
    }
    const page = { diff, screens, colors: MARK_COLORS, names: nameOf(after), describe: describeValue };
    writeFileSync(join(dir, "index.html"), diffPage(page));
    writeFileSync(join(dir, "report.md"), diffMarkdown({ ...page, imageBaseUrl }));
    if (open) openInBrowser(join(dir, "index.html"));
  }

  const rendered = render && screens.length > 0;
  out.result(
    {
      ok: true,
      base: diff.base,
      head: diff.head,
      changes: diff.changes,
      screens: screens.map(({ changes: _changes, ...screen }) => screen),
      affectedRoots: diff.affectedRoots,
      repositioned: diff.repositioned,
      ...(rendered ? { outDir: dir, page: join(dir, "index.html"), report: join(dir, "report.md") } : {}),
    },
    () => {
      if (diff.changes.length === 0) return `no design changes (${diff.base} → ${diff.head})`;
      const names = nameOf(after);
      const ordered = [...screens].sort((a, b) => Number(a.visible === false) - Number(b.visible === false));
      const lines = [summarize(diff), "", ...ordered.flatMap((screen) => screenLines({ screen, names }))];
      if (diff.repositioned.length) lines.push(`moved on the canvas: ${diff.repositioned.map(names).join(", ")}`);
      if (rendered) lines.push("", `→ ${relative(process.cwd(), join(dir, "index.html")) || "index.html"}${open ? " (opened)" : ""}`);
      return lines.join("\n");
    },
  );
  return exitCode && diff.changes.length > 0 ? ExitCode.invalid : ExitCode.ok;
}

