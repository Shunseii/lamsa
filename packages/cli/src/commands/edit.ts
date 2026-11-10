import { join } from "node:path";
import {
  addTree,
  deleteNodes,
  isDesignFile,
  moveNode,
  saveDesignFile,
  summarize,
  toRepoPath,
  validateProject,
  type Issue,
  type NestedNode,
  type Placement,
  type Project,
} from "@lamsa/core";
import { openWorkspace, readInput, type Workspace } from "../context.js";
import { CliError, ExitCode, formatIssue, type Output } from "../output.js";

async function persist(project: Project, paths: Iterable<string>) {
  for (const path of new Set(paths)) {
    const file = project.files.get(path);
    if (file && isDesignFile(file.raw)) await saveDesignFile(project.root, path, file.raw);
  }
}

/** Errors that touch the given nodes; edits are refused when they would introduce any. */
function issuesFor(workspace: Workspace, ids: Set<string>): Issue[] {
  return validateProject({ project: workspace.project, tokens: workspace.tokens }).filter(
    (issue) => issue.nodeId !== undefined && ids.has(issue.nodeId),
  );
}

function placementFrom({
  workspace,
  parent,
  file,
  before,
  after,
}: {
  workspace: Workspace;
  parent?: string;
  file?: string;
  before?: string;
  after?: string;
}): Placement {
  if (before && after) throw new CliError("pass --before or --after, not both");
  return {
    parentId: parent,
    file: file ? toRepoPath(workspace.project.root, file) : undefined,
    before,
    after,
  };
}

export async function addCommand({
  out,
  tree,
  parent,
  file,
  before,
  after,
  force,
}: {
  out: Output;
  tree: string;
  parent?: string;
  file?: string;
  before?: string;
  after?: string;
  force: boolean;
}): Promise<number> {
  const workspace = await openWorkspace();
  const input = (await readInput(tree)) as NestedNode | NestedNode[];
  if (!input || typeof input !== "object") throw new CliError("--tree must be a node object or an array of nodes");
  if (file && !file.endsWith(".lamsa.json")) {
    throw new CliError(`design files end in .lamsa.json: ${file}`, ExitCode.usage);
  }
  const placement = placementFrom({ workspace, parent, file, before, after });
  const result = addTree({ project: workspace.project, input, placement });
  const issues = issuesFor(workspace, new Set(result.created));
  const counts = summarize(issues);
  if (counts.errors > 0 && !force) {
    out.result({ ok: false, written: false, issues }, () =>
      [...issues.map(formatIssue), "nothing written; fix the input or pass --force"].join("\n"),
    );
    return ExitCode.invalid;
  }
  await persist(workspace.project, [result.file]);
  out.result({ ok: true, written: true, ...result, issues }, () =>
    [
      ...issues.map(formatIssue),
      `added ${result.created.length} node(s) to ${result.file}`,
      `top-level ids: ${result.rootIds.join(", ")}`,
    ].join("\n"),
  );
  return ExitCode.ok;
}

export async function moveCommand({
  out,
  id,
  parent,
  file,
  before,
  after,
}: {
  out: Output;
  id: string;
  parent?: string;
  file?: string;
  before?: string;
  after?: string;
}): Promise<number> {
  const workspace = await openWorkspace();
  if (!parent && !file && !before && !after) {
    throw new CliError("say where to move it", ExitCode.usage, "pass --parent <frame>, --file <path> (top level), or --before/--after <sibling>");
  }
  let placement = placementFrom({ workspace, parent, file, before, after });
  if (!parent && !file && (before || after)) {
    const nodes = Object.fromEntries(
      [...workspace.project.files.values()].flatMap((f) => (isDesignFile(f.raw) ? Object.entries(f.raw.nodes) : [])),
    );
    const sibling = nodes[(before ?? after)!];
    placement = { ...placement, parentId: sibling?.parentId };
    if (sibling && sibling.parentId === undefined) {
      const owner = [...workspace.project.files.values()].find((f) => isDesignFile(f.raw) && (before ?? after)! in f.raw.nodes);
      placement.file = owner?.path;
    }
  }
  const result = moveNode({ project: workspace.project, id, placement });
  await persist(workspace.project, [result.from, result.to]);
  out.result({ ok: true, ...result }, () =>
    `moved ${id} (${result.moved.length} node(s))${result.from !== result.to ? ` from ${result.from} to ${result.to}` : ` within ${result.to}`}`,
  );
  return ExitCode.ok;
}

export async function splitCommand({ out, id, to }: { out: Output; id: string; to: string }): Promise<number> {
  if (!to.endsWith(".lamsa.json")) throw new CliError(`design files end in .lamsa.json: ${to}`);
  return moveCommand({ out, id, file: to });
}

export async function deleteCommand({ out, ids }: { out: Output; ids: string[] }): Promise<number> {
  const workspace = await openWorkspace();
  const result = deleteNodes({ project: workspace.project, ids });
  await persist(workspace.project, result.files);
  out.result({ ok: true, ...result }, () =>
    [
      `deleted ${result.deleted.length} node(s)`,
      ...(result.danglingInstances.length > 0
        ? [`warning: instances now point at a deleted component: ${result.danglingInstances.join(", ")}`]
        : []),
    ].join("\n"),
  );
  return ExitCode.ok;
}

export function defaultRenderDir(root: string): string {
  return join(root, ".lamsa", "render");
}
