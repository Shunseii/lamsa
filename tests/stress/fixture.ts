import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const { generateNKeysBetween } = createRequire(join(repo, "packages/core/package.json"))("fractional-indexing") as {
  generateNKeysBetween(a: string | null, b: string | null, n: number): string[];
};

type StressNode = Record<string, unknown>;

export interface StressShape {
  /** Approximate total node count across the generated files. */
  nodes: number;
  /** How many design files the nodes are spread over. */
  files?: number;
  /** Nodes under each top-level frame (except the deep and wide frames). */
  perRoot?: number;
  /** Depth of the one deeply nested frame chain. */
  deepChain?: number;
  /** Children of the one very wide frame. */
  wideChildren?: number;
}

const COMPONENTS = [
  { id: "Btn00001", props: { label: "Continue", variant: "outline" } },
  { id: "Inp00001", props: { label: "Email", value: "ada@lovelace.dev" } },
];
const ICONS = ["chevron-left", "check", "search", "star", "user"];

/** Deterministic, so every run of a size builds the same file. */
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function idFactory(prefix: string) {
  let next = 0;
  return () => `${prefix}${(next++).toString(36).padStart(6, "0")}`;
}

function leaf({ random, parentId }: { random: () => number; parentId: string }): StressNode {
  const roll = random();
  if (roll < 0.45) return { type: "text", parentId, content: `Label ${Math.floor(random() * 1e6)}`, style: { "font-size": 14 } };
  if (roll < 0.65) return { type: "icon", parentId, icon: ICONS[Math.floor(random() * ICONS.length)], set: "lucide", style: { width: 16, height: 16 } };
  if (roll < 0.85) {
    const component = COMPONENTS[Math.floor(random() * COMPONENTS.length)]!;
    return { type: "instance", parentId, componentId: component.id, props: component.props };
  }
  return { type: "frame", parentId, name: "Box", style: { width: 24, height: 24, background: "{color.muted}" } };
}

/** Builds one file's nodes: screens of nested rows and cards, plus optional deep and wide frames. */
function buildFile({ count, perRoot, fileIndex, deepChain, wideChildren }: { count: number; perRoot: number; fileIndex: number; deepChain: number; wideChildren: number }) {
  const random = seeded(fileIndex + 1);
  const nextId = idFactory(`S${fileIndex}`);
  const nodes: Record<string, StressNode> = {};
  const childrenOf = new Map<string, string[]>();
  const add = (node: StressNode) => {
    const id = nextId();
    nodes[id] = node;
    const parent = node.parentId as string | undefined;
    if (parent) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), id]);
    return id;
  };
  const roots: string[] = [];
  const addRoot = (name: string) => {
    const column = roots.length % 10;
    const row = Math.floor(roots.length / 10);
    const id = add({ type: "frame", name, x: column * 480, y: row * 1000, style: { width: 390, display: "flex", "flex-direction": "column", gap: 8, padding: 16, background: "{color.background}" } });
    roots.push(id);
    return id;
  };

  if (deepChain > 0) {
    let parentId = addRoot("Deep chain");
    for (let depth = 0; depth < deepChain; depth++) parentId = add({ type: "frame", parentId, name: `Level ${depth}`, style: { padding: 2, display: "flex" } });
    add({ type: "text", parentId, content: "Bottom of the chain" });
  }
  if (wideChildren > 0) {
    const parentId = addRoot("Wide list");
    for (let i = 0; i < wideChildren; i++) add({ type: "text", parentId, content: `Row ${i}` });
  }

  while (Object.keys(nodes).length < count) {
    const rootId = addRoot(`Screen ${roots.length}`);
    let budget = perRoot - 1;
    while (budget > 0) {
      const section = add({ type: "frame", parentId: rootId, name: "Section", style: { display: "flex", "flex-direction": "column", gap: 4 } });
      budget--;
      for (let r = 0; r < 4 && budget > 0; r++) {
        const row = add({ type: "frame", parentId: section, name: "Row", style: { display: "flex", gap: 4, "align-items": "center" } });
        budget--;
        for (let c = 0; c < 4 && budget > 0; c++, budget--) add(leaf({ random, parentId: row }));
      }
    }
  }

  for (const list of [roots, ...childrenOf.values()]) {
    const keys = generateNKeysBetween(null, null, list.length);
    list.forEach((id, i) => {
      nodes[id]!.index = keys[i];
    });
  }
  return { $schema: "https://lamsa.dev/schema/v1.json", version: 1, nodes };
}

/** Writes `designs/stress-N.lamsa.json` files into `root` and returns their repo-relative paths. */
export function writeStressDesigns(root: string, shape: StressShape): string[] {
  const files = shape.files ?? 2;
  const perRoot = shape.perRoot ?? 100;
  const paths: string[] = [];
  for (let fileIndex = 0; fileIndex < files; fileIndex++) {
    const design = buildFile({
      count: Math.ceil(shape.nodes / files),
      perRoot,
      fileIndex,
      deepChain: fileIndex === 0 ? (shape.deepChain ?? 60) : 0,
      wideChildren: fileIndex === 0 ? (shape.wideChildren ?? 400) : 0,
    });
    const path = `designs/stress-${fileIndex}.lamsa.json`;
    writeFileSync(join(root, path), JSON.stringify(design, null, 2));
    paths.push(path);
  }
  return paths;
}

/**
 * A temp copy of examples/shadcn-app as committed, plus generated stress files, with every design
 * file already open so the first-open prompt doesn't show.
 */
export function makeStressProject(shape: StressShape): string {
  const root = mkdtempSync(join(tmpdir(), "lamsa-stress-"));
  const archive = spawnSync("git", ["archive", "HEAD", "examples/shadcn-app"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", root, "--strip-components=2"], { input: archive.stdout });
  if (archive.status !== 0 || untar.status !== 0) throw new Error(`could not copy the example: ${archive.stderr}${untar.stderr}`);
  // Measurements were taken without the motion showcase; keep the project the same shape.
  rmSync(join(root, "designs/motion.lamsa.json"), { force: true });
  writeStressDesigns(root, shape);
  const designs = readdirSync(join(root, "designs")).filter((name) => name.endsWith(".lamsa.json"));
  mkdirSync(join(root, ".lamsa"), { recursive: true });
  writeFileSync(join(root, ".lamsa/session.json"), JSON.stringify({ selection: [], open: designs.map((name) => `designs/${name}`) }));
  return root;
}
