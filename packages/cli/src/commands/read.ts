import {
  allNodes,
  buildChildIndex,
  diffAgainstRef,
  didYouMean,
  indexNodes,
  isDesignFile,
  readSession,
  toRepoPath,
  treeLines,
  type Project,
} from "@lamsa/core";
import { openWorkspace } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";

/** Accepts node IDs, design file paths (→ their top-level nodes) and exact top-level names. */
export function resolveTargets(project: Project, targets: string[]): string[] {
  const nodes = allNodes(project);
  const index = buildChildIndex(nodes);
  if (targets.length === 0) return index.roots;
  const result: string[] = [];
  for (const target of targets) {
    if (nodes[target]) {
      result.push(target);
      continue;
    }
    const path = toRepoPath(project.root, target);
    const file = project.files.get(path);
    if (file) {
      if (isDesignFile(file.raw)) {
        result.push(...index.roots.filter((id) => id in (file.raw as { nodes: object }).nodes));
      }
      continue;
    }
    const named = index.roots.filter((id) => nodes[id]?.name === target);
    if (named.length === 1) {
      result.push(named[0]!);
      continue;
    }
    if (named.length > 1) {
      throw new CliError(`"${target}" names ${named.length} top-level nodes: ${named.join(", ")}`, ExitCode.usage, "pass the node ID instead");
    }
    const candidates = [...Object.keys(nodes), ...index.roots.map((id) => nodes[id]?.name ?? "")].filter(Boolean);
    throw new CliError(`no node, file or top-level name matches "${target}"`, ExitCode.notFound, didYouMean(target, candidates) || "run `lamsa tree` to list nodes");
  }
  return [...new Set(result)];
}

export async function treeCommand({
  out,
  targets,
  depth,
}: {
  out: Output;
  targets: string[];
  depth?: number;
}): Promise<number> {
  const { project } = await openWorkspace();
  const nodes = allNodes(project);
  const index = buildChildIndex(nodes);
  const locations = indexNodes(project);
  const from = resolveTargets(project, targets);
  const lines = treeLines({ nodes, index, from, maxDepth: depth ?? Infinity });
  out.result(
    {
      ok: true,
      nodes: lines.map((line) => ({
        id: line.id,
        depth: line.depth,
        file: locations.get(line.id)?.file,
        parentId: nodes[line.id]?.parentId,
        ...nodes[line.id],
      })),
    },
    () => {
      let currentFile: string | undefined;
      const text: string[] = [];
      for (const line of lines) {
        const file = locations.get(line.id)?.file;
        if (line.depth === 0 && file !== currentFile) {
          currentFile = file;
          text.push(`${file}`);
        }
        text.push(`${"  ".repeat(line.depth + 1)}${line.label}`);
      }
      return text.length > 0 ? text.join("\n") : "no nodes";
    },
  );
  return ExitCode.ok;
}

export async function tokensCommand({ out, kind }: { out: Output; kind?: string }): Promise<number> {
  const { tokens } = await openWorkspace();
  const list = Object.values(tokens.tokens)
    .filter((t) => !kind || t.kind === kind)
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  out.result({ ok: true, adapter: tokens.adapter, source: tokens.source, tokens: list }, () => {
    if (list.length === 0) return `no tokens (adapter: ${tokens.adapter})`;
    const width = Math.max(...list.map((t) => t.path.length)) + 2;
    return [
      `${tokens.adapter}${tokens.source ? ` · ${tokens.source}` : ""} · ${list.length} token(s) · use as "{path}"`,
      ...list.map((t) => `  ${`{${t.path}}`.padEnd(width + 2)} ${t.values.light}${t.values.dark ? `  /  dark: ${t.values.dark}` : ""}`),
    ].join("\n");
  });
  return ExitCode.ok;
}

export async function componentsCommand({ out, all }: { out: Output; all: boolean }): Promise<number> {
  const { project } = await openWorkspace();
  const locations = indexNodes(project);
  const components = [...locations.entries()]
    .filter(([, { node }]) => node.type === "frame" && node.component && (all || !node.component.internal))
    .map(([id, { file, node }]) => ({
      id,
      file,
      name: node.name,
      description: node.type === "frame" ? node.component?.description : undefined,
      internal: node.type === "frame" ? (node.component?.internal ?? false) : false,
      props: node.type === "frame" ? (node.component?.props ?? {}) : {},
    }));
  out.result({ ok: true, components }, () => {
    if (components.length === 0) return "no components; mark a frame with \"component\": {} to make one";
    return components
      .map((c) => {
        const props = Object.entries(c.props).map(([name, def]) =>
          def.type === "enum"
            ? `${name}: ${def.options.join(" | ")} (default ${def.default})`
            : def.type === "boolean"
              ? `${name}: boolean (default ${def.default})`
              : `${name}: text → ${def.target}`,
        );
        return [`${c.id} ${JSON.stringify(c.name ?? "")} · ${c.file}${c.internal ? " · internal" : ""}`, ...props.map((p) => `    ${p}`)].join("\n");
      })
      .join("\n");
  });
  return ExitCode.ok;
}

export async function selectionCommand({ out }: { out: Output }): Promise<number> {
  const { project } = await openWorkspace();
  const session = await readSession(project.root);
  const nodes = allNodes(project);
  const locations = indexNodes(project);
  const selection = (session?.selection ?? []).map((id) => {
    const baseId = id.split("/")[0]!;
    return { id, file: locations.get(baseId)?.file, node: nodes[baseId] ?? null };
  });
  out.result({ ok: true, editorOpen: !!session, updatedAt: session?.updatedAt, selection }, () => {
    if (!session) return "no editor session (the desktop app has not run in this repo)";
    if (selection.length === 0) return "nothing selected";
    return selection
      .map((s) => `${s.id}${s.node?.name ? ` ${JSON.stringify(s.node.name)}` : ""} (${s.node?.type ?? "missing"}) in ${s.file ?? "?"}`)
      .join("\n");
  });
  return ExitCode.ok;
}

export async function diffCommand({ out, ref }: { out: Output; ref: string }): Promise<number> {
  const { project } = await openWorkspace();
  const diff = diffAgainstRef({ project, ref });
  out.result({ ok: true, ...diff }, () => {
    if (diff.changes.length === 0) return `no design changes since ${ref}`;
    const symbol = { added: "+", removed: "-", changed: "~" } as const;
    return [
      ...diff.changes.map(
        (c) =>
          `${symbol[c.kind]} ${c.type} ${c.id}${c.name ? ` ${JSON.stringify(c.name)}` : ""} · ${c.file}${c.fields ? ` · ${c.fields.join(", ")}` : ""}`,
      ),
      `affected screens: ${diff.affectedRoots.join(", ") || "none"}`,
    ].join("\n");
  });
  return ExitCode.ok;
}
