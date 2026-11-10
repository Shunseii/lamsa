#!/usr/bin/env node
import { Command } from "commander";
import { checkCommandResult } from "./run.js";
import { fmtCommand, validateCommand } from "./commands/check.js";
import { addCommand, deleteCommand, moveCommand, splitCommand } from "./commands/edit.js";
import { componentsCommand, diffCommand, selectionCommand, tokensCommand, treeCommand } from "./commands/read.js";
import { renderCommand } from "./commands/render.js";
import { reportCommand } from "./commands/report.js";
import { initCommand, migrateCommand, openCommand, schemaCommand, skillCommand } from "./commands/setup.js";
import { createOutput } from "./output.js";

const program = new Command()
  .name("lamsa")
  .description("Design files for apps, driven by your own coding agent. Every command is non-interactive.")
  .version("0.1.0")
  .option("--json", "machine-readable output")
  .showHelpAfterError();

const out = () => createOutput(Boolean(program.opts().json));
const run = (task: () => Promise<number>) => checkCommandResult(task, Boolean(program.opts().json));

program
  .command("init")
  .description("set up lamsa in this repo: config, agent skill, AGENTS.md section")
  .option("--agent <name>", "claude | codex | cursor | generic", "claude")
  .option("--tokens <path>", "token source CSS (default: detect globals.css)")
  .option("--designs <dir>", "where design files live", "designs")
  .option("--force", "overwrite an existing lamsa.config.json")
  .option("--yes", "accepted for scripts; init never prompts")
  .action((o) => run(() => initCommand({ out: out(), agent: o.agent, tokens: o.tokens, designs: o.designs, force: !!o.force })));

program
  .command("validate [files...]")
  .description("check design files; exit 1 on errors")
  .action((files: string[]) => run(() => validateCommand({ out: out(), files })));

program
  .command("fmt [files...]")
  .description("normalise files: flatten nested children, fill order indexes, sort keys")
  .option("--fix", "also remove orphaned nodes")
  .option("--check", "report without writing; exit 1 if anything would change")
  .action((files: string[], o) => run(() => fmtCommand({ out: out(), files, fix: !!o.fix, check: !!o.check })));

program
  .command("tree [targets...]")
  .description("show node structure with IDs (targets: node ID, file, or top-level name)")
  .option("--depth <n>", "limit depth", (v) => Number.parseInt(v, 10))
  .action((targets: string[], o) => run(() => treeCommand({ out: out(), targets, depth: o.depth })));

program
  .command("tokens")
  .description("list design tokens read from the app's CSS")
  .option("--kind <kind>", "color | radius | font | spacing | shadow | text | other")
  .action((o) => run(() => tokensCommand({ out: out(), kind: o.kind })));

program
  .command("components")
  .description("list components and their props")
  .option("--all", "include internal components")
  .action((o) => run(() => componentsCommand({ out: out(), all: !!o.all })));

program
  .command("add")
  .description("insert nodes from nested JSON")
  .requiredOption("--tree <json>", "node or array of nodes (inline JSON, a file path, or - for stdin)")
  .option("--parent <id>", "frame to insert into")
  .option("--file <path>", "design file for top-level nodes (created if missing)")
  .option("--before <id>", "insert before this sibling")
  .option("--after <id>", "insert after this sibling")
  .option("--force", "write even if the result has validation errors")
  .action((o) =>
    run(() =>
      addCommand({ out: out(), tree: o.tree, parent: o.parent, file: o.file, before: o.before, after: o.after, force: !!o.force }),
    ),
  );

program
  .command("move <id>")
  .description("reparent or reorder a node with its subtree")
  .option("--parent <id>", "new parent frame")
  .option("--file <path>", "make it top-level in this file")
  .option("--before <id>", "place before this sibling")
  .option("--after <id>", "place after this sibling")
  .action((id: string, o) =>
    run(() => moveCommand({ out: out(), id, parent: o.parent, file: o.file, before: o.before, after: o.after })),
  );

program
  .command("split <id>")
  .description("move a top-level node and its subtree into another file")
  .requiredOption("--to <file>", "target design file")
  .action((id: string, o) => run(() => splitCommand({ out: out(), id, to: o.to })));

program
  .command("delete <ids...>")
  .description("remove nodes and their subtrees")
  .action((ids: string[]) => run(() => deleteCommand({ out: out(), ids })));

program
  .command("render [targets...]")
  .description("render top-level frames to PNG (default: all)")
  .option("--out <dir>", "output directory (default .lamsa/render)")
  .option("--scale <n>", "device scale factor", (v) => Number.parseFloat(v), 2)
  .option("--mode <mode>", "force light or dark tokens")
  .action((targets: string[], o) =>
    run(() => renderCommand({ out: out(), targets, outDir: o.out, scale: o.scale, mode: o.mode })),
  );

program
  .command("diff [ref]")
  .description("semantic design changes since a git ref (default HEAD)")
  .action((ref: string | undefined) => run(() => diffCommand({ out: out(), ref: ref ?? "HEAD" })));

program
  .command("report")
  .description("before/after renders and a markdown summary of design changes since a git ref (for PRs)")
  .option("--base <ref>", "git ref to compare against", "origin/main")
  .option("--out <dir>", "output directory", ".lamsa/report")
  .option("--image-base-url <url>", "prefix for image links in report.md")
  .option("--scale <n>", "device scale factor", (v) => Number.parseFloat(v), 2)
  .action((o) =>
    run(() => reportCommand({ out: out(), base: o.base, outDir: o.out, imageBaseUrl: o.imageBaseUrl, scale: o.scale })),
  );

program
  .command("selection")
  .description("what the user has selected in the desktop editor")
  .action(() => run(() => selectionCommand({ out: out() })));

program
  .command("open [file]")
  .description("show a design in the desktop editor (optional; nothing else needs it)")
  .option("--select <id>", "node to select")
  .action((file: string | undefined, o) => run(() => openCommand({ out: out(), file, select: o.select })));

program
  .command("migrate")
  .description("upgrade design files to the current format version")
  .action(() => run(() => migrateCommand({ out: out() })));

program.command("schema").description("print the design file JSON Schema").action(() => run(() => schemaCommand({ out: out() })));
program.command("skill").description("print the agent guide").action(() => run(() => skillCommand({ out: out() })));

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`lamsa: ${(error as Error).message}\n`);
  process.exit(2);
});
