#!/usr/bin/env node
import { Command } from "commander";
import { checkCommandResult } from "./run.js";
import { fmtCommand, validateCommand } from "./commands/check.js";
import { commentAddCommand, commentReopenCommand, commentReplyCommand, commentResolveCommand, commentsCommand } from "./commands/comments.js";
import { addCommand, deleteCommand, moveCommand, splitCommand } from "./commands/edit.js";
import { componentsCommand, selectionCommand, tokensCommand, treeCommand } from "./commands/read.js";
import { renderCommand } from "./commands/render.js";
import { diffCommand } from "./commands/diff.js";
import { initCommand, migrateCommand, openCommand, schemaCommand, skillCommand } from "./commands/setup.js";
import { createOutput } from "./output.js";
import packageJson from "../package.json" with { type: "json" };

const program = new Command()
  .name("lamsa")
  .description("Design files for apps, driven by your own coding agent. Every command is non-interactive.")
  .version(packageJson.version)
  .option("--json", "machine-readable output")
  .showHelpAfterError()
  .addHelpText("after", "\nAgent guide: lamsa skill. Editor and docs: https://github.com/Shunseii/lamsa");

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
  .option("--animate [frames]", "capture the frame's motion as a strip of moments (default 6)", (v) => Number.parseInt(v, 10))
  .option("--state <state>", "render with every node in a state: hover, press, focus, or a data-state value its css styles")
  .action((targets: string[], o) =>
    run(() =>
      renderCommand({
        out: out(),
        targets,
        outDir: o.out,
        scale: o.scale,
        mode: o.mode,
        animate: o.animate === true ? 6 : o.animate,
        state: o.state,
      }),
    ),
  );

program
  .command("diff [base] [head]")
  .description("design changes from a git ref (default HEAD) to another ref or the working tree, rendered as before/after images with changed layers outlined")
  .option("--text", "list the changes only, without rendering")
  .option("--file <paths...>", "only changes in these design files or globs")
  .option("--out <dir>", "where the images, index.html and report.md go", ".lamsa/diff")
  .option("--open", "open the page in the browser")
  .option("--image-base-url <url>", "prefix for image links in report.md (where the images will be hosted)")
  .option("--scale <n>", "device scale factor", (v) => Number.parseFloat(v), 2)
  .option("--exit-code", "exit with 1 when there are changes")
  .action((base: string | undefined, head: string | undefined, o) =>
    run(() =>
      diffCommand({
        out: out(),
        base: base ?? "HEAD",
        head,
        only: o.file,
        render: !o.text,
        outDir: o.out,
        open: o.open === true,
        imageBaseUrl: o.imageBaseUrl,
        scale: o.scale,
        exitCode: o.exitCode === true,
      }),
    ),
  );

program
  .command("selection")
  .description("what the user has selected in the desktop editor")
  .action(() => run(() => selectionCommand({ out: out() })));

const joinText = (words: string[]) => words.join(" ");

const comments = program
  .command("comments")
  .alias("comment")
  .description("comment threads pinned to layers: list them, or add, reply, resolve");

comments
  .command("list", { isDefault: true })
  .description("list comment threads (the default)")
  .option("--open", "only open threads")
  .option("--resolved", "only resolved threads")
  .option("--node <id>", "only threads pinned to this node")
  .action((o: { open?: boolean; resolved?: boolean; node?: string }) =>
    run(() => commentsCommand({ out: out(), open: !!o.open, resolved: !!o.resolved, node: o.node })),
  );

comments
  .command("add <text...>")
  .description("pin a new comment to a node")
  .requiredOption("--node <id>", "node to pin it to")
  .option("--offset <x,y>", "point inside the node, in its own pixels (default: its top-right corner)")
  .option("--author <name>", "who is commenting (default: LAMSA_AUTHOR, the agent, git user.name, the OS user)")
  .action((text: string[], o: { node: string; offset?: string; author?: string }) =>
    run(() => commentAddCommand({ out: out(), node: o.node, text: joinText(text), offset: o.offset, author: o.author })),
  );

comments
  .command("reply <id> <text...>")
  .description("reply to a comment thread")
  .option("--author <name>", "who is replying")
  .action((id: string, text: string[], o: { author?: string }) =>
    run(() => commentReplyCommand({ out: out(), id, text: joinText(text), author: o.author })),
  );

comments
  .command("resolve <id>")
  .description("mark a thread resolved, optionally with a closing reply")
  .option("--reply <text>", "say what you did")
  .option("--author <name>", "who is resolving")
  .action((id: string, o: { reply?: string; author?: string }) =>
    run(() => commentResolveCommand({ out: out(), id, reply: o.reply, author: o.author })),
  );

comments
  .command("reopen <id>")
  .description("reopen a resolved thread")
  .action((id: string) => run(() => commentReopenCommand({ out: out(), id })));

program
  .command("open [file]")
  .description("show a design in the desktop editor (optional; nothing else needs it)")
  .option("--select <ids>", "nodes to select: comma-separated IDs; repeatable", (value: string, previous: string[] = []) => [...previous, ...value.split(",")])
  .addHelpText(
    "after",
    "\nFinds the editor as LAMSA_DESKTOP_BIN, lamsa-desktop on PATH (the Linux .deb), lamsa.app in /Applications\nor ~/Applications, or the newest lamsa AppImage in ~/Applications or ~/.local/bin.\nDownload it from https://github.com/Shunseii/lamsa/releases/latest",
  )
  .action((file: string | undefined, o: { select?: string[] }) => run(() => openCommand({ out: out(), file, select: o.select })));

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
