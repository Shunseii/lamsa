import postcss, { type Root, type Rule } from "postcss";

/**
 * Page transitions are plain CSS in a file's `css`: `::view-transition-*` rules and their `@keyframes`.
 * This module reads and edits the small subset the editor shows as controls, one declaration at a time,
 * and leaves every other rule alone.
 */

/** `root` (the whole page), a `view-transition-name`, or `*.class` for a `view-transition-class`. */
export type TransitionTarget = string;
export type TransitionPart = "group" | "old" | "new";
export type TransitionDirection = "any" | "forward" | "back";

export interface TransitionTiming {
  duration?: string;
  easing?: string;
}

export type PagePreset = "fade" | "slide" | "none" | "custom";

export const PAGE_PRESETS: { value: Exclude<PagePreset, "custom">; label: string }[] = [
  { value: "fade", label: "Cross-fade" },
  { value: "slide", label: "Slide" },
  { value: "none", label: "None" },
];

const SLIDE_FORWARD = "lamsa-slide-from-right";
const SLIDE_BACK = "lamsa-slide-from-left";
const SLIDE_KEYFRAMES: Record<string, string> = {
  [SLIDE_FORWARD]: "from {\n  opacity: 0;\n  translate: 32px 0;\n}",
  [SLIDE_BACK]: "from {\n  opacity: 0;\n  translate: -32px 0;\n}",
};

const SELECTOR =
  /^(?:(?:html|:root)?:active-view-transition-type\(\s*(forward|back)\s*\))?::view-transition-(group|old|new)\(\s*(\*\.[\w-]+|[\w-]+)\s*\)$/;

interface Parsed {
  rule: Rule;
  target: string;
  part: TransitionPart;
  direction: TransitionDirection;
}

function parse(css: string): Root | null {
  try {
    return postcss.parse(css);
  } catch {
    return null;
  }
}

function recognised(root: Root): Parsed[] {
  const found: Parsed[] = [];
  root.each((node) => {
    if (node.type !== "rule" || node.selectors.length !== 1) return;
    const match = SELECTOR.exec(node.selector.trim());
    if (!match) return;
    found.push({ rule: node, direction: (match[1] as TransitionDirection | undefined) ?? "any", part: match[2] as TransitionPart, target: match[3]! });
  });
  return found;
}

const selectorFor = ({ target, part, direction }: { target: string; part: TransitionPart; direction: TransitionDirection }) =>
  `${direction === "any" ? "" : `:active-view-transition-type(${direction})`}::view-transition-${part}(${target})`;

const declValue = (rule: Rule, property: string) => {
  let value: string | undefined;
  rule.walkDecls(property, (decl) => {
    value = decl.value;
  });
  return value;
};

/** The duration and curve set on a target's group, which its old and new snapshots inherit. */
export function transitionTiming(css: string, target: TransitionTarget): TransitionTiming {
  const root = parse(css);
  const group = root && recognised(root).find((r) => r.target === target && r.part === "group" && r.direction === "any");
  if (!group) return {};
  return { duration: declValue(group.rule, "animation-duration"), easing: declValue(group.rule, "animation-timing-function") };
}

/** Sets (or, with an empty value, removes) one declaration on one transition rule, creating the rule if needed. */
export function setTransitionDeclaration(
  css: string,
  { target, part, direction, property, value }: { target: TransitionTarget; part: TransitionPart; direction: TransitionDirection; property: string; value: string },
): string {
  const root = parse(css);
  if (!root) return css;
  let rule = recognised(root).find((r) => r.target === target && r.part === part && r.direction === direction)?.rule;
  if (!rule) {
    if (!value.trim()) return css;
    rule = postcss.rule({ selector: selectorFor({ target, part, direction }) });
    root.append(rule);
  }
  const existing: postcss.Declaration[] = [];
  rule.walkDecls(property, (decl) => {
    existing.push(decl);
  });
  if (!value.trim()) {
    for (const decl of existing) decl.remove();
  } else if (existing.length) {
    for (const decl of existing.slice(0, -1)) decl.remove();
    existing.at(-1)!.value = value.trim();
  } else rule.append({ prop: property, value: value.trim() });
  if (!rule.nodes.length) rule.remove();
  return tidy(root);
}

/** Which page preset the root rules describe; anything hand-written is `custom`. */
export function pagePreset(css: string): PagePreset {
  const root = parse(css);
  if (!root) return "custom";
  const pageRules = recognised(root).filter((r) => r.target === "root" && r.part !== "group");
  if (!pageRules.length) return "fade";
  const only = (r: Parsed) => r.rule.nodes.length === 1 && r.rule.nodes[0]!.type === "decl" && r.rule.nodes[0]!.prop === "animation-name";
  if (!pageRules.every(only)) return "custom";
  const names = new Map(pageRules.map((r) => [`${r.direction} ${r.part}`, declValue(r.rule, "animation-name")]));
  if (names.size === 2 && names.get("any old") === "none" && names.get("any new") === "none") return "none";
  if (names.size === 2 && names.get("forward new") === SLIDE_FORWARD && names.get("back new") === SLIDE_BACK) return "slide";
  return "custom";
}

/** Replaces the page's old/new rules with a preset's; the group's timing is kept. */
export function setPagePreset(css: string, preset: Exclude<PagePreset, "custom">): string {
  const root = parse(css);
  if (!root) return css;
  for (const r of recognised(root)) if (r.target === "root" && r.part !== "group") r.rule.remove();
  const add = (part: TransitionPart, direction: TransitionDirection, name: string) =>
    root.append(postcss.rule({ selector: selectorFor({ target: "root", part, direction }) }).append({ prop: "animation-name", value: name }));
  if (preset === "none") {
    add("old", "any", "none");
    add("new", "any", "none");
  } else if (preset === "slide") {
    add("new", "forward", SLIDE_FORWARD);
    add("new", "back", SLIDE_BACK);
    const defined = new Set<string>();
    root.walkAtRules("keyframes", (at) => {
      defined.add(at.params.trim());
    });
    for (const [name, body] of Object.entries(SLIDE_KEYFRAMES)) {
      if (!defined.has(name)) root.append(postcss.parse(`@keyframes ${name} {\n${body}\n}`).first!);
    }
  }
  return tidy(root);
}

/** Every transition name and class a node's CSS gives it, as targets (`name` or `*.class`). */
export function transitionTargetsIn(css: string | undefined): TransitionTarget[] {
  if (!css) return [];
  const targets: string[] = [];
  for (const match of css.matchAll(/view-transition-(name|class)\s*:\s*([\w-]+(?:\s+[\w-]+)*)\s*[;}]?/g)) {
    for (const value of match[2]!.split(/\s+/)) {
      if (value === "none" || value === "auto" || value === "match-element") continue;
      targets.push(match[1] === "class" ? `*.${value}` : value);
    }
  }
  return [...new Set(targets)];
}

/** Gives a node's CSS a `view-transition-name` (or `-class` for `*.x` targets), replacing any it had. */
export function withTransitionTarget(css: string | undefined, target: TransitionTarget): string {
  const property = target.startsWith("*.") ? "view-transition-class" : "view-transition-name";
  const value = target.replace(/^\*\./, "");
  const pattern = new RegExp(`(^|[;{\\s])${property}\\s*:[^;}]*;?`, "m");
  const current = css ?? "";
  if (pattern.test(current)) return current.replace(pattern, `$1${property}: ${value};`);
  return `${property}: ${value};${current.trim() ? `\n${current.trim()}` : ""}`.trim();
}

/** New rules get the usual layout; existing ones keep theirs. The desktop app formats file CSS on save like `lamsa fmt`. */
function tidy(root: Root): string {
  root.each((node) => {
    if (node.raws.before === undefined || node.raws.before === "") node.raws.before = root.first === node ? "" : "\n\n";
  });
  return root.toString().trim();
}
