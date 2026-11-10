import { describe, expect, it } from "vitest";
import { buildRenderTree, toHtml } from "@lamsa/renderer";
import { parseShadcnTailwind4 } from "@lamsa/core";
import type { DesignNode } from "@lamsa/schema";
import { GLOBALS_CSS } from "./helpers.js";

const tokens = parseShadcnTailwind4(GLOBALS_CSS);

const nodes: Record<string, DesignNode> = {
  btn: {
    type: "frame",
    style: { background: "{color.primary}", padding: 8 },
    component: {
      props: {
        variant: { type: "enum", options: ["solid", "ghost"], default: "solid", overrides: { ghost: { btn: { style: { background: "transparent" } } } } },
        label: { type: "text", default: "Button", target: "lbl" },
      },
    },
  },
  lbl: { type: "text", parentId: "btn", index: "a0", content: "Button" },
  screen: { type: "frame", style: { width: 390 } },
  pay: { type: "instance", parentId: "screen", index: "a0", componentId: "btn", props: { variant: "ghost", label: "Pay" }, style: { width: "100%" } },
};

describe("renderer", () => {
  it("expands instances with props, resolves tokens and px values", () => {
    const { root, missingTokens } = buildRenderTree({ nodes, rootId: "screen", tokens, iconSvg: () => undefined });
    const html = toHtml(root);
    expect(missingTokens).toEqual([]);
    expect(html).toContain('data-node-id="pay"');
    expect(html).toContain('data-node-id="pay/lbl"');
    expect(html).toContain(">Pay<");
    expect(html).toContain("background: transparent");
    expect(html).toContain("width: 100%");
    expect(html).toContain("width: 390px");
  });

  it("uses default props and token css", () => {
    const { root } = buildRenderTree({ nodes, rootId: "btn", tokens, iconSvg: () => undefined });
    const html = toHtml(root);
    expect(html).toContain("background: var(--primary)");
    expect(html).toContain("padding: 8px");
  });

  it("escapes text content", () => {
    const { root } = buildRenderTree({
      nodes: { t: { type: "text", content: "<b>&" } },
      rootId: "t",
      tokens,
      iconSvg: () => undefined,
    });
    expect(toHtml(root)).toContain("&lt;b&gt;&amp;");
  });
});
