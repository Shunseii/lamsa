import type { DesignNode } from "@lamsa/schema";
import { describe, expect, it } from "vitest";
import { buildModel, iconNamesIn, updateModel, type Model } from "../apps/desktop/src/renderer/src/lib/model.js";
import type { FileState } from "../apps/desktop/src/shared/api.js";

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

const plain = (model: Model) => ({
  nodes: model.nodes,
  fileOf: [...model.fileOf].sort(),
  roots: model.roots,
  children: Object.fromEntries([...model.children].sort(([a], [b]) => (a < b ? -1 : 1))),
  fileCss: model.fileCss,
});

const frame = (fields: Partial<DesignNode> = {}): DesignNode => ({ type: "frame", ...fields }) as DesignNode;

describe("updateModel", () => {
  it("matches a full rebuild through random edits, deletes, reparents and orphans across files", () => {
    const next = random(7);
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
    const paths = ["a.lamsa.json", "b.lamsa.json"];
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const randomNode = (): DesignNode =>
      next() < 0.2 ? frame({ index: String(Math.floor(next() * 5)) }) : frame({ parentId: pick(ids), index: String(Math.floor(next() * 5)) });
    let files: Record<string, FileState> = Object.fromEntries(paths.map((path) => [path, { path, nodes: {} }]));
    for (const id of ids) files[pick(paths)]!.nodes[id] = randomNode();
    for (const open of [undefined, null, ["a.lamsa.json"]] as const) {
      let model = buildModel(files, open);
      for (let step = 0; step < 300; step++) {
        const changed = new Set<string>();
        const after: Record<string, FileState> = { ...files };
        for (let i = 0, count = 1 + Math.floor(next() * 4); i < count; i++) {
          const path = pick(paths);
          const id = pick(ids);
          const nodes = { ...after[path]!.nodes };
          if (next() < 0.3) delete nodes[id];
          else nodes[id] = randomNode();
          after[path] = { ...after[path]!, nodes, css: next() < 0.1 ? `@keyframes k${step} {}` : after[path]!.css };
          changed.add(id);
        }
        const updated = updateModel({ previous: model, files: after, changedIds: changed, open });
        expect(plain(updated)).toEqual(plain(buildModel(after, open)));
        for (const [parentId, list] of model.children) {
          const untouched = list.every((id) => !changed.has(id)) && !changed.has(parentId) && [...changed].every((id) => model.nodes[id]?.parentId !== parentId && updated.nodes[id]?.parentId !== parentId);
          if (untouched) expect(updated.children.get(parentId)).toBe(list);
        }
        files = after;
        model = updated;
      }
    }
  });

  it("keeps unchanged nodes as the same objects", () => {
    const files: Record<string, FileState> = { "a.lamsa.json": { path: "a.lamsa.json", nodes: { root: frame(), kid: frame({ parentId: "root" }) } } };
    const model = buildModel(files);
    const moved = frame({ x: 10 });
    const after = { "a.lamsa.json": { ...files["a.lamsa.json"]!, nodes: { ...files["a.lamsa.json"]!.nodes, root: moved } } };
    const updated = updateModel({ previous: model, files: after, changedIds: ["root"] });
    expect(updated.nodes.root).toBe(moved);
    expect(updated.nodes.kid).toBe(model.nodes.kid);
    expect(updated.children.get("root")).toBe(model.children.get("root"));
  });
});

describe("iconNamesIn", () => {
  it("finds icons on layers, component prop overrides and instance overrides", () => {
    const nodes: DesignNode[] = [
      { type: "icon", icon: "star" } as DesignNode,
      frame({ component: { props: { on: { type: "boolean", default: false, overrides: { true: { x: { icon: "check" } } } } } } } as Partial<DesignNode>),
      { type: "instance", componentId: "c", overrides: { y: { icon: "heart" } } } as DesignNode,
    ];
    expect(iconNamesIn(nodes).sort()).toEqual(["check", "heart", "star"]);
  });
});
