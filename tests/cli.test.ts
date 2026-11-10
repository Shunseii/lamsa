import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GLOBALS_CSS, tempRepo } from "./helpers.js";

const CLI = fileURLToPath(new URL("../packages/cli/dist/cli.js", import.meta.url));

function lamsa(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], { cwd, encoding: "utf8" });
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
  });

  it("exits non-zero with a fix when input is invalid", () => {
    const root = tempRepo({ "app/globals.css": GLOBALS_CSS });
    lamsa(root, "init", "--yes");
    const bad = lamsa(root, "add", "--file", "designs/x.lamsa.json", "--tree", '{"type":"icon","set":"lucide","icon":"hous"}');
    expect(bad.code).toBe(1);
    expect(JSON.stringify(bad.json)).toContain("house");
    expect(existsSync(join(root, "designs/x.lamsa.json"))).toBe(false);
  });
});
