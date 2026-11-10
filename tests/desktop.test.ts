import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(repo, "packages/cli/dist/cli.js");
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");

let root: string;
let app: ElectronApplication;
let page: Page;

function lamsa(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], { cwd: root, encoding: "utf8" });
  return JSON.parse(result.stdout || "{}") as Record<string, unknown>;
}

function readDesign(file: string) {
  return JSON.parse(readFileSync(join(root, "designs", file), "utf8")) as { nodes: Record<string, Record<string, unknown>> };
}

describe("desktop editor", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "lamsa-desktop-"));
    cpSync(join(repo, "examples/shadcn-app"), root, { recursive: true, filter: (src) => !src.includes(".lamsa") || src.endsWith(".lamsa.json") });
    const config = JSON.parse(readFileSync(join(root, "lamsa.config.json"), "utf8"));
    config.agent = { command: "sh", args: ["-c", "echo lamsa-agent-ready; cat"] };
    writeFileSync(join(root, "lamsa.config.json"), JSON.stringify(config, null, 2));
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", root, "--select", "QkpksTeC"],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    page = await app.firstWindow();
    await page.getByTestId("layers-panel").waitFor();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("opens with the selection passed on the command line and shares it with the CLI", async () => {
    await expect.poll(() => (lamsa("selection").selection as { id: string }[] | undefined)?.map((s) => s.id)).toEqual(["QkpksTeC"]);
    await expect.poll(() => page.locator(".props-header .badge").textContent()).toBe("instance");
  });

  it("shows agent edits live without reopening", async () => {
    const added = lamsa("add", "--parent", "7qOxePB7", "--tree", JSON.stringify({ type: "text", name: "Agent note", content: "Added by the agent" }));
    expect(added.ok).toBe(true);
    await page.getByTestId("layers-panel").getByText("Agent note").waitFor({ timeout: 10_000 });
    await page.getByTestId("toasts").getByText("changed on disk").first().waitFor();
    const shadowText = await page.evaluate(() =>
      [...document.querySelectorAll(".frame-host")].map((h) => h.shadowRoot?.textContent ?? "").join(" "),
    );
    expect(shadowText).toContain("Added by the agent");
  });

  it("writes property edits to disk and undoes them", async () => {
    await page.getByTestId("layers-panel").getByText("Header", { exact: true }).click();
    const gap = page.getByTestId("properties-panel").locator(".field", { hasText: /^gap/ }).locator("input").first();
    await gap.fill("20");
    await gap.press("Enter");
    await expect.poll(() => readDesign("checkout.lamsa.json").nodes.Rwwc3Sdq?.style).toMatchObject({ gap: 20 });
    await page.locator(".canvas").click({ position: { x: 700, y: 120 } }).catch(() => {});
    await page.keyboard.press("Control+z");
    await expect.poll(() => (readDesign("checkout.lamsa.json").nodes.Rwwc3Sdq?.style as Record<string, unknown>)?.gap).toBe("{spacing.2}");
  });

  it("keeps a concurrent agent edit to another node when the user edits", async () => {
    const file = join(root, "designs/checkout.lamsa.json");
    const data = readDesign("checkout.lamsa.json");
    (data.nodes.gmrdFHB9 as { content: string }).content = "Checkout (agent)";
    writeFileSync(file, JSON.stringify(data, null, 2));
    await page.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const padding = page.getByTestId("properties-panel").locator(".field", { hasText: /^padding$/ }).locator("input").first();
    await padding.fill("8");
    await padding.press("Enter");
    await expect.poll(() => readDesign("checkout.lamsa.json").nodes.ddPB6Wpj?.style).toMatchObject({ padding: 8 });
    expect(readDesign("checkout.lamsa.json").nodes.gmrdFHB9?.content).toBe("Checkout (agent)");
  });

  it("keeps the last valid version on screen when a file becomes invalid", async () => {
    const file = join(root, "designs/components.lamsa.json");
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good.slice(0, 40));
    await page.getByTestId("invalid-banner").waitFor();
    await expect.poll(() => page.getByTestId("layers-panel").getByText("Button", { exact: true }).count()).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).toBe(good.slice(0, 40));
    writeFileSync(file, good);
    await page.getByTestId("invalid-banner").waitFor({ state: "detached" });
  });

  it("runs the configured agent in the terminal pane", async () => {
    await page.keyboard.press("Control+j");
    await page.getByTestId("terminal-panel").waitFor();
    await expect.poll(() => page.locator(".xterm-rows").textContent(), { timeout: 10_000 }).toContain("lamsa-agent-ready");
  });
});

describe("desktop editor canvas", () => {
  let canvasRoot: string;
  let canvasApp: ElectronApplication;
  let win: Page;

  const design = (file: string) => JSON.parse(readFileSync(join(canvasRoot, "designs", file), "utf8")) as { nodes: Record<string, Record<string, unknown>> };

  beforeAll(async () => {
    canvasRoot = mkdtempSync(join(tmpdir(), "lamsa-canvas-"));
    cpSync(join(repo, "examples/shadcn-app"), canvasRoot, { recursive: true });
    canvasApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", canvasRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await canvasApp.firstWindow();
    await win.getByTestId("layers-panel").waitFor();
    await win.waitForTimeout(400);
  }, 60_000);

  afterAll(async () => {
    await canvasApp?.close();
  });

  it("draws a top-level frame with the frame tool", async () => {
    const before = Object.keys(design("checkout.lamsa.json").nodes).length;
    await win.keyboard.press("f");
    await win.mouse.move(700, 600);
    await win.mouse.down();
    await win.mouse.move(800, 680, { steps: 4 });
    await win.mouse.up();
    await expect.poll(() => Object.keys(design("checkout.lamsa.json").nodes).length).toBe(before + 1);
    const created = Object.values(design("checkout.lamsa.json").nodes).find((n) => n.name === "Frame" && n.parentId === undefined);
    expect(created?.style).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
  });

  it("moves a top-level frame by dragging and resizes it with a handle", async () => {
    const id = Object.entries(design("checkout.lamsa.json").nodes).find(([, n]) => n.name === "Frame" && n.parentId === undefined)![0];
    const start = design("checkout.lamsa.json").nodes[id]!;
    const box = await win.evaluate((nodeId) => {
      const host = document.querySelector(`[data-root-id="${nodeId}"]`)!;
      const r = host.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }, id);
    await win.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.w / 2 + 60, box.y + box.h / 2 + 30, { steps: 6 });
    await win.mouse.up();
    await expect.poll(() => design("checkout.lamsa.json").nodes[id]?.x).not.toBe(start.x);

    const handle = win.locator(".ov-handle-se");
    const hb = (await handle.boundingBox())!;
    const width = (design("checkout.lamsa.json").nodes[id]!.style as { width: number }).width;
    await win.mouse.move(hb.x + 4, hb.y + 4);
    await win.mouse.down();
    await win.mouse.move(hb.x + 64, hb.y + 4, { steps: 5 });
    await win.mouse.up();
    await expect.poll(() => (design("checkout.lamsa.json").nodes[id]!.style as { width: number }).width).toBeGreaterThan(width);
  });

  it("edits text inline on double-click", async () => {
    const point = await win.evaluate(() => {
      for (const host of document.querySelectorAll(".frame-host")) {
        const el = host.shadowRoot?.querySelector('[data-node-id="gmrdFHB9"]');
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.x + 10, y: r.y + r.height / 2 };
        }
      }
      return null;
    });
    expect(point).not.toBeNull();
    await win.mouse.dblclick(point!.x, point!.y);
    await win.keyboard.type("Review and pay");
    await win.keyboard.press("Enter");
    await expect.poll(() => design("checkout.lamsa.json").nodes.gmrdFHB9?.content).toBe("Review and pay");
  });

  it("inserts a component instance from the picker", async () => {
    await win.getByTestId("layers-panel").getByText("Form", { exact: true }).click();
    await win.keyboard.press("c");
    await win.getByTestId("component-picker").waitFor();
    await win.getByTestId("component-picker").getByRole("button", { name: "Insert" }).click();
    await expect.poll(() =>
      Object.values(design("checkout.lamsa.json").nodes).filter((n) => n.type === "instance" && n.parentId === "7qOxePB7").length,
    ).toBe(3);
  });

  it("shows the context menu and duplicates", async () => {
    const before = Object.keys(design("checkout.lamsa.json").nodes).length;
    await win.getByTestId("layers-panel").getByText("Header", { exact: true }).click();
    await win.keyboard.press("Control+d");
    await expect.poll(() => Object.keys(design("checkout.lamsa.json").nodes).length).toBe(before + 3);
  });

  it("validates cleanly after all the edits", () => {
    const result = spawnSync(process.execPath, [CLI, "--json", "validate"], { cwd: canvasRoot, encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: 0 });
  });
});
