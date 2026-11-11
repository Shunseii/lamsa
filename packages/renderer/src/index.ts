import {
  resolveTokenRefs,
  type DesignNode,
  type InstanceNode,
  type NodePatch,
  type Style,
  type TokenMode,
  type TokenSet,
} from "@lamsa/schema";

export interface RenderElement {
  tag: "div" | "img";
  /** Design node ID; instance internals are `<instanceId>/<innerId>`. */
  nodeId: string;
  nodeType: DesignNode["type"];
  className?: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: RenderElement[];
  text?: string;
  /** Trusted markup (bundled icon SVG). */
  html?: string;
}

export interface RenderOptions {
  nodes: Record<string, DesignNode>;
  rootId: string;
  tokens: TokenSet;
  /** Forces a mode (export flag); otherwise the frame's own mode applies. */
  mode?: TokenMode;
  /** Mode of the surrounding canvas, used when the frame sets none. */
  canvasMode?: TokenMode;
  iconSvg: (name: string) => string | undefined;
  assetUrl?: (src: string) => string;
  /** When the root is a main component, render it with these prop values instead of its defaults. */
  componentProps?: Record<string, string | boolean>;
}

export interface RenderResult {
  root: RenderElement;
  mode: TokenMode;
  missingTokens: string[];
  missingIcons: string[];
}

const UNITLESS = new Set([
  "opacity",
  "z-index",
  "flex",
  "flex-grow",
  "flex-shrink",
  "font-weight",
  "line-height",
  "order",
  "zoom",
  "aspect-ratio",
  "grid-row",
  "grid-column",
  "grid-row-start",
  "grid-row-end",
  "grid-column-start",
  "grid-column-end",
  "orphans",
  "widows",
  "tab-size",
  "fill-opacity",
  "stroke-opacity",
  "column-count",
  "scale",
]);

const ICON_DEFAULT_SIZE = 24;

interface Context {
  options: RenderOptions;
  missingTokens: Set<string>;
  missingIcons: Set<string>;
  children: Map<string, string[]>;
  depth: number;
}

function childMap(nodes: Record<string, DesignNode>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === undefined) continue;
    const list = map.get(node.parentId) ?? [];
    list.push(id);
    map.set(node.parentId, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const ia = nodes[a]?.index ?? "";
      const ib = nodes[b]?.index ?? "";
      return ia < ib ? -1 : ia > ib ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  }
  return map;
}

export function cssValue(property: string, value: string | number): string {
  if (typeof value === "number") {
    return UNITLESS.has(property) || property.startsWith("--") || value === 0 ? String(value) : `${value}px`;
  }
  return value;
}

function resolveStyle(style: Style | undefined, context: Context): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [property, value] of Object.entries(style ?? {})) {
    const raw = cssValue(property, value);
    const { css, missing } = resolveTokenRefs(raw, context.options.tokens.tokens);
    for (const path of missing) context.missingTokens.add(path);
    result[property] = css;
  }
  return result;
}

function mergePatch(into: Map<string, NodePatch>, patches: Record<string, NodePatch> | undefined) {
  for (const [id, patch] of Object.entries(patches ?? {})) {
    const current = into.get(id) ?? {};
    into.set(id, { ...current, ...patch, style: { ...current.style, ...patch.style } });
  }
}

export function instancePatches(instance: InstanceNode, component: DesignNode): Map<string, NodePatch> {
  const patches = new Map<string, NodePatch>();
  if (component.type !== "frame" || !component.component) return patches;
  for (const [name, def] of Object.entries(component.component.props ?? {})) {
    const given = instance.props?.[name];
    if (def.type === "enum") {
      const value = typeof given === "string" ? given : def.default;
      mergePatch(patches, def.overrides?.[value]);
    } else if (def.type === "boolean") {
      const value = typeof given === "boolean" ? given : def.default;
      mergePatch(patches, value ? def.overrides?.true : def.overrides?.false);
    } else {
      const value = typeof given === "string" ? given : def.default;
      mergePatch(patches, { [def.target]: { content: value } });
    }
  }
  mergePatch(patches, instance.overrides);
  return patches;
}

export function applyPatch(node: DesignNode, patch: NodePatch | undefined): DesignNode {
  if (!patch) return node;
  const next = { ...node, style: { ...node.style, ...patch.style } } as DesignNode;
  if (patch.hidden !== undefined) next.hidden = patch.hidden;
  if (patch.content !== undefined && next.type === "text") next.content = patch.content;
  if (patch.src !== undefined && next.type === "image") next.src = patch.src;
  if (patch.icon !== undefined && next.type === "icon") next.icon = patch.icon;
  return next;
}

function renderNode({
  id,
  displayId,
  node,
  context,
  patches,
  isRoot,
}: {
  id: string;
  displayId: string;
  node: DesignNode;
  context: Context;
  patches?: Map<string, NodePatch>;
  isRoot: boolean;
}): RenderElement {
  const { nodes } = context.options;
  const style = resolveStyle(node.style, context);
  if (node.hidden) style.display = "none";
  const base = { nodeId: displayId, nodeType: node.type, attrs: { "data-node-id": displayId } };

  if (isRoot) {
    style.position ??= "relative";
    style.overflow ??= "hidden";
  }

  if (node.type === "instance") {
    const component = nodes[node.componentId];
    if (!component || context.depth > 32) {
      return { ...base, tag: "div", style: { ...style, outline: "2px dashed #e5484d" }, children: [], text: `missing component ${node.componentId}` };
    }
    const own = instancePatches(node, component);
    const rootPatch = own.get(node.componentId);
    const merged: DesignNode = {
      ...applyPatch(component, rootPatch),
      style: { ...component.style, ...rootPatch?.style, ...node.style },
      hidden: node.hidden ?? component.hidden,
    } as DesignNode;
    context.depth++;
    const element = renderFrameLike({
      id: node.componentId,
      displayId,
      node: merged,
      context,
      patches: own,
      prefix: displayId,
      isRoot,
      nodeType: "instance",
    });
    context.depth--;
    return element;
  }

  if (node.type === "frame") {
    return renderFrameLike({ id, displayId, node, context, patches, prefix: undefined, isRoot, nodeType: "frame" });
  }

  if (node.type === "text") {
    style["white-space"] ??= "pre-wrap";
    return { ...base, tag: "div", style, children: [], text: node.content };
  }

  if (node.type === "image") {
    const src = context.options.assetUrl ? context.options.assetUrl(node.src) : node.src;
    return { ...base, tag: "img", style, attrs: { ...base.attrs, src, alt: node.alt ?? "" }, children: [] };
  }

  const svg = context.options.iconSvg(node.icon);
  if (!svg) context.missingIcons.add(node.icon);
  style.width ??= `${ICON_DEFAULT_SIZE}px`;
  style.height ??= `${ICON_DEFAULT_SIZE}px`;
  style["flex-shrink"] ??= "0";
  return {
    ...base,
    tag: "div",
    className: "lamsa-icon",
    style,
    children: [],
    html: svg ?? "",
  };
}

function renderFrameLike({
  id,
  displayId,
  node,
  context,
  patches,
  prefix,
  isRoot,
  nodeType,
}: {
  id: string;
  displayId: string;
  node: DesignNode;
  context: Context;
  patches?: Map<string, NodePatch>;
  prefix: string | undefined;
  isRoot: boolean;
  nodeType: DesignNode["type"];
}): RenderElement {
  const { nodes } = context.options;
  const style = resolveStyle(node.style, context);
  if (node.hidden) style.display = "none";
  if (isRoot) {
    style.position ??= "relative";
    style.overflow ??= "hidden";
  }
  const mode = node.type === "frame" ? node.mode : undefined;
  const children = (context.children.get(id) ?? []).map((childId) => {
    const child = nodes[childId]!;
    const childDisplayId = prefix ? `${prefix}/${childId}` : childId;
    const patched = applyPatch(child, patches?.get(childId));
    if (patched.type === "instance") {
      return renderNode({ id: childId, displayId: childDisplayId, node: patched, context, isRoot: false });
    }
    if (patched.type === "frame") {
      return renderFrameLike({
        id: childId,
        displayId: childDisplayId,
        node: patched,
        context,
        patches,
        prefix,
        isRoot: false,
        nodeType: "frame",
      });
    }
    return renderNode({ id: childId, displayId: childDisplayId, node: patched, context, patches, isRoot: false });
  });
  return {
    tag: "div",
    nodeId: displayId,
    nodeType,
    className: mode,
    style,
    attrs: { "data-node-id": displayId },
    children,
  };
}

export function buildRenderTree(options: RenderOptions): RenderResult {
  const node = options.nodes[options.rootId];
  if (!node) throw new Error(`node ${options.rootId} not found`);
  const context: Context = {
    options,
    missingTokens: new Set(),
    missingIcons: new Set(),
    children: childMap(options.nodes),
    depth: 0,
  };
  let root: RenderElement;
  if (node.type === "frame" && node.component) {
    const defaults = instancePatches({ type: "instance", componentId: options.rootId, props: options.componentProps }, node);
    const own = applyPatch(node, defaults.get(options.rootId));
    root = renderFrameLike({
      id: options.rootId,
      displayId: options.rootId,
      node: own,
      context,
      patches: defaults,
      prefix: undefined,
      isRoot: true,
      nodeType: "frame",
    });
  } else {
    root = renderNode({ id: options.rootId, displayId: options.rootId, node, context, isRoot: true });
  }
  const frameMode = node.type === "frame" ? node.mode : undefined;
  const mode = options.mode ?? frameMode ?? options.canvasMode ?? "light";
  if (options.mode) root.className = options.mode;
  return {
    root,
    mode,
    missingTokens: [...context.missingTokens],
    missingIcons: [...context.missingIcons],
  };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
}

export function styleString(style: Record<string, string>): string {
  return Object.entries(style)
    .map(([property, value]) => `${property}: ${value}`)
    .join("; ");
}

export function toHtml(element: RenderElement): string {
  const attrs = { ...element.attrs };
  if (element.className) attrs.class = element.className;
  const styleText = styleString(element.style);
  if (styleText) attrs.style = styleText;
  const attrText = Object.entries(attrs)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  if (element.tag === "img") return `<img${attrText}>`;
  const inner =
    element.html ?? (element.text !== undefined ? escapeHtml(element.text) : element.children.map(toHtml).join(""));
  return `<div${attrText}>${inner}</div>`;
}

/** Base styles every render uses, in the editor and in exports. */
export function baseCss(tokens: TokenSet): string {
  const font = tokens.tokens["font.sans"]?.css ?? "ui-sans-serif, system-ui, sans-serif";
  const color = tokens.tokens["color.foreground"]?.css ?? "#0a0a0a";
  return `*, ::before, ::after { box-sizing: border-box; margin: 0; padding: 0; border: 0 solid; }
img, svg { display: block; max-width: 100%; }
.lamsa-surface { font-family: ${font}; color: ${color}; line-height: 1.5; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
.lamsa-icon > svg { width: 100%; height: 100%; }
`;
}

export function renderDocument({
  result,
  tokens,
  fontCss = "",
  fontLinks = [],
  baseHref,
}: {
  result: RenderResult;
  tokens: TokenSet;
  fontCss?: string;
  fontLinks?: string[];
  baseHref?: string;
}): string {
  const links = fontLinks.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join("\n");
  const base = baseHref ? `<base href="${escapeHtml(baseHref)}">` : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${base}
${links}
<style>
${baseCss(tokens)}
${tokens.css}
${fontCss}
html, body { background: transparent; }
</style>
</head>
<body>
<div id="lamsa-render" class="lamsa-surface ${result.mode}" style="display: inline-block">${toHtml(result.root)}</div>
</body>
</html>
`;
}
