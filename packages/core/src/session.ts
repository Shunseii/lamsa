import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stableStringify, writeFileAtomic } from "./json.js";

export const SESSION_FILE = ".lamsa/session.json";

export interface Session {
  /** Selected node IDs in the desktop editor, in selection order. */
  selection: string[];
  /** Repo-relative path of the file in focus. */
  file?: string;
  updatedAt: string;
}

export async function readSession(root: string): Promise<Session | undefined> {
  const path = join(root, SESSION_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as Session;
  } catch {
    return undefined;
  }
}

export async function writeSession(root: string, session: Omit<Session, "updatedAt">): Promise<void> {
  await writeFileAtomic(
    join(root, SESSION_FILE),
    stableStringify({ ...session, updatedAt: new Date().toISOString() }),
  );
}
