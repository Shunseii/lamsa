import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { allNodes, diffAgainstRef, findProjectRoot, fontSetup, loadProject, loadTokens } from "@lamsa/core";
import { openWorkspace, type Workspace } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";
import { renderFrames } from "../render.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function workspaceAt(root: string): Promise<Workspace> {
  const project = await loadProject(root);
  return { project, tokens: await loadTokens(root, project.config), fonts: fontSetup(project.config) };
}

export async function reportCommand({
  out,
  base,
  outDir,
  imageBaseUrl,
  scale,
}: {
  out: Output;
  base: string;
  outDir: string;
  imageBaseUrl?: string;
  scale: number;
}): Promise<number> {
  const head = await openWorkspace();
  const root = head.project.root;
  const diff = diffAgainstRef({ project: head.project, ref: base });
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });

  const headNodes = allNodes(head.project);
  const affected = diff.affectedRoots.filter((id) => headNodes[id]);
  const removedRoots = diff.changes.filter((c) => c.kind === "removed" && !headNodes[c.id]).map((c) => c.id);

  const log = (message: string) => process.stderr.write(message + "\n");
  const after = affected.length
    ? await renderFrames({ workspace: head, ids: affected, outDir: dir, scale, naming: (id) => `${id}.after.png`, log })
    : [];

  let before: Awaited<ReturnType<typeof renderFrames>> = [];
  const gitTop = git(root, ["rev-parse", "--show-toplevel"]);
  const prefix = relative(gitTop, root);
  const worktree = mkdtempSync(join(tmpdir(), "lamsa-base-"));
  try {
    git(gitTop, ["worktree", "add", "--detach", "--force", worktree, base]);
    const baseRoot = findProjectRoot(join(worktree, prefix));
    if (baseRoot && existsSync(baseRoot)) {
      const baseWorkspace = await workspaceAt(baseRoot);
      const baseNodes = allNodes(baseWorkspace.project);
      const ids = [...affected, ...removedRoots].filter((id) => baseNodes[id] && baseNodes[id]!.parentId === undefined);
      if (ids.length) before = await renderFrames({ workspace: baseWorkspace, ids, outDir: dir, scale, naming: (id) => `${id}.before.png`, log });
    }
  } catch (error) {
    throw new CliError(`could not check out ${base}: ${(error as Error).message}`, ExitCode.notFound, "fetch the base ref first (e.g. git fetch origin main)");
  } finally {
    try {
      git(gitTop, ["worktree", "remove", "--force", worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }

  const url = (file: string) => (imageBaseUrl ? `${imageBaseUrl.replace(/\/$/, "")}/${file}` : file);
  const beforeById = new Map(before.map((f) => [f.id, f]));
  const afterById = new Map(after.map((f) => [f.id, f]));
  const counts = {
    added: diff.changes.filter((c) => c.kind === "added").length,
    changed: diff.changes.filter((c) => c.kind === "changed").length,
    removed: diff.changes.filter((c) => c.kind === "removed").length,
  };

  const lines: string[] = ["<!-- lamsa-report -->", "## lamsa design changes", ""];
  if (diff.changes.length === 0) {
    lines.push(`No design changes since \`${base}\`.`);
  } else {
    lines.push(`**${counts.added}** added · **${counts.changed}** changed · **${counts.removed}** removed nodes since \`${base}\`.`, "");
    for (const id of [...affected, ...removedRoots]) {
      const name = headNodes[id]?.name ?? beforeById.get(id)?.name ?? id;
      lines.push(`### ${name} \`${id}\``, "", "| Before | After |", "|---|---|");
      const b = beforeById.get(id);
      const a = afterById.get(id);
      lines.push(`| ${b ? `<img src="${url(`${id}.before.png`)}" width="360">` : "_new_"} | ${a ? `<img src="${url(`${id}.after.png`)}" width="360">` : "_removed_"} |`, "");
    }
    lines.push("<details><summary>Node changes</summary>", "", "| | Node | File | Fields |", "|---|---|---|---|");
    const symbol = { added: "+", removed: "−", changed: "~" } as const;
    for (const change of diff.changes) {
      lines.push(`| ${symbol[change.kind]} | ${change.type} \`${change.id}\`${change.name ? ` ${change.name}` : ""} | ${change.file} | ${change.fields?.join(", ") ?? ""} |`);
    }
    lines.push("", "</details>");
  }
  lines.push("", "<sub>Rendered by `lamsa report`. Designs are specs; the agent implements them in code.</sub>", "");
  const markdown = lines.join("\n");
  writeFileSync(join(dir, "report.md"), markdown);

  out.result(
    {
      ok: true,
      base,
      outDir: dir,
      report: join(dir, "report.md"),
      changes: counts,
      frames: [...affected, ...removedRoots].map((id) => ({
        id,
        before: beforeById.has(id) ? `${id}.before.png` : null,
        after: afterById.has(id) ? `${id}.after.png` : null,
      })),
    },
    () => `${diff.changes.length} node change(s), ${affected.length + removedRoots.length} screen(s) rendered → ${relative(process.cwd(), join(dir, "report.md")) || "report.md"}`,
  );
  return ExitCode.ok;
}
