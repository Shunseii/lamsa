import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let iconDir: string | undefined;
let iconNames: Set<string> | undefined;
const cache = new Map<string, string>();

function lucideIconDir(): string {
  if (iconDir) return iconDir;
  const pkg = require.resolve("lucide-static/package.json");
  iconDir = join(dirname(pkg), "icons");
  return iconDir;
}

export function lucideIconNames(): Set<string> {
  if (iconNames) return iconNames;
  iconNames = new Set(
    readdirSync(lucideIconDir())
      .filter((file) => file.endsWith(".svg"))
      .map((file) => file.slice(0, -4)),
  );
  return iconNames;
}

/** SVG markup for a lucide icon by kebab-case name, or undefined if unknown. */
export function lucideIconSvg(name: string): string | undefined {
  if (!/^[a-z0-9-]+$/.test(name)) return undefined;
  const cached = cache.get(name);
  if (cached) return cached;
  const path = join(lucideIconDir(), `${name}.svg`);
  if (!existsSync(path)) return undefined;
  const svg = readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  cache.set(name, svg);
  return svg;
}
