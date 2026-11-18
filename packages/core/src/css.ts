import postcss from "postcss";

type CssNode = postcss.ChildNode;

/** Node CSS is a rule body (declarations and nested rules), so it's parsed inside a wrapper rule. */
const WRAPPER = "__lamsa__";

export interface CssProblem {
  message: string;
  line?: number;
}

/** Token references like `{color.primary}` would read as blocks, so they're swapped for a function call while parsing. */
const TOKEN_REF = /\{([A-Za-z0-9_][A-Za-z0-9_.\-]*)\}/g;
const protect = (css: string) => css.replace(TOKEN_REF, "lamsa-token($1)");
const unprotect = (css: string) => css.replace(/lamsa-token\(([A-Za-z0-9_.\-]+)\)/g, "{$1}");

function parseBody(css: string): postcss.Rule {
  const root = postcss.parse(`${WRAPPER}{${protect(css)}\n}`);
  return root.first as postcss.Rule;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Splits a value on commas that aren't inside parentheses. */
function topLevelList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  parts.push(current.trim());
  return parts;
}

/** A long comma list (several transitions, shadows, animations) goes one item per line. */
function printValue(prop: string, value: string, indent: string): string {
  const list = topLevelList(oneLine(value));
  if (list.length < 2 || prop.length + value.length < 60) return ` ${oneLine(value)}`;
  return `\n${list.map((item) => `${indent}  ${item}`).join(",\n")}`;
}

function print(nodes: CssNode[] | undefined, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (nodes ?? []).forEach((node, i) => {
    const block = node.type === "rule" || (node.type === "atrule" && node.nodes);
    if (block && i > 0) lines.push("");
    if (node.type === "decl") {
      lines.push(`${indent}${node.prop}:${printValue(node.prop, node.value, indent)}${node.important ? " !important" : ""};`);
    } else if (node.type === "comment") {
      lines.push(`${indent}/* ${node.text.trim()} */`);
    } else if (node.type === "rule") {
      lines.push(`${indent}${oneLine(node.selector).replace(/\s*,\s*/g, ", ")} {`, print(node.nodes, depth + 1), `${indent}}`);
    } else if (node.type === "atrule") {
      const head = `${indent}@${node.name}${node.params ? ` ${oneLine(node.params)}` : ""}`;
      if (node.nodes) lines.push(`${head} {`, print(node.nodes, depth + 1), `${indent}}`);
      else lines.push(`${head};`);
    }
  });
  return lines.filter((line, i, all) => !(line === "" && all[i + 1] === undefined)).join("\n");
}

function errorProblem(error: unknown): CssProblem {
  if (error instanceof postcss.CssSyntaxError) return { message: error.reason, line: error.line };
  return { message: String(error) };
}

/** Formats a node's CSS: one declaration per line, nested rules indented. Unparseable CSS comes back unchanged. */
export function formatNodeCss(css: string): string {
  try {
    return unprotect(print(parseBody(css).nodes, 0));
  } catch {
    return css;
  }
}

/** Formats file-level CSS (`@keyframes` blocks). Unparseable CSS comes back unchanged. */
export function formatFileCss(css: string): string {
  try {
    return unprotect(print(postcss.parse(protect(css)).nodes, 0));
  } catch {
    return css;
  }
}

/** Names of the `@keyframes` defined in a stylesheet. */
export function keyframeNames(css: string): string[] {
  const names: string[] = [];
  try {
    postcss.parse(css).walkAtRules("keyframes", (rule) => {
      names.push(rule.params.trim());
    });
  } catch {
    // reported by checkFileCss
  }
  return names;
}

const ANIMATION_KEYWORDS = new Set([
  "none", "infinite", "normal", "reverse", "alternate", "alternate-reverse", "forwards", "backwards", "both",
  "running", "paused", "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
  "initial", "inherit", "unset", "revert", "revert-layer", "auto",
]);

function namesInAnimation(value: string): string[] {
  if (/var\(/.test(value)) return [];
  const withoutFunctions = value.replace(/[a-z-]+\([^()]*\)/gi, " ");
  return withoutFunctions
    .split(",")
    .flatMap((part) => part.trim().split(/\s+/))
    .filter((word) => word && !ANIMATION_KEYWORDS.has(word) && !/^-?[\d.]/.test(word));
}

/** Keyframe names a node's CSS uses in `animation` / `animation-name`. */
export function animationNamesUsed(css: string): string[] {
  const names = new Set<string>();
  try {
    parseBody(css).walkDecls(/^animation(-name)?$/, (decl) => {
      for (const name of namesInAnimation(decl.value)) names.add(name);
    });
  } catch {
    // reported by checkNodeCss
  }
  return [...names];
}

/** `data-state` values a node's CSS styles, e.g. `&[data-state="open"]` gives `open`. */
export function cssStateNames(css: string): string[] {
  return [...new Set([...css.matchAll(/&\[data-state\s*=\s*["']?([\w-]+)["']?\s*\]/g)].map((m) => m[1]!))];
}

export function checkNodeCss(css: string): CssProblem[] {
  let body: postcss.Rule;
  try {
    body = parseBody(css);
  } catch (error) {
    return [errorProblem(error)];
  }
  const problems: CssProblem[] = [];
  body.walkAtRules("keyframes", (rule) => {
    problems.push({ message: `@keyframes ${rule.params} can't be nested in a node; put it in the file's "css"`, line: rule.source?.start?.line });
  });
  return problems;
}

/** Page-transition rules (`::view-transition-old(card)`, `:active-view-transition-type(back) …`) style the whole document, so they live in file CSS. */
function isViewTransitionRule(rule: postcss.Rule): boolean {
  return rule.selectors.every((selector) => /view-transition/.test(selector));
}

export function checkFileCss(css: string): CssProblem[] {
  let root: postcss.Root;
  try {
    root = postcss.parse(protect(css));
  } catch (error) {
    return [errorProblem(error)];
  }
  const problems: CssProblem[] = [];
  for (const node of root.nodes) {
    if (node.type === "rule" && !isViewTransitionRule(node)) {
      problems.push({
        message: `"${oneLine(node.selector)}" is a style rule; file CSS is for @keyframes and ::view-transition-* rules, so put styles in the node's "css"`,
        line: node.source?.start?.line,
      });
    } else if (node.type === "decl") {
      problems.push({ message: `declaration "${node.prop}" outside a rule`, line: node.source?.start?.line });
    }
  }
  return problems;
}
