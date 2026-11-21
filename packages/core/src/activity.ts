import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, writeFileAtomic } from "./json.js";

/** The agent's latest CLI command, so the desktop editor can show where it is working. Newest entry wins. */
export const ACTIVITY_FILE = ".lamsa/activity.json";

/** Enough to point at; the editor highlights changes from the file diff, not from this list. */
export const MAX_ACTIVITY_IDS = 50;

export type ActivityKind = "read" | "write";

export interface Activity {
  /** Who ran the command: `LAMSA_AGENT_NAME`, else the agent the CLI detects it runs under, else "Agent". */
  agent: string;
  command: string;
  kind: ActivityKind;
  /** Nodes the command looked at or changed, most relevant first. */
  ids: string[];
  /** Repo-relative design file the command worked in, when there was one. */
  file?: string;
  at: string;
}

export function agentName(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.LAMSA_AGENT_NAME?.trim();
  if (named) return named;
  if (env.CLAUDECODE === "1") return "Claude";
  return "Agent";
}

/**
 * Records the command in `.lamsa/activity.json`, but only in a project the editor has used (it creates `.lamsa/`),
 * so plain CLI use, CI and read-only checkouts get no new files. Never throws: activity is a hint, not part of the command.
 */
export async function recordActivity({
  root,
  activity,
  env = process.env,
}: {
  root: string;
  activity: Omit<Activity, "agent" | "at">;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (!existsSync(join(root, ".lamsa"))) return;
  const entry: Activity = {
    ...activity,
    ids: [...new Set(activity.ids)].slice(0, MAX_ACTIVITY_IDS),
    agent: agentName(env),
    at: new Date().toISOString(),
  };
  try {
    await writeFileAtomic(join(root, ACTIVITY_FILE), stableStringify(entry));
  } catch {
    // A read-only .lamsa/ or a full disk must not fail the command itself.
  }
}

export async function readActivity(root: string): Promise<Activity | undefined> {
  const path = join(root, ACTIVITY_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<Activity>;
    if (typeof raw.command !== "string" || (raw.kind !== "read" && raw.kind !== "write") || !Array.isArray(raw.ids)) return undefined;
    return {
      agent: typeof raw.agent === "string" && raw.agent ? raw.agent : "Agent",
      command: raw.command,
      kind: raw.kind,
      ids: raw.ids.filter((id): id is string => typeof id === "string"),
      file: typeof raw.file === "string" ? raw.file : undefined,
      at: typeof raw.at === "string" ? raw.at : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}
