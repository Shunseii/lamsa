import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBALS_CSS, tempRepo } from "./helpers.js";

const CLI = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

function lamsa(cwd: string, ...args: string[]) {
  return lamsaWith({ cwd, args });
}

function lamsaWith({ cwd, args, env }: { cwd: string; args: string[]; env?: NodeJS.ProcessEnv }) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: result.status, json: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
}

describe("lamsa CLI (agent loop, no editor)", () => {
  it("inits, adds, validates and renders without prompts", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    expect(lamsa(root, "init", "--yes").code).toBe(0);
    expect(existsSync(join(root, ".claude/skills/lamsa/SKILL.md"))).toBe(true);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("lamsa:start");

    const added = lamsa(
      root,
      "add",
      "--file",
      "designs/home.lamsa.json",
      "--tree",
      JSON.stringify({
        type: "frame",
        name: "Home",
        style: { width: 200, height: 100, background: "{color.primary}" },
        children: [{ type: "icon", set: "lucide", icon: "house" }],
      }),
    );
    expect(added.code).toBe(0);
    const [rootId] = added.json.rootIds as string[];

    expect(lamsa(root, "validate").json).toMatchObject({ ok: true, errors: 0 });

    const rendered = lamsa(root, "render", "Home", "--scale", "1");
    expect(rendered.code).toBe(0);
    const frame = (rendered.json.frames as { path: string; width: number; id: string }[])[0]!;
    expect(frame).toMatchObject({ id: rootId, width: 200 });
    expect(readFileSync(join(root, frame.path)).subarray(1, 4).toString()).toBe("PNG");

    // Motion: an entrance animation renders as a strip of moments, and a state can be forced.
    const motion = lamsa(
      root,
      "add",
      "--file",
      "designs/home.lamsa.json",
      "--tree",
      JSON.stringify({
        type: "frame",
        name: "Card",
        x: 400,
        style: { width: 120, height: 60, background: "{color.primary}" },
        css: "animation: fade 300ms ease-out both;\n&:hover { opacity: 0.5; }",
      }),
    );
    expect(motion.code).toBe(0);
    expect(lamsa(root, "validate").json).toMatchObject({ warnings: 1 });
    const designPath = join(root, "designs/home.lamsa.json");
    const design = JSON.parse(readFileSync(designPath, "utf8"));
    design.css = "@keyframes fade { from { opacity: 0; } }";
    writeFileSync(designPath, JSON.stringify(design));
    expect(lamsa(root, "validate").json).toMatchObject({ errors: 0, warnings: 0 });
    const strip = lamsa(root, "render", "Card", "--scale", "1", "--animate", "4");
    expect(strip.code).toBe(0);
    const stripFrame = (strip.json.frames as { path: string; times?: number[] }[])[0]!;
    expect(stripFrame.path).toContain(".animate.png");
    expect(stripFrame.times).toEqual([0, 100, 200, 300]);
    expect(lamsa(root, "render", "Card", "--scale", "1", "--state", "hover").code).toBe(0);
  }, 60_000);

  it("exits non-zero with a fix when input is invalid", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    lamsa(root, "init", "--yes");
    const bad = lamsa(root, "add", "--file", "designs/x.lamsa.json", "--tree", '{"type":"icon","set":"lucide","icon":"hous"}');
    expect(bad.code).toBe(1);
    expect(JSON.stringify(bad.json)).toContain("house");
    expect(existsSync(join(root, "designs/x.lamsa.json"))).toBe(false);
  });

  it("opens the editor with several layers selected, and refuses IDs that don't exist", async () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    lamsa(root, "init", "--yes");
    const added = lamsa(root, "add", "--file", "designs/a.lamsa.json", "--tree", JSON.stringify({ type: "frame", name: "A", children: [{ type: "text", content: "Hi" }] }));
    const [frameId] = added.json.rootIds as string[];
    const textId = (lamsa(root, "tree").json.nodes as { id: string; type: string }[]).find((node) => node.type === "text")!.id;
    const argsFile = join(root, "desktop-args.txt");
    const fakeDesktop = join(root, "fake-desktop.sh");
    writeFileSync(fakeDesktop, `#!/bin/sh\necho "$@" > "${argsFile}"\n`, { mode: 0o755 });
    const env = { LAMSA_DESKTOP_BIN: fakeDesktop };

    const opened = lamsaWith({ cwd: root, args: ["open", "--select", `${frameId},${textId}`, "--select", frameId!], env });
    expect(opened.code).toBe(0);
    expect(opened.json.select).toEqual([frameId, textId]);
    await expect.poll(() => (existsSync(argsFile) ? readFileSync(argsFile, "utf8") : "")).toContain(`--select=${frameId},${textId}`);

    const missing = lamsaWith({ cwd: root, args: ["open", "--select", `${frameId},nope1234`], env });
    expect(missing.code).not.toBe(0);
    expect(JSON.stringify(missing.json)).toContain("nope1234");
  });

  it.runIf(process.platform === "linux")("opens the newest downloaded AppImage when lamsa-desktop isn't on PATH, and says where to get the app when there is none", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    lamsa(root, "init", "--yes");
    const home = join(root, "home");
    const applications = join(home, "Applications");
    mkdirSync(applications, { recursive: true });
    const argsFile = join(root, "desktop-args.txt");
    for (const version of ["0.9.0", "0.10.0"]) {
      writeFileSync(join(applications, `lamsa-${version}-linux-x86_64.AppImage`), `#!/bin/sh\necho "${version} $@" > "${argsFile}"\n`, { mode: 0o755 });
    }
    // An empty PATH, so a lamsa-desktop installed on this machine isn't found first.
    const { LAMSA_DESKTOP_BIN: _bin, ...env } = process.env;
    const open = () => spawnSync(process.execPath, [CLI, "--json", "open"], { cwd: root, encoding: "utf8", env: { ...env, HOME: home, PATH: join(root, "no-bin") } });

    const opened = open();
    expect(opened.status).toBe(0);
    expect(JSON.parse(opened.stdout).app).toBe(join(applications, "lamsa-0.10.0-linux-x86_64.AppImage"));

    rmSync(applications, { recursive: true });
    const none = open();
    expect(none.status).not.toBe(0);
    expect(none.stdout + none.stderr).toContain("github.com/Shunseii/lamsa/releases");
  });
});

describe("lamsa diff", () => {
  it("renders changed screens before and after, outlines what changed, and writes a page and a PR report", () => {
    const design = (nodes: Record<string, unknown>) => ({ version: 1, nodes });
    const screen = { type: "frame", name: "Checkout", x: 0, y: 0, style: { width: 240, height: 160, background: "#ffffff", display: "flex", "flex-direction": "column", gap: 8, padding: 16 } };
    const root = tempRepo({
      "lamsa.config.json": { tokens: { adapter: "none" } },
      "designs/checkout.lamsa.json": design({
        Scr00001: screen,
        Pay00001: { type: "frame", name: "Pay", parentId: "Scr00001", index: "a0", style: { width: 120, height: 32, background: "#111111" } },
        Same0001: { type: "frame", name: "Still", x: 400, y: 0, style: { width: 80, height: 80, background: "#eeeeee" } },
      }),
    });
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    expect(lamsa(root, "diff", "--text", "--exit-code").code).toBe(0);

    writeFileSync(
      join(root, "designs/checkout.lamsa.json"),
      JSON.stringify(
        design({
          Scr00001: screen,
          Pay00001: { type: "frame", name: "Pay", parentId: "Scr00001", index: "a0", style: { width: 200, height: 32, background: "#111111" } },
          Err00001: { type: "text", content: "Card declined", parentId: "Scr00001", index: "a1" },
          Same0001: { type: "frame", name: "Still", x: 400, y: 0, style: { width: 80, height: 80, background: "#eeeeee" }, hidden: false },
        }),
      ),
    );

    const text = lamsa(root, "diff", "--text", "--exit-code");
    expect(text.code).toBe(1);
    const pay = (text.json.changes as { id: string; values?: unknown[] }[]).find((change) => change.id === "Pay00001");
    expect(pay?.values).toEqual([{ field: "style.width", before: 120, after: 200 }]);
    expect(existsSync(join(root, ".lamsa/diff"))).toBe(false);

    const rendered = lamsa(root, "diff", "--scale", "1");
    expect(rendered.code).toBe(0);
    type Screen = { id: string; before?: string; after?: string; afterMarked?: string; beforeMarked?: string; visible?: boolean };
    const screens = rendered.json.screens as Screen[];
    const checkout = screens.find((s) => s.id === "Scr00001")!;
    expect(checkout).toMatchObject({ visible: true, before: "Scr00001.before.png", after: "Scr00001.after.png", afterMarked: "Scr00001.after.marked.png" });
    const dir = join(root, ".lamsa/diff");
    const plain = readFileSync(join(dir, "Scr00001.after.png"));
    const marked = readFileSync(join(dir, "Scr00001.after.marked.png"));
    expect(marked.subarray(1, 4).toString()).toBe("PNG");
    expect(marked.equals(plain)).toBe(false);
    // A field change that renders the same is kept out of the pictures.
    expect(screens.find((s) => s.id === "Same0001")).toMatchObject({ visible: false });

    const page = readFileSync(join(dir, "index.html"), "utf8");
    expect(page).toContain("Scr00001.after.marked.png");
    expect(page).toContain("width 120 → 200");
    const report = readFileSync(join(dir, "report.md"), "utf8");
    expect(report).toContain("<!-- lamsa-diff -->");
    expect(report).toContain('"Card declined"');
    expect(report).toMatch(/No visible change: Still/);
  }, 60_000);
});

describe("lamsa CLI activity for the editor", () => {
  const readActivityFile = (root: string) => JSON.parse(readFileSync(join(root, ".lamsa/activity.json"), "utf8")) as Record<string, unknown>;
  const asAgent = (name: string) => ({ LAMSA_AGENT_NAME: name, CLAUDECODE: "" });

  it("records nothing in a project the editor has never used", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    expect(lamsa(root, "init", "--yes").code).toBe(0);
    const added = lamsaWith({ cwd: root, args: ["add", "--file", "designs/a.lamsa.json", "--tree", JSON.stringify({ type: "frame", name: "A" })], env: asAgent("Tester") });
    expect(added.code).toBe(0);
    expect(existsSync(join(root, ".lamsa/activity.json"))).toBe(false);
  });

  it("records what each write and targeted read touched, newest entry winning", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS, ".lamsa/session.json": { selection: [] } });
    expect(lamsa(root, "init", "--yes").code).toBe(0);
    const env = asAgent("Tester");
    const added = lamsaWith({
      cwd: root,
      args: ["add", "--file", "designs/a.lamsa.json", "--tree", JSON.stringify({ type: "frame", name: "A", children: [{ type: "text", content: "Hi" }] })],
      env,
    });
    const [frameId] = added.json.rootIds as string[];
    const [, textId] = added.json.created as string[];
    expect(readActivityFile(root)).toMatchObject({ agent: "Tester", command: "add", kind: "write", ids: [frameId], file: "designs/a.lamsa.json" });

    lamsaWith({ cwd: root, args: ["tree", textId!], env });
    expect(readActivityFile(root)).toMatchObject({ command: "tree", kind: "read", ids: [textId], file: "designs/a.lamsa.json" });

    // A whole-project read points at nothing in particular, so the last entry stays.
    lamsaWith({ cwd: root, args: ["tree"], env });
    expect(readActivityFile(root)).toMatchObject({ command: "tree", ids: [textId] });

    lamsaWith({ cwd: root, args: ["delete", textId!], env });
    expect(readActivityFile(root)).toMatchObject({ command: "delete", kind: "write", ids: [frameId] });
  });

  it("names the agent from LAMSA_AGENT_NAME, then Claude Code's environment, else Agent", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS, ".lamsa/session.json": { selection: [] } });
    expect(lamsa(root, "init", "--yes").code).toBe(0);
    const add = (env: NodeJS.ProcessEnv) =>
      lamsaWith({ cwd: root, args: ["add", "--file", "designs/a.lamsa.json", "--tree", JSON.stringify({ type: "frame", name: "A" })], env });
    add({ LAMSA_AGENT_NAME: "", CLAUDECODE: "1" });
    expect(readActivityFile(root).agent).toBe("Claude");
    add({ LAMSA_AGENT_NAME: "Codex", CLAUDECODE: "1" });
    expect(readActivityFile(root).agent).toBe("Codex");
    add({ LAMSA_AGENT_NAME: "", CLAUDECODE: "" });
    expect(readActivityFile(root).agent).toBe("Agent");
  });
});
