import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "@lamsa/cli";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

interface CheckCache {
  checkedAt: number;
  latest?: string;
}

/** `1.2.3` → [1, 2, 3]; a pre-release suffix is ignored, so 1.2.3-rc.1 counts as 1.2.3. */
function parts(version: string): number[] {
  return version.split("-")[0]!.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewer({ latest, current }: { latest: string; current: string }): boolean {
  const [a, b] = [parts(latest), parts(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function updateMessage({ latest, current }: { latest: string; current: string }): string {
  return `lamsa ${latest} is available (you have ${current}). Update with \`npm i -g ${PACKAGE}\`, or bump ${PACKAGE} in your package.json.`;
}

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "lamsa", "update-check.json");
}

function readCache(path: string): CheckCache | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CheckCache;
  } catch {
    return undefined;
  }
}

async function fetchLatest(): Promise<string | undefined> {
  try {
    const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** A source checkout has `src` next to `dist`; the published package ships only `dist`. */
function runningFromSource(): boolean {
  return existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src"));
}

/**
 * Prints a one-line note on stderr when a newer version is on npm. It asks npm at most once a day,
 * and stays quiet for machine-readable output, CI, non-terminal output (agents, pipes) and source checkouts.
 */
export async function noticeUpdate({ current, json }: { current: string; json: boolean }): Promise<void> {
  if (json || process.env.CI || process.env.LAMSA_NO_UPDATE_CHECK || !process.stderr.isTTY || runningFromSource()) return;
  const path = cachePath();
  let cache = readCache(path);
  if (!cache || Date.now() - cache.checkedAt > CHECK_EVERY_MS) {
    cache = { checkedAt: Date.now(), latest: (await fetchLatest()) ?? cache?.latest };
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(cache));
    } catch {
      // A read-only home only means checking again next time.
    }
  }
  if (cache.latest && isNewer({ latest: cache.latest, current })) {
    process.stderr.write(`\n${updateMessage({ latest: cache.latest, current })}\n`);
  }
}
