import { baseCss, buildRenderTree, toHtml } from "@lamsa/renderer";
import type { TokenMode, TokenSet } from "@lamsa/schema";
import { memo, useLayoutEffect, useRef } from "react";
import type { NodeMap } from "../lib/model";

export const shadowRoots = new Map<string, ShadowRoot>();

export function assetUrl(src: string): string {
  if (/^(https?:|data:)/.test(src)) return src;
  return `lamsa-asset://local/${src.split("/").map(encodeURIComponent).join("/")}`;
}

function shadowCss(tokens: TokenSet): string {
  return `${baseCss(tokens)}\n${tokens.css.replace(/:root\b/g, ":host")}\n:host { display: block; }\n`;
}

interface Props {
  id: string;
  nodes: NodeMap;
  tokens: TokenSet;
  icons: Record<string, string>;
  canvasMode: TokenMode;
  version: number;
  frozen: boolean;
  componentProps?: Record<string, string | boolean>;
}

/** Renders one top-level frame into its own shadow root, isolated from the editor's CSS. */
export const FrameView = memo(function FrameView({ id, nodes, tokens, icons, canvasMode, version, frozen, componentProps }: Props) {
  const host = useRef<HTMLDivElement>(null);

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
    if (!root || frozen || !nodes[id]) return;
    const result = buildRenderTree({
      nodes,
      rootId: id,
      tokens,
      canvasMode,
      iconSvg: (name) => icons[name] || undefined,
      assetUrl,
      componentProps,
    });
    root.innerHTML = `<style>${shadowCss(tokens)}</style><div class="lamsa-surface ${result.mode}">${toHtml(result.root)}</div>`;
  }, [id, nodes, tokens, icons, canvasMode, version, frozen, componentProps]);

  return <div ref={host} className="frame-host" data-root-id={id} />;
});

export function findElement(rootId: string, displayId: string): HTMLElement | null {
  const root = shadowRoots.get(rootId);
  if (!root) return null;
  return root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(displayId)}"]`);
}
