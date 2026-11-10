import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { allNodes } from "@lamsa/core";
import type { TokenMode } from "@lamsa/schema";
import { openWorkspace } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";
import { renderFrames } from "../render.js";
import { defaultRenderDir } from "./edit.js";
import { resolveTargets } from "./read.js";

function slug(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function renderCommand({
  out,
  targets,
  outDir,
  scale,
  mode,
}: {
  out: Output;
  targets: string[];
  outDir?: string;
  scale: number;
  mode?: string;
}): Promise<number> {
  if (mode && mode !== "light" && mode !== "dark") throw new CliError(`--mode must be light or dark, not ${mode}`);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 4) throw new CliError("--scale must be between 0 and 4");
  const workspace = await openWorkspace();
  const ids = resolveTargets(workspace.project, targets);
  if (ids.length === 0) throw new CliError("nothing to render", ExitCode.notFound, "add a top-level frame first");
  const nodes = allNodes(workspace.project);
  const dir = outDir ? resolve(outDir) : defaultRenderDir(workspace.project.root);
  mkdirSync(dir, { recursive: true });
  const frames = await renderFrames({
    workspace,
    ids,
    outDir: dir,
    scale,
    mode: mode as TokenMode | undefined,
    naming: (id) => `${[slug(nodes[id]?.name ?? ""), id].filter(Boolean).join("-")}${mode ? `.${mode}` : ""}.png`,
    log: (message) => process.stderr.write(message + "\n"),
  });
  const root = workspace.project.root;
  const shown = frames.map((f) => ({ ...f, path: relative(root, f.path) || f.path }));
  out.result({ ok: true, frames: shown }, () =>
    shown
      .map(
        (f) =>
          `${f.path}  ${f.width}×${f.height} @${scale}x ${f.mode}` +
          (f.missingTokens.length ? `\n  missing tokens: ${f.missingTokens.join(", ")}` : "") +
          (f.missingIcons.length ? `\n  missing icons: ${f.missingIcons.join(", ")}` : ""),
      )
      .join("\n"),
  );
  return ExitCode.ok;
}
