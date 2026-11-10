import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

/** Deterministic JSON: keys sorted at every level, 2-space indent, trailing newline. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value), null, 2) + "\n";
}

/** Write via temp file + rename so readers (the editor, other agents) never see a partial file. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
}
