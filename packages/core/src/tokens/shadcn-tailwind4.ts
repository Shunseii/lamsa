import type { Token, TokenKind, TokenSet } from "@lamsa/schema";
import postcss from "postcss";

const SPACING_STEPS = [
  0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44,
  48, 52, 56, 60, 64, 72, 80, 96,
];

const KIND_BY_NAMESPACE: Record<string, TokenKind> = {
  color: "color",
  radius: "radius",
  font: "font",
  spacing: "spacing",
  shadow: "shadow",
  text: "text",
};

interface Decl {
  name: string;
  value: string;
}

interface ThemeDecl extends Decl {
  inline: boolean;
  builtin?: boolean;
}

/** Tailwind namespaces whose built-in values become tokens. Others (animations, breakpoints, …) don't map to a style value. */
const BUILTIN_NAMESPACES = new Set([
  "color", "font", "font-weight", "text", "tracking", "leading", "radius",
  "shadow", "inset-shadow", "drop-shadow", "blur", "ease", "container",
]);

const MULTI_WORD_NAMESPACES = ["font-weight", "inset-shadow", "drop-shadow", "text-shadow"];

function isRootSelector(selector: string): boolean {
  return selector.split(",").some((part) => part.trim() === ":root");
}

function isDarkSelector(selector: string): boolean {
  return selector.split(",").some((part) => {
    const s = part.trim();
    return s === ".dark" || s === ":root.dark" || s === "html.dark";
  });
}

function customProps(nodes: postcss.ChildNode[] | undefined): Decl[] {
  const result: Decl[] = [];
  for (const node of nodes ?? []) {
    if (node.type === "decl" && node.prop.startsWith("--")) {
      result.push({ name: node.prop, value: node.value.trim() });
    }
  }
  return result;
}

function substituteVars(value: string, scope: Map<string, string>, depth = 0): string {
  if (depth > 8) return value;
  const replaced = value.replace(
    /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
    (whole, name: string, fallback?: string) => scope.get(name) ?? fallback?.trim() ?? whole,
  );
  return replaced === value ? value : substituteVars(replaced, scope, depth + 1);
}

function tokenPath(varName: string): { path: string; namespace: string; kind: TokenKind } | undefined {
  const bare = varName.slice(2);
  const multi = MULTI_WORD_NAMESPACES.find((ns) => bare.startsWith(`${ns}-`));
  const dash = multi ? multi.length : bare.indexOf("-");
  if (dash <= 0) return undefined;
  const namespace = bare.slice(0, dash);
  const rest = bare.slice(dash + 1);
  if (!rest || rest.includes("*") || rest.includes("--")) return undefined;
  return { path: `${namespace}.${rest}`, namespace, kind: KIND_BY_NAMESPACE[namespace] ?? "other" };
}

/** `--color-*: initial` clears a namespace of Tailwind's defaults; `--*: initial` clears them all. */
function resetNamespaces(decls: ThemeDecl[]): { all: boolean; namespaces: Set<string> } {
  const namespaces = new Set<string>();
  let all = false;
  for (const decl of decls) {
    if (decl.value !== "initial") continue;
    if (decl.name === "--*") all = true;
    else if (decl.name.endsWith("-*")) namespaces.add(decl.name.slice(2, -2));
  }
  return { all, namespaces };
}

function themeDeclsOf(css: string, source?: string): { rootDecls: Decl[]; darkDecls: Decl[]; themeDecls: ThemeDecl[] } {
  const root = postcss.parse(css, { from: source });
  const rootDecls: Decl[] = [];
  const darkDecls: Decl[] = [];
  const themeDecls: ThemeDecl[] = [];
  root.walk((node) => {
    if (node.type === "rule") {
      if (isRootSelector(node.selector)) rootDecls.push(...customProps(node.nodes));
      else if (isDarkSelector(node.selector)) darkDecls.push(...customProps(node.nodes));
    } else if (node.type === "atrule" && node.name === "theme" && !/\breference\b/.test(node.params)) {
      const inline = /\binline\b/.test(node.params);
      for (const decl of customProps(node.nodes)) themeDecls.push({ ...decl, inline });
    }
  });
  return { rootDecls, darkDecls, themeDecls };
}

/** Tailwind's own theme (`tailwindcss/theme.css`), minus namespaces the project resets. */
function builtinDecls(defaultsCss: string, projectTheme: ThemeDecl[]): ThemeDecl[] {
  const reset = resetNamespaces(projectTheme);
  if (reset.all) return [];
  const overridden = new Set(projectTheme.map((d) => d.name));
  return themeDeclsOf(defaultsCss).themeDecls.filter((decl) => {
    if (overridden.has(decl.name)) return false;
    const located = tokenPath(decl.name);
    return !!located && BUILTIN_NAMESPACES.has(located.namespace) && !reset.namespaces.has(located.namespace);
  }).map((decl) => ({ ...decl, inline: false, builtin: true }));
}

function spacingDisplay(base: string, step: number): string {
  const match = /^(\d*\.?\d+)(rem|px)$/.exec(base.trim());
  if (!match) return `calc(${base} * ${step})`;
  const value = Number(match[1]) * step;
  return `${Number(value.toFixed(4))}${match[2]}`;
}

/**
 * Reads a shadcn + Tailwind v4 stylesheet. With `defaults` (the text of `tailwindcss/theme.css`),
 * Tailwind's built-in scales (palette, text sizes, radii, shadows, …) become tokens too, marked `builtin`.
 */
export function parseShadcnTailwind4(css: string, options: { source?: string; defaults?: string } = {}): TokenSet {
  const { source, defaults } = options;
  const parsed = themeDeclsOf(css, source);
  const { rootDecls, darkDecls } = parsed;
  const projectTheme = parsed.themeDecls.filter((d) => d.value !== "initial");
  const themeDecls = [...(defaults ? builtinDecls(defaults, parsed.themeDecls) : []), ...projectTheme];

  const lightScope = new Map<string, string>();
  for (const decl of rootDecls) lightScope.set(decl.name, decl.value);
  for (const decl of themeDecls) if (!decl.inline) lightScope.set(decl.name, decl.value);
  const darkScope = new Map(lightScope);
  for (const decl of darkDecls) darkScope.set(decl.name, decl.value);

  const tokens: Record<string, Token> = {};
  for (const decl of themeDecls) {
    const located = tokenPath(decl.name);
    if (!located) continue;
    const light = substituteVars(decl.value, lightScope);
    const dark = substituteVars(decl.value, darkScope);
    tokens[located.path] = {
      path: located.path,
      css: decl.inline ? decl.value : `var(${decl.name})`,
      kind: located.kind,
      values: dark === light ? { light } : { light, dark },
      ...(decl.builtin ? { builtin: true } : {}),
    };
  }

  const spacingBase = lightScope.get("--spacing") ?? "0.25rem";
  for (const step of SPACING_STEPS) {
    const path = `spacing.${step}`;
    if (tokens[path]) continue;
    tokens[path] = {
      path,
      css: step === 0 ? "0px" : `calc(var(--spacing) * ${step})`,
      kind: "spacing",
      values: { light: step === 0 ? "0px" : spacingDisplay(spacingBase, step) },
    };
  }

  const rootBlock = [
    ...rootDecls,
    ...themeDecls.filter((decl) => !decl.inline),
    ...(lightScope.has("--spacing") ? [] : [{ name: "--spacing", value: "0.25rem" }]),
  ];
  const block = (selector: string, decls: Decl[]) =>
    decls.length === 0
      ? ""
      : `${selector} {\n${decls.map((d) => `  ${d.name}: ${d.value};`).join("\n")}\n}\n`;

  return {
    adapter: "shadcn-tailwind4",
    source,
    tokens,
    css: block(":root", rootBlock) + block(".dark", darkDecls),
  };
}
