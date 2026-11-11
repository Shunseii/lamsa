import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { emptyTokenSet, type LamsaConfig, type TokenSet } from "@lamsa/schema";
import { parseShadcnTailwind4 } from "./shadcn-tailwind4.js";

export { parseShadcnTailwind4 };

export const GLOBALS_CSS_CANDIDATES = [
  "app/globals.css",
  "src/app/globals.css",
  "src/styles/globals.css",
  "styles/globals.css",
  "src/index.css",
  "src/globals.css",
  "app/app.css",
];

export function detectTokenSource(root: string): string | undefined {
  return GLOBALS_CSS_CANDIDATES.find((candidate) => existsSync(join(root, candidate)));
}

export class TokenSourceError extends Error {}

export async function loadTokens(root: string, config: LamsaConfig): Promise<TokenSet> {
  if (config.tokens.adapter === "none") return emptyTokenSet;
  const source = config.tokens.path ?? detectTokenSource(root);
  if (!source) {
    throw new TokenSourceError(
      `no token source found for adapter ${config.tokens.adapter}; set "tokens.path" in lamsa.config.json`,
    );
  }
  const path = join(root, source);
  if (!existsSync(path)) {
    throw new TokenSourceError(`token source ${source} does not exist; fix "tokens.path" in lamsa.config.json`);
  }
  const css = await readFile(path, "utf8");
  const themePath = importsTailwind(css) ? tailwindThemePath(root) : undefined;
  const defaults = themePath ? await readFile(themePath, "utf8") : undefined;
  return parseShadcnTailwind4(css, { source, defaults });
}

function importsTailwind(css: string): boolean {
  return /@import\s+(?:url\()?["']tailwindcss(?:\/theme(?:\.css)?)?["']/.test(css);
}

/** The project's own `tailwindcss/theme.css` when installed, so tokens match its Tailwind version; else lamsa's copy. */
function tailwindThemePath(root: string): string | undefined {
  for (const from of [join(root, "package.json"), import.meta.url]) {
    try {
      return createRequire(from).resolve("tailwindcss/theme.css");
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface FontSetup {
  css: string;
  links: string[];
}

/** Fonts the token adapter can't locate (e.g. `next/font`), mapped in config. */
export function fontSetup(config: LamsaConfig): FontSetup {
  const rootVars: string[] = [];
  const faces: string[] = [];
  const links: string[] = [];
  for (const [key, spec] of Object.entries(config.fonts)) {
    const family = key.startsWith("--")
      ? "google" in spec
        ? spec.google.split(":")[0]!
        : key.slice(2)
      : key;
    if ("google" in spec) {
      const [name, axes] = spec.google.split(":");
      const familyParam = `${encodeURIComponent(name!).replace(/%20/g, "+")}:${axes ?? "wght@100..900"}`;
      links.push(`https://fonts.googleapis.com/css2?family=${familyParam}&display=block`);
    } else {
      for (const file of spec.files) {
        faces.push(`@font-face { font-family: "${family}"; src: url("${file}"); font-display: block; }`);
      }
    }
    if (key.startsWith("--")) rootVars.push(`  ${key}: "${family}";`);
  }
  const rootBlock = rootVars.length > 0 ? `:root {\n${rootVars.join("\n")}\n}\n` : "";
  return { css: faces.join("\n") + (faces.length ? "\n" : "") + rootBlock, links };
}
