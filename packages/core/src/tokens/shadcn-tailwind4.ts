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
}

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

function tokenPath(varName: string): { path: string; kind: TokenKind } | undefined {
  const bare = varName.slice(2);
  const dash = bare.indexOf("-");
  if (dash <= 0) return undefined;
  const namespace = bare.slice(0, dash);
  const rest = bare.slice(dash + 1);
  if (!rest || rest.includes("*")) return undefined;
  return { path: `${namespace}.${rest}`, kind: KIND_BY_NAMESPACE[namespace] ?? "other" };
}

function spacingDisplay(base: string, step: number): string {
  const match = /^(\d*\.?\d+)(rem|px)$/.exec(base.trim());
  if (!match) return `calc(${base} * ${step})`;
  const value = Number(match[1]) * step;
  return `${Number(value.toFixed(4))}${match[2]}`;
}

export function parseShadcnTailwind4(css: string, source?: string): TokenSet {
  const root = postcss.parse(css, { from: source });
  const rootDecls: Decl[] = [];
  const darkDecls: Decl[] = [];
  const themeDecls: ThemeDecl[] = [];

  root.walk((node) => {
    if (node.type === "rule") {
      if (isRootSelector(node.selector)) rootDecls.push(...customProps(node.nodes));
      else if (isDarkSelector(node.selector)) darkDecls.push(...customProps(node.nodes));
    } else if (node.type === "atrule" && node.name === "theme") {
      const inline = /\binline\b/.test(node.params);
      for (const decl of customProps(node.nodes)) themeDecls.push({ ...decl, inline });
    }
  });

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
