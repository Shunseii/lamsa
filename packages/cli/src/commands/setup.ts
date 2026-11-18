import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  allNodes,
  CONFIG_FILE,
  detectTokenSource,
  didYouMean,
  findProjectRoot,
  isDesignFile,
  loadProject,
  stableStringify,
  toRepoPath,
  writeFileAtomic,
} from "@lamsa/core";
import { designFileJsonSchema, FORMAT_VERSION, type LamsaConfigInput } from "@lamsa/schema";
import { resolveRoot } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";

const AGENTS = ["claude", "codex", "cursor", "generic"] as const;
type Agent = (typeof AGENTS)[number];

const MARK_START = "<!-- lamsa:start -->";
const MARK_END = "<!-- lamsa:end -->";

function skillText(): string {
  return readFileSync(fileURLToPath(new URL("../skill/SKILL.md", import.meta.url)), "utf8");
}

const AGENTS_SECTION = `${MARK_START}
## Design files (lamsa)

UI designs live in \`*.lamsa.json\` files (see \`lamsa.config.json\`). They are specs: read the JSON and a render, then implement with this repo's own components and tokens.

- Discover: \`lamsa tokens\`, \`lamsa components\`, \`lamsa tree\`.
- Change: \`lamsa add --tree\`, \`lamsa move\`, \`lamsa delete\`, or edit the JSON directly.
- Check: \`lamsa validate\`, then \`lamsa render <id|file>\` and look at the PNG.
- The user's selection in the editor: \`lamsa selection --json\`.
- Every command takes \`--json\`. Full guide: \`lamsa skill\`.
${MARK_END}
`;

async function upsertSection(path: string): Promise<"created" | "updated" | "unchanged"> {
  if (!existsSync(path)) {
    await writeFile(path, `# Agent instructions\n\n${AGENTS_SECTION}`);
    return "created";
  }
  const text = await readFile(path, "utf8");
  const start = text.indexOf(MARK_START);
  const end = text.indexOf(MARK_END);
  const next =
    start !== -1 && end > start
      ? text.slice(0, start) + AGENTS_SECTION.trimEnd() + text.slice(end + MARK_END.length)
      : `${text.trimEnd()}\n\n${AGENTS_SECTION}`;
  if (next === text) return "unchanged";
  await writeFile(path, next);
  return "updated";
}

async function ensureGitignore(root: string): Promise<boolean> {
  const path = join(root, ".gitignore");
  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  if (text.split("\n").some((line) => line.trim() === ".lamsa/" || line.trim() === ".lamsa")) return false;
  await writeFile(path, `${text}${text && !text.endsWith("\n") ? "\n" : ""}.lamsa/\n`);
  return true;
}

export async function initCommand({
  out,
  agent,
  tokens,
  designs,
  force,
}: {
  out: Output;
  agent: string;
  tokens?: string;
  designs: string;
  force: boolean;
}): Promise<number> {
  if (!AGENTS.includes(agent as Agent)) {
    throw new CliError(`unknown agent "${agent}"`, ExitCode.usage, `use one of ${AGENTS.join(", ")}`);
  }
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  const actions: string[] = [];
  const configPath = join(root, CONFIG_FILE);

  if (!existsSync(configPath) || force) {
    const tokenPath = tokens ?? detectTokenSource(root);
    const config: LamsaConfigInput = {
      designs: [`${designs.replace(/\/+$/, "")}/**/*.lamsa.json`],
      tokens: tokenPath ? { adapter: "shadcn-tailwind4", path: tokenPath } : { adapter: "none" },
      assetsDir: `${designs.replace(/\/+$/, "")}/assets`,
      agent: { command: agent === "generic" || agent === "cursor" ? "claude" : agent, args: [] },
    };
    await writeFileAtomic(configPath, stableStringify(config));
    actions.push(`wrote ${CONFIG_FILE}${tokenPath ? ` (tokens from ${tokenPath})` : " (no token source found; tokens disabled)"}`);
  } else {
    actions.push(`kept existing ${CONFIG_FILE}`);
  }

  await mkdir(join(root, designs), { recursive: true });

  if (agent === "claude") {
    const skillPath = join(root, ".claude", "skills", "lamsa", "SKILL.md");
    await mkdir(join(root, ".claude", "skills", "lamsa"), { recursive: true });
    await writeFile(skillPath, skillText());
    actions.push("installed skill at .claude/skills/lamsa/SKILL.md");
  } else if (agent === "cursor") {
    await mkdir(join(root, ".cursor", "rules"), { recursive: true });
    await writeFile(join(root, ".cursor", "rules", "lamsa.mdc"), skillText());
    actions.push("installed rule at .cursor/rules/lamsa.mdc");
  }
  actions.push(`${await upsertSection(join(root, "AGENTS.md"))} lamsa section in AGENTS.md`);
  if (await ensureGitignore(root)) actions.push("added .lamsa/ to .gitignore");

  out.result({ ok: true, root, agent, actions }, () => actions.join("\n"));
  return ExitCode.ok;
}

export async function skillCommand({ out }: { out: Output }): Promise<number> {
  const text = skillText();
  out.result({ ok: true, skill: text }, () => text);
  return ExitCode.ok;
}

export async function schemaCommand({ out }: { out: Output }): Promise<number> {
  const schema = designFileJsonSchema();
  process.stdout.write(JSON.stringify(schema, null, 2) + "\n");
  void out;
  return ExitCode.ok;
}

export async function migrateCommand({ out }: { out: Output }): Promise<number> {
  const project = await loadProject(resolveRoot());
  const report = [...project.files.values()].map((file) => {
    const version = isDesignFile(file.raw) ? (file.raw as { version?: number }).version : undefined;
    return { file: file.path, version, status: version === FORMAT_VERSION ? "current" : version && version > FORMAT_VERSION ? "newer" : "unknown" };
  });
  const newer = report.filter((r) => r.status === "newer");
  out.result({ ok: newer.length === 0, formatVersion: FORMAT_VERSION, files: report }, () =>
    newer.length > 0
      ? `${newer.length} file(s) are newer than this lamsa; upgrade lamsa`
      : `all ${report.length} file(s) are on format version ${FORMAT_VERSION}; nothing to migrate`,
  );
  return newer.length > 0 ? ExitCode.invalid : ExitCode.ok;
}

function findOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export async function openCommand({
  out,
  file,
  select,
}: {
  out: Output;
  file?: string;
  select?: string[];
}): Promise<number> {
  const root = resolveRoot();
  const ids = [...new Set((select ?? []).map((id) => id.trim()).filter(Boolean))];
  if (ids.length) await checkNodesExist({ root, ids });
  const app = process.env.LAMSA_DESKTOP_BIN ?? findOnPath("lamsa-desktop");
  if (!app) {
    throw new CliError(
      "the lamsa desktop app is not installed",
      ExitCode.notFound,
      "install it, or set LAMSA_DESKTOP_BIN; everything else works without it (use `lamsa render` to look at designs)",
    );
  }
  const args = [`--root=${root}`];
  if (file) args.push(`--file=${toRepoPath(root, file)}`);
  if (ids.length) args.push(`--select=${ids.join(",")}`);
  const child = spawn(app, args, { detached: true, stdio: "ignore" });
  child.unref();
  out.result({ ok: true, app, args, select: ids }, () => `opened lamsa${file ? ` on ${file}` : ""}${ids.length ? ` with ${ids.join(", ")} selected` : ""}`);
  return ExitCode.ok;
}

async function checkNodesExist({ root, ids }: { root: string; ids: string[] }): Promise<void> {
  const project = await loadProject(root);
  const nodes = allNodes(project);
  const missing = ids.filter((id) => !nodes[id.split("/")[0]!]);
  if (missing.length === 0) return;
  throw new CliError(
    `no node with ID ${missing.join(", ")}`,
    ExitCode.notFound,
    missing.map((id) => didYouMean(id, Object.keys(nodes))).filter(Boolean).join("; ") || "run `lamsa tree` to list nodes",
  );
}
