import { describe, expect, it } from "vitest";
import {
  buildRenderTree,
  emulateReducedMotion,
  pagePreset,
  renderDocument,
  setPagePreset,
  setTransitionDeclaration,
  toHtml,
  transitionTargetsIn,
  transitionTiming,
  withTransitionTarget,
  withoutPointerStates,
} from "@lamsa/renderer";
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

describe("main components", () => {
  it("render with their default props applied", () => {
    const component: Record<string, DesignNode> = {
      c: {
        type: "frame",
        component: { props: { icon: { type: "boolean", default: false, overrides: { false: { ic: { hidden: true } } } } } },
      },
      ic: { type: "icon", set: "lucide", icon: "lock", parentId: "c", index: "a0" },
    };
    const { root } = buildRenderTree({ nodes: component, rootId: "c", tokens, iconSvg: () => "<svg></svg>" });
    expect(toHtml(root)).toMatch(/data-node-id="ic"[^>]*display: none/);
  });

  it("emits a node's css as one rule with its style first, so state rules can override style values", () => {
    const motion: Record<string, DesignNode> = {
      card: {
        type: "frame",
        style: { width: 240, background: "{color.primary}" },
        css: "transition: width 300ms;\n&:hover { width: 44px; }\n&[data-state=\"open\"] { width: 320px; }",
      },
      plain: { type: "text", parentId: "card", index: "a0", content: "hi", style: { color: "red" } },
    };
    const result = buildRenderTree({ nodes: motion, rootId: "card", tokens, iconSvg: () => undefined, fileCss: "@keyframes fade { from { opacity: 0; } }" });
    const html = toHtml(result.root);
    expect(html).not.toContain("width: 240px");
    expect(html).toContain('data-lamsa-states="open"');
    expect(html).toContain('style="color: red');
    expect(result.css).toContain("@keyframes fade");
    expect(result.css).toMatch(/\[data-node-id="card"\] \{\nwidth: 240px;\nbackground: var\(--primary\);/);
    expect(result.css).toContain("&:is(:hover, [data-force-hover])");
    const still = withoutPointerStates(result.css);
    expect(still).toContain("&[data-force-hover]");
    expect(still).not.toMatch(/:hover|:active|:focus/);
    expect(renderDocument({ result, tokens })).toContain("transition: width 300ms");
  });

  it("can emulate prefers-reduced-motion", () => {
    expect(emulateReducedMotion("@media (prefers-reduced-motion: reduce) { a { b: c } }")).toContain("(min-width: 0px)");
    expect(emulateReducedMotion("@media (prefers-reduced-motion: no-preference) {}")).toContain("(max-width: -1px)");
  });
});

describe("page transitions in file css", () => {
  const custom = "@keyframes spin { to { rotate: 1turn; } }\n\n.x::view-transition-new(root) { animation: spin 1s; }";

  it("sets, reads and removes a target's timing without touching other rules", () => {
    let css = setTransitionDeclaration(custom, { target: "order", part: "group", direction: "any", property: "animation-duration", value: "320ms" });
    css = setTransitionDeclaration(css, { target: "order", part: "group", direction: "any", property: "animation-timing-function", value: "ease-out" });
    expect(css).toContain("::view-transition-group(order)");
    expect(css).toContain("@keyframes spin { to { rotate: 1turn; } }");
    expect(transitionTiming(css, "order")).toEqual({ duration: "320ms", easing: "ease-out" });
    css = setTransitionDeclaration(css, { target: "order", part: "group", direction: "any", property: "animation-duration", value: "400ms" });
    expect(transitionTiming(css, "order").duration).toBe("400ms");
    css = setTransitionDeclaration(css, { target: "order", part: "group", direction: "any", property: "animation-duration", value: "" });
    css = setTransitionDeclaration(css, { target: "order", part: "group", direction: "any", property: "animation-timing-function", value: "" });
    expect(css).not.toContain("view-transition-group(order)");
    expect(transitionTiming(css, "*.card")).toEqual({});
  });

  it("writes and recognises page presets, and calls anything else custom", () => {
    expect(pagePreset("")).toBe("fade");
    const slide = setPagePreset("", "slide");
    expect(pagePreset(slide)).toBe("slide");
    expect(slide).toContain(":active-view-transition-type(forward)::view-transition-new(root)");
    expect(slide).toContain("@keyframes lamsa-slide-from-right");
    expect(pagePreset(setPagePreset(slide, "none"))).toBe("none");
    expect(pagePreset(setPagePreset(slide, "fade"))).toBe("fade");
    expect(setPagePreset(setPagePreset(slide, "slide"), "slide").match(/@keyframes lamsa-slide-from-right/g)).toHaveLength(1);
    expect(pagePreset(":active-view-transition-type(forward)::view-transition-new(root) { animation: page-in 300ms; }")).toBe("custom");
  });

  it("finds and sets transition names and classes on a node", () => {
    expect(transitionTargetsIn("view-transition-name: order;\nview-transition-class: card;")).toEqual(["order", "*.card"]);
    expect(transitionTargetsIn("view-transition-name: none;")).toEqual([]);
    expect(withTransitionTarget("opacity: 1;", "hero")).toBe("view-transition-name: hero;\nopacity: 1;");
    expect(withTransitionTarget("view-transition-name: a;\nopacity: 1;", "b")).toBe("view-transition-name: b;\nopacity: 1;");
    expect(withTransitionTarget(undefined, "*.card")).toBe("view-transition-class: card;");
  });
});
