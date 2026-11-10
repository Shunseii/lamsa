import { existsSync, readFileSync } from "node:fs";
import {
  findProjectRoot,
  fontSetup,
  loadProject,
  loadTokens,
  type FontSetup,
  type Project,
} from "@lamsa/core";
import type { TokenSet } from "@lamsa/schema";
import { CliError, ExitCode } from "./output.js";

export interface Workspace {
  project: Project;
  tokens: TokenSet;
  fonts: FontSetup;
}

export function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  const found = findProjectRoot(process.cwd());
  if (!found) {
    throw new CliError(
      "no lamsa.config.json found in this directory or its parents",
      ExitCode.notFound,
      "run `lamsa init --yes` at the repo root",
    );
  }
  return found;
}

export async function openWorkspace(root?: string): Promise<Workspace> {
  const project = await loadProject(resolveRoot(root));
  let tokens: TokenSet;
  try {
    tokens = await loadTokens(project.root, project.config);
  } catch (error) {
    throw new CliError((error as Error).message, ExitCode.notFound);
  }
  return { project, tokens, fonts: fontSetup(project.config) };
}

export async function readInput(value: string): Promise<unknown> {
  let text = value;
  if (value === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    text = Buffer.concat(chunks).toString("utf8");
  } else if (!value.trimStart().startsWith("{") && !value.trimStart().startsWith("[") && existsSync(value)) {
    text = readFileSync(value, "utf8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(`input is not valid JSON: ${(error as Error).message}`, ExitCode.usage, "pass JSON inline, a file path, or - for stdin");
  }
}
