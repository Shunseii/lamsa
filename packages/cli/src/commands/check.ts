import {
  formatDesignFile,
  allNodes,
  isDesignFile,
  listDesignFiles,
  loadComments,
  loadConfig,
  readDesignFile,
  saveDesignFile,
  stableStringify,
  summarize,
  toRepoPath,
  validateComments,
  validateProject,
} from "@lamsa/core";
import { openWorkspace, resolveRoot } from "../context.js";
import { ExitCode, formatIssue, type Output } from "../output.js";

export async function validateCommand({
  out,
  files,
}: {
  out: Output;
  files: string[];
}): Promise<number> {
  const workspace = await openWorkspace();
  const comments = await loadComments({ root: workspace.project.root, config: workspace.project.config });
  const all = [
    ...validateProject({ project: workspace.project, tokens: workspace.tokens }),
    ...comments.issues,
    ...validateComments({ threads: comments.threads, nodes: allNodes(workspace.project) }),
  ];
  const wanted = new Set(files.map((f) => toRepoPath(workspace.project.root, f)));
  const issues = wanted.size > 0 ? all.filter((i) => !i.file || wanted.has(i.file)) : all;
  const counts = summarize(issues);
  out.result({ ok: counts.errors === 0, ...counts, files: workspace.project.files.size, issues }, () => {
    const lines = issues.map(formatIssue);
    lines.push(
      counts.errors === 0
        ? `valid · ${workspace.project.files.size} file(s)${counts.warnings ? ` · ${counts.warnings} warning(s)` : ""}`
        : `${counts.errors} error(s), ${counts.warnings} warning(s)`,
    );
    return lines.join("\n");
  });
  return counts.errors === 0 ? ExitCode.ok : ExitCode.invalid;
}

export async function fmtCommand({
  out,
  files,
  fix,
  check,
}: {
  out: Output;
  files: string[];
  fix: boolean;
  check: boolean;
}): Promise<number> {
  const root = resolveRoot();
  const config = await loadConfig(root);
  const paths = files.length > 0 ? files.map((f) => toRepoPath(root, f)) : await listDesignFiles(root, config);
  const loaded = await Promise.all(paths.map((p) => readDesignFile(root, p)));

  const taken = new Set<string>();
  for (const file of loaded) {
    if (isDesignFile(file.raw)) for (const id of Object.keys(file.raw.nodes)) taken.add(id);
  }

  const report: { file: string; changed: boolean; changes: string[]; error?: string }[] = [];
  for (const file of loaded) {
    if (file.parseError) {
      report.push({ file: file.path, changed: false, changes: [], error: `not valid JSON: ${file.parseError}` });
      continue;
    }
    const { file: formatted, changes } = formatDesignFile({ raw: file.raw, fix, takenIds: taken });
    const before = stableStringify(file.raw);
    const after = stableStringify(formatted);
    const original = JSON.stringify(file.raw, null, 2) + "\n";
    const changed = before !== after || original !== after;
    if (changed && !check) await saveDesignFile(root, file.path, formatted);
    report.push({ file: file.path, changed, changes: changed && changes.length === 0 ? ["sorted keys"] : changes });
  }

  const failed = report.filter((r) => r.error);
  const changed = report.filter((r) => r.changed);
  out.result({ ok: failed.length === 0 && (!check || changed.length === 0), check, files: report }, () =>
    [
      ...report.flatMap((r) =>
        r.error
          ? [`error ${r.file}: ${r.error}`]
          : r.changed
            ? [`${check ? "would format" : "formatted"} ${r.file}`, ...r.changes.map((c) => `  - ${c}`)]
            : [],
      ),
      `${changed.length} of ${report.length} file(s) ${check ? "need formatting" : "changed"}`,
    ].join("\n"),
  );
  if (failed.length > 0) return ExitCode.invalid;
  return check && changed.length > 0 ? ExitCode.invalid : ExitCode.ok;
}
