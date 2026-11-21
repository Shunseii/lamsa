import { baseCss, buildRenderTree, settleAnimations, toHtml, withoutPointerStates } from "@lamsa/renderer";
import type { DesignNode, TokenMode, TokenSet } from "@lamsa/schema";
import { memo, useLayoutEffect, useRef } from "react";
import type { NodeMap } from "../lib/model";

export const shadowRoots = new Map<string, ShadowRoot>();

const assetOrigin = () => `lamsa-asset://${window.lamsa?.assetHost ?? "local"}`;

export function assetUrl(src: string): string {
  if (/^(https?:|data:)/.test(src)) return src;
  return `${assetOrigin()}/${src.split("/").map(encodeURIComponent).join("/")}`;
}

/** Points the project's relative font URLs at the asset protocol. */
export function localFontCss(css: string): string {
  return css.replace(/url\("(?!https?:|data:)([^"]+)"\)/g, (_m, path: string) => `url("${assetOrigin()}/${path}")`);
}

export function shadowCss(tokens: TokenSet): string {
  return `${baseCss(tokens)}\n${tokens.css.replace(/:root\b/g, ":host")}\n:host { display: block; }\n::selection { background: rgba(31, 95, 168, 0.22); }\n[contenteditable]:focus { outline: none; }\n`;
}

interface Props {
  id: string;
  nodes: NodeMap;
  /** Each node's child ids (named so React doesn't treat it as JSX children). */
  childIds: Map<string, string[]>;
  tokens: TokenSet;
  icons: Record<string, string>;
  canvasMode: TokenMode;
  version: number;
  frozen: boolean;
  componentProps?: Record<string, string | boolean>;
  fileCss: string;
}

/** The nodes a frame's render reads, with their children: its own layers and the components its instances use. */
interface RenderedFrom {
  nodes: Map<string, DesignNode | undefined>;
  children: Map<string, string[] | undefined>;
  inputs: unknown[];
}

function renderedFrom({ id, nodes, children, inputs }: { id: string; nodes: NodeMap; children: Map<string, string[]>; inputs: unknown[] }): RenderedFrom {
  const used: RenderedFrom = { nodes: new Map(), children: new Map(), inputs };
  const stack = [id];
  while (stack.length) {
    const next = stack.pop()!;
    if (used.nodes.has(next)) continue;
    const node = nodes[next];
    const kids = children.get(next);
    used.nodes.set(next, node);
    used.children.set(next, kids);
    if (kids) stack.push(...kids);
    if (node?.type === "instance") stack.push(node.componentId);
  }
  return used;
}

function sameList(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, i) => item === b[i]);
}

/** Nothing this frame shows changed, so the render can be skipped (an edit elsewhere rebuilt the node map). */
function unchanged({ last, nodes, children, inputs }: { last: RenderedFrom | null; nodes: NodeMap; children: Map<string, string[]>; inputs: unknown[] }): boolean {
  if (!last || !sameList(last.inputs, inputs)) return false;
  for (const [id, node] of last.nodes) if (nodes[id] !== node) return false;
  for (const [id, kids] of last.children) if (!sameList(children.get(id), kids)) return false;
  return true;
}

/** Renders one top-level frame into its own shadow root, isolated from the editor's CSS. */
export const FrameView = memo(function FrameView({ id, nodes, childIds: children, tokens, icons, canvasMode, version, frozen, componentProps, fileCss }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const last = useRef<RenderedFrom | null>(null);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    shadowRoots.set(id, root);
    return () => {
      shadowRoots.delete(id);
    };
  }, [id]);

  useLayoutEffect(() => {
    const root = host.current?.shadowRoot;
    if (frozen) last.current = null;
    if (!root || frozen || !nodes[id]) return;
    const inputs = [id, tokens, icons, canvasMode, version, componentProps, fileCss];
    if (unchanged({ last: last.current, nodes, children, inputs })) return;
    last.current = renderedFrom({ id, nodes, children, inputs });
    const result = buildRenderTree({
      nodes,
      rootId: id,
      tokens,
      canvasMode,
      iconSvg: (name) => icons[name] || undefined,
      assetUrl,
      componentProps,
      fileCss,
    });
    root.innerHTML = `<style>${shadowCss(tokens)}\n${withoutPointerStates(result.css)}</style><div class="lamsa-surface ${result.mode}">${toHtml(result.root)}</div>`;
    // The canvas shows motion at rest: entrances at their end, loops parked, and no hover or press.
    // The preview plays them.
    settleAnimations(root);
  }, [id, nodes, children, tokens, icons, canvasMode, version, frozen, componentProps, fileCss]);

  return <div ref={host} className="frame-host" data-root-id={id} />;
});

export function findElement(rootId: string, displayId: string): HTMLElement | null {
  const root = shadowRoots.get(rootId);
  if (!root) return null;
  return root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(displayId)}"]`);
}
