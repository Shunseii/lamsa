import { describe, expect, it } from "vitest";
import {
  addTree,
  buildChildIndex,
  childrenOf,
  deleteNodes,
  formatDesignFile,
  isDesignFile,
  loadProject,
  loadTokens,
  moveNode,
  parseShadcnTailwind4,
  validateProject,
} from "@lamsa/core";
import { GLOBALS_CSS, tempRepo } from "./helpers.js";

const config = {
  designs: ["designs/**/*.lamsa.json"],
  tokens: { adapter: "shadcn-tailwind4", path: "app/globals.css" },
};

async function project(nodes: Record<string, unknown>) {
  const root = tempRepo({
    "lamsa.config.json": config,
    "app/globals.css": GLOBALS_CSS,
    "designs/a.lamsa.json": { version: 1, nodes },
  });
  const loaded = await loadProject(root);
  return { project: loaded, tokens: await loadTokens(root, loaded.config) };
}

describe("shadcn-tailwind4 adapter", () => {
  it("maps @theme inline variables to token paths with light and dark values", () => {
    const tokens = parseShadcnTailwind4(GLOBALS_CSS);
    expect(tokens.tokens["color.primary"]).toMatchObject({
      css: "var(--primary)",
      kind: "color",
      values: { light: "oklch(0.2 0 0)", dark: "oklch(0.9 0 0)" },
    });
    expect(tokens.tokens["radius.md"]?.values.light).toBe("calc(0.5rem - 2px)");
    expect(tokens.tokens["spacing.4"]?.values.light).toBe("1rem");
    expect(tokens.css).toContain(".dark {");
  });
});

describe("formatDesignFile", () => {
  it("flattens nested children and assigns ordered indexes", () => {
    const { file } = formatDesignFile({
      raw: {
        nodes: {
          root: {
            type: "frame",
            children: [
              { type: "text", content: "a" },
              { type: "text", content: "b" },
            ],
          },
        },
      },
    });
    const children = Object.entries(file.nodes).filter(([, n]) => n.parentId === "root");
    expect(children).toHaveLength(2);
    const [first, second] = children.map(([, n]) => n);
    expect(first!.index! < second!.index!).toBe(true);
    expect(file.version).toBe(1);
  });

  it("removes orphans only with fix", () => {
    const raw = { version: 1, nodes: { a: { type: "text", content: "x", parentId: "gone", index: "a0" } } };
    expect(Object.keys(formatDesignFile({ raw }).file.nodes)).toEqual(["a"]);
    expect(Object.keys(formatDesignFile({ raw, fix: true }).file.nodes)).toEqual([]);
  });
});

describe("validateProject", () => {
  it("accepts a valid file", async () => {
    const ctx = await project({
      root: { type: "frame", x: 0, y: 0, style: { background: "{color.primary}" } },
      t: { type: "text", parentId: "root", index: "a0", content: "hi" },
    });
    expect(validateProject(ctx).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("reports missing parents, bad tokens with suggestions, and children of text nodes", async () => {
    const ctx = await project({
      root: { type: "frame", style: { color: "{color.primry}" } },
      t: { type: "text", parentId: "root", index: "a0", content: "hi" },
      u: { type: "text", parentId: "t", index: "a0", content: "nested" },
      o: { type: "text", parentId: "nope", index: "a0", content: "orphan" },
    });
    const codes = validateProject(ctx).map((i) => `${i.code}:${i.nodeId}`);
    expect(codes).toEqual(
      expect.arrayContaining(["unknown-token:root", "invalid-parent:u", "missing-parent:o"]),
    );
    const token = validateProject(ctx).find((i) => i.code === "unknown-token");
    expect(token?.fix).toContain("color.primary");
  });

  it("checks instance props against the component definition", async () => {
    const ctx = await project({
      btn: {
        type: "frame",
        component: { props: { variant: { type: "enum", options: ["a", "b"], default: "a" } } },
      },
      i: { type: "instance", componentId: "btn", props: { variant: "c", size: "lg" } },
    });
    const codes = validateProject(ctx).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["prop-value", "unknown-prop"]));
  });

  it("warns when a raw value equals a token", async () => {
    const ctx = await project({ root: { type: "frame", style: { background: "#ffffff" } } });
    const issue = validateProject(ctx).find((i) => i.code === "raw-token-value");
    expect(issue?.fix).toBe('use "{color.background}"');
  });
});

describe("edits", () => {
  it("adds, reorders, moves across files and deletes subtrees", async () => {
    const { project: p } = await project({ root: { type: "frame", x: 0, y: 0 } });
    const added = addTree({
      project: p,
      input: [
        { id: "a", type: "text", content: "a" },
        { id: "box", type: "frame", children: [{ id: "c", type: "text", content: "c" }] },
      ],
      placement: { parentId: "root" },
    });
    expect(added.created.sort()).toEqual(["a", "box", "c"]);

    addTree({ project: p, input: { id: "b", type: "text", content: "b" }, placement: { parentId: "root", after: "a" } });
    const file = p.files.get("designs/a.lamsa.json")!.raw;
    if (!isDesignFile(file)) throw new Error("not a design file");
    expect(childrenOf(buildChildIndex(file.nodes), "root")).toEqual(["a", "b", "box"]);

    moveNode({ project: p, id: "box", placement: { file: "designs/b.lamsa.json" } });
    const other = p.files.get("designs/b.lamsa.json")!.raw;
    if (!isDesignFile(other)) throw new Error("not a design file");
    expect(Object.keys(other.nodes).sort()).toEqual(["box", "c"]);
    expect(other.nodes.box?.parentId).toBeUndefined();

    expect(() => moveNode({ project: p, id: "b", placement: { parentId: "a" } })).toThrow(/only frames/);
    expect(() => moveNode({ project: p, id: "root", placement: { parentId: "a" } })).toThrow(/itself/);

    const removed = deleteNodes({ project: p, ids: ["box"] });
    expect(removed.deleted.sort()).toEqual(["box", "c"]);
  });
});
