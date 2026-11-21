import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

/** The example project as committed, so local experiments in examples/ don't change test results. */
export function copyExample(dest: string, { openAll = true }: { openAll?: boolean } = {}) {
  const archive = spawnSync("git", ["archive", "HEAD", "examples/shadcn-app"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", dest, "--strip-components=2"], { input: archive.stdout });
  if (archive.status !== 0 || untar.status !== 0) throw new Error(`could not copy the example: ${archive.stderr}${untar.stderr}`);
  // The motion showcase is for people trying the example; the tests' canvas positions and file counts assume the other two files.
  rmSync(join(dest, "designs/motion.lamsa.json"), { force: true });
  if (!openAll) return;
  // Most tests want every file open, as if the user had already answered the first-open prompt.
  const designs = readdirSync(join(dest, "designs")).filter((name) => name.endsWith(".lamsa.json"));
  mkdirSync(join(dest, ".lamsa"), { recursive: true });
  writeFileSync(join(dest, ".lamsa/session.json"), JSON.stringify({ selection: [], open: designs.map((name) => `designs/${name}`) }));
}

export function tempRepo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "lamsa-test-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
  }
  return root;
}

export const GLOBALS_CSS = `
@theme inline {
  --color-primary: var(--primary);
  --color-background: var(--background);
  --radius-md: calc(var(--radius) - 2px);
}
:root { --radius: 0.5rem; --primary: oklch(0.2 0 0); --background: #ffffff; }
.dark { --primary: oklch(0.9 0 0); --background: #000000; }
`;
