import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
