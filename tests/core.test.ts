import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FILE,
  addTree,
  buildChildIndex,
  childrenOf,
  deleteNodes,
  designFilesAtRef,
  diffAgainstRef,
  diffDesignFiles,
  checkFileCss,
  checkNodeCss,
  cssStateNames,
  formatDesignFile,
  formatNodeCss,
  isDesignFile,
  loadProject,
  loadTokens,
  moveNode,
  parseShadcnTailwind4,
  readActivity,
  recordActivity,
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

  it("adds Tailwind's built-in theme as builtin tokens, letting the project override or reset it", () => {
    const defaults = `@theme default {
  --color-blue-500: oklch(62% 0.2 260);
  --color-red-500: oklch(63% 0.25 27);
  --text-sm: 0.875rem;
  --text-sm--line-height: calc(1.25 / 0.875);
  --font-weight-bold: 700;
  --radius-lg: 0.5rem;
  --animate-spin: spin 1s linear infinite;
}`;
    const tokens = parseShadcnTailwind4(`@import "tailwindcss";\n@theme { --color-red-500: #f00; }`, { defaults });
    expect(tokens.tokens["color.blue-500"]).toMatchObject({ css: "var(--color-blue-500)", kind: "color", builtin: true });
    expect(tokens.tokens["color.red-500"]).toMatchObject({ values: { light: "#f00" } });
    expect(tokens.tokens["color.red-500"]?.builtin).toBeUndefined();
    expect(tokens.tokens["text.sm"]).toMatchObject({ kind: "text", values: { light: "0.875rem" } });
    expect(tokens.tokens["font-weight.bold"]?.values.light).toBe("700");
    expect(Object.keys(tokens.tokens).some((path) => path.includes("line-height") || path.startsWith("animate"))).toBe(false);
    expect(tokens.css).toContain("--color-blue-500: oklch(62% 0.2 260);");

    const reset = parseShadcnTailwind4(`@theme { --color-*: initial; --color-brand: #123456; }`, { defaults });
    expect(reset.tokens["color.blue-500"]).toBeUndefined();
    expect(reset.tokens["color.brand"]?.values.light).toBe("#123456");
    expect(reset.tokens["text.sm"]).toBeDefined();
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

describe("node css", () => {
  it("formats like Prettier: one declaration per line, long lists split, token refs kept", () => {
    expect(formatNodeCss("transition: translate 240ms ease-out, box-shadow 240ms ease-out;&:hover{box-shadow:{shadow.lg}}")).toBe(
      "transition:\n  translate 240ms ease-out,\n  box-shadow 240ms ease-out;\n\n&:hover {\n  box-shadow: {shadow.lg};\n}",
    );
  });

  it("reports syntax errors and nested @keyframes", () => {
    expect(checkNodeCss("color: red; &:hover { color: blue")[0]?.message).toBe("Unclosed block");
    expect(checkNodeCss("@keyframes x { from { opacity: 0 } }")[0]?.message).toContain("file's \"css\"");
  });

  it("accepts enter/exit transitions in node css and page-transition rules in file css", () => {
    const modal = '&[data-state="closed"] { display: none; opacity: 0; }\ntransition: opacity 200ms, display 200ms allow-discrete;\n@starting-style { opacity: 0; scale: 0.95; }';
    expect(checkNodeCss(modal)).toEqual([]);
    expect(formatNodeCss(modal)).toContain("@starting-style {\n  opacity: 0;");
    expect(cssStateNames(modal)).toEqual(["closed"]);
    expect(checkFileCss("::view-transition-old(card) { animation: fade 200ms; }\n:active-view-transition-type(back)::view-transition-new(root) { animation-name: slide; }")).toEqual([]);
    expect(checkFileCss(".card { color: red; }")[0]?.message).toContain("::view-transition-*");
  });

  it("validates keyframe names against file css and the app stylesheet", async () => {
    const root = tempRepo({
      "lamsa.config.json": config,
      "app/globals.css": GLOBALS_CSS + "\n@keyframes app-pulse { 50% { opacity: 0.5; } }",
      "designs/a.lamsa.json": {
        version: 1,
        css: "@keyframes fade-up { from { opacity: 0; } }",
        nodes: {
          ok: { type: "frame", css: "animation: fade-up 200ms ease-out, app-pulse 1s infinite;" },
          typo: { type: "frame", css: "animation: fade-upp 200ms;" },
        },
      },
    });
    const loaded = await loadProject(root);
    const issues = validateProject({ project: loaded, tokens: await loadTokens(root, loaded.config) });
    expect(issues.filter((i) => i.code === "unknown-keyframes").map((i) => i.nodeId)).toEqual(["typo"]);
    expect(issues.find((i) => i.code === "unknown-keyframes")?.fix).toContain("fade-up");
  });
});


describe("agent activity", () => {
  it("keeps the newest entry, caps its ids and reads back only well-formed entries", async () => {
    const root = tempRepo({ ".lamsa/session.json": { selection: [] } });
    const ids = Array.from({ length: 80 }, (_, i) => `id${i}`);
    await recordActivity({ root, activity: { command: "add", kind: "write", ids: [...ids, "id0"] }, env: { LAMSA_AGENT_NAME: "Tester" } });
    await recordActivity({ root, activity: { command: "tree", kind: "read", ids: ["abc"], file: "designs/a.lamsa.json" }, env: {} });
    const latest = await readActivity(root);
    expect(latest).toMatchObject({ agent: "Agent", command: "tree", kind: "read", ids: ["abc"], file: "designs/a.lamsa.json" });

    await recordActivity({ root, activity: { command: "add", kind: "write", ids: [...ids, "id0"] }, env: {} });
    expect((await readActivity(root))?.ids).toEqual(ids.slice(0, 50));

    writeFileSync(join(root, ACTIVITY_FILE), JSON.stringify({ command: "add", kind: "delete", ids: [] }));
    expect(await readActivity(root)).toBeUndefined();
    writeFileSync(join(root, ACTIVITY_FILE), "{ half");
    expect(await readActivity(root)).toBeUndefined();
  });
});

describe("design diff", () => {
  const file = (nodes: Record<string, unknown>) => ({ version: 1, nodes });
  const frame = (extra: Record<string, unknown> = {}) => ({ type: "frame", style: { width: 100, height: 100 }, ...extra });
  const before = file({
    screen: frame({ name: "Checkout", x: 0, y: 0 }),
    pay: { type: "text", name: "Pay", content: "Pay", parentId: "screen", index: "a0", style: { width: 342 } },
    old: { type: "text", content: "Old banner", parentId: "screen", index: "a1" },
    a: { type: "text", content: "A", parentId: "screen", index: "a2" },
    other: frame({ name: "Elsewhere", x: 400, y: 0 }),
    button: frame({ name: "Button", component: true, x: 800, y: 0 }),
    label: { type: "text", content: "Go", parentId: "button", index: "a0" },
    page: frame({ name: "Uses button", x: 1200, y: 0 }),
    use: { type: "instance", componentId: "button", parentId: "page", index: "a0" },
  });
  const after = file({
    screen: frame({ name: "Checkout", x: 0, y: 0 }),
    pay: { type: "text", name: "Pay", content: "Pay $48.00", parentId: "screen", index: "a0", style: { width: "100%" } },
    a: { type: "text", content: "A", parentId: "screen", index: "a9" },
    error: { type: "text", content: "Card declined", parentId: "screen", index: "a3" },
    other: frame({ name: "Elsewhere", x: 400, y: 500 }),
    button: frame({ name: "Button", component: true, x: 800, y: 0 }),
    label: { type: "text", content: "Go now", parentId: "button", index: "a0" },
    page: frame({ name: "Uses button", x: 1200, y: 0 }),
    use: { type: "instance", componentId: "button", parentId: "page", index: "a0" },
    fresh: frame({ name: "New screen", x: 1600, y: 0 }),
  });
  const diff = diffDesignFiles({
    before: [["designs/a.lamsa.json", before]],
    after: [["designs/a.lamsa.json", after]],
    base: "main",
    head: "working tree",
  });

  it("names each value that changed, from what to what", () => {
    const pay = diff.changes.find((change) => change.id === "pay")!;
    expect(pay.values).toEqual([
      { field: "content", before: "Pay", after: "Pay $48.00" },
      { field: "style.width", before: 342, after: "100%" },
    ]);
    expect(diff.changes.find((change) => change.id === "a")!.fields).toEqual(["index"]);
    expect(diff.changes.find((change) => change.id === "old")).toMatchObject({ kind: "removed", text: "Old banner", screen: "screen" });
  });

  it("groups changes by screen with the layers to outline on each side", () => {
    const checkout = diff.screens.find((screen) => screen.id === "screen")!;
    expect(checkout).toMatchObject({ kind: "changed", added: ["error"], removed: ["old"] });
    expect(checkout.changed.sort()).toEqual(["a", "pay"]);
    expect(diff.screens.find((screen) => screen.id === "fresh")).toMatchObject({ kind: "added", added: [] });
  });

  it("follows a changed component into the screens that place it", () => {
    expect(diff.screens.find((screen) => screen.id === "page")).toMatchObject({ kind: "changed", components: ["button"], changed: ["label"] });
  });

  it("keeps a screen that only moved on the canvas out of the changed screens", () => {
    expect(diff.screens.some((screen) => screen.id === "other")).toBe(false);
    expect(diff.repositioned).toEqual(["other"]);
  });

  it("limits changes to the files asked for", () => {
    const only = diffDesignFiles({
      before: [["designs/a.lamsa.json", before], ["designs/b.lamsa.json", file({ b: frame() })]],
      after: [["designs/a.lamsa.json", before], ["designs/b.lamsa.json", file({ b: frame({ name: "B" }) })]],
      base: "main",
      head: "working tree",
      only: ["designs/b.lamsa.json"],
    });
    expect(only.changes.map((change) => change.id)).toEqual(["b"]);
  });

  it("reads a ref's design files by that ref's own design globs, not every JSON design in the repo", async () => {
    const root = tempRepo({
      "lamsa.config.json": { designs: ["designs/**/*.lamsa.json"] },
      "designs/a.lamsa.json": file({ screen: frame({ name: "A" }) }),
      "examples/app/designs/b.lamsa.json": file({ example: frame({ name: "Example" }) }),
    });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const files = designFilesAtRef({ root, ref: "HEAD", fallback: (await loadProject(root)).config });
    expect([...files.keys()]).toEqual(["designs/a.lamsa.json"]);
    expect(diffAgainstRef({ project: await loadProject(root), ref: "HEAD" }).changes).toEqual([]);
  });
});
