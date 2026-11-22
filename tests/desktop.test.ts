import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyExample } from "./helpers.js";

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
    copyExample(root);
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
    await expect.poll(() => gap.inputValue()).toBe("{spacing.2}");
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

  it("counts problems on the Files tab while a design file is invalid, wherever the tab is docked", async () => {
    const file = join(root, "designs/components.lamsa.json");
    const good = readFileSync(file, "utf8");
    const filesTab = page.locator('[data-panel-tab="files"]');
    const badge = page.getByTestId("files-tab-badge");
    expect(await badge.count()).toBe(0);
    expect(await filesTab.getAttribute("aria-label")).toBe("Files");

    writeFileSync(file, good.slice(0, 40));
    await page.getByTestId("dock-left").getByTestId("files-tab-badge").waitFor();
    // The broken file itself, plus the errors its loss causes in files that use its components.
    const count = Number(await badge.textContent());
    expect(count).toBeGreaterThanOrEqual(1);
    expect(await filesTab.getAttribute("aria-label")).toBe(`Files · ${count} problem${count === 1 ? "" : "s"}`);

    await filesTab.focus();
    await page.keyboard.press("Shift+F10");
    await page.getByTestId("panel-tab-menu").locator('[data-dock-target="right"]').click();
    await page.getByTestId("dock-right").getByTestId("files-tab-badge").waitFor();
    expect(await page.getByTestId("dock-left").getByTestId("files-tab-badge").count()).toBe(0);

    writeFileSync(file, good);
    await badge.waitFor({ state: "detached" });
    expect(await filesTab.getAttribute("aria-label")).toBe("Files");
    await page.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+Alt+0");
    await page.getByTestId("dock-left").locator('[data-panel-tab="files"]').waitFor();
  });

  it("shows one error toast while saves keep failing, and clears it once a save goes through", async () => {
    const designs = join(root, "designs");
    const failed = page.getByTestId("toasts").locator(".toast-danger", { hasText: "Couldn't save" });
    await page.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const padding = page.getByTestId("properties-panel").locator(".field", { hasText: /^padding$/ }).locator("input").first();
    // Saves write a temp file beside the design and rename it over, so a read-only folder makes them fail.
    chmodSync(designs, 0o555);
    try {
      for (const value of ["9", "10", "11"]) {
        await padding.fill(value);
        await padding.press("Enter");
      }
      await failed.waitFor();
      await page.waitForTimeout(500);
      expect(await failed.count()).toBe(1);
      expect(await failed.textContent()).toContain("permission denied");
    } finally {
      chmodSync(designs, 0o755);
    }
    await padding.fill("12");
    await padding.press("Enter");
    await failed.waitFor({ state: "detached" });
    await expect.poll(() => readDesign("checkout.lamsa.json").nodes.ddPB6Wpj?.style).toMatchObject({ padding: 12 });
  });

  it("shows the token adapter, count and source in the project menu", async () => {
    await page.getByTestId("project-menu").click();
    const line = page.getByTestId("project-tokens");
    await expect.poll(() => line.textContent()).toMatch(/shadcn-tailwind4 · [1-9]\d* tokens/);
    expect(await line.textContent()).toContain("app/globals.css");
    await page.keyboard.press("Escape");
    await page.getByTestId("project-menu-list").waitFor({ state: "detached" });
  });

  it("swaps the light/dark switch for a 'Light only' label while the token CSS has no dark block", async () => {
    const css = join(root, "app/globals.css");
    const withDark = readFileSync(css, "utf8");
    const darkBlock = /\n\.dark \{[^}]*\}\n/;
    expect(withDark).toMatch(darkBlock);
    await expect.poll(() => page.getByTestId("canvas-mode-toggle").count()).toBe(1);
    expect(await page.getByTestId("canvas-mode-label").count()).toBe(0);

    writeFileSync(css, withDark.replace(darkBlock, "\n"));
    await page.getByTestId("canvas-mode-label").waitFor({ state: "attached" });
    expect(await page.getByTestId("canvas-mode-toggle").count()).toBe(0);
    expect(await page.locator(".bar-view .segmented").count()).toBe(0);
    expect(await page.getByTestId("canvas-mode-label").textContent()).toContain("Light only");
    expect(await page.locator(".bar-view .tip").first().textContent()).toContain("Add a .dark block to app/globals.css");

    writeFileSync(css, withDark);
    await page.getByTestId("canvas-mode-toggle").waitFor({ state: "attached" });
    expect(await page.getByTestId("canvas-mode-label").count()).toBe(0);
  });

  it("keeps the tools centred without overlaps as the window narrows: the view bar drops its labels, then folds into More", async () => {
    const resize = (width: number) =>
      app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 800), width);
    // A long project name is the widest the project bar gets before its name truncates.
    await page.locator(".project-name").evaluate((element) => (element.textContent = "checkout-redesign-2026-final-review"));
    const folded = new Set<boolean>();
    for (let width = 800; width <= 1440; width += 4) {
      await resize(width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      const measured = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const topbar = box(".topbar");
        const [project, tools, view] = [box(".bar-project"), box(".bar-tools"), box(".bar-view")];
        const toolsCentre = tools.left + tools.width / 2;
        return {
          fits: project.right <= tools.left && tools.right <= view.left && project.left >= topbar.left && view.right <= topbar.right + 0.5,
          centred: Math.abs(toolsCentre - (topbar.left + topbar.width / 2)) < 1,
          compact: document.querySelector('[data-testid="view-more"]')!.getBoundingClientRect().width > 0,
        };
      });
      expect(measured.fits, `bars overlap at ${width}px`).toBe(true);
      expect(measured.centred, `tools off-centre at ${width}px`).toBe(true);
      folded.add(measured.compact);
    }
    expect([...folded].sort()).toEqual([false, true]);

    await resize(820);
    await page.getByTestId("view-more").click();
    await page.getByTestId("view-more-menu").getByText("Keyboard shortcuts").click();
    await page.getByTestId("shortcuts-help").waitFor();
    await page.keyboard.press("Escape");
    await resize(1440);
  });

  it("resizes the left panel by its edge within limits, remembers it, and resets on double-click", async () => {
    const panel = page.getByTestId("dock-left");
    const storedLeft = () => page.evaluate(() => JSON.parse(localStorage.getItem("lamsa.panelLayout") ?? "{}").left?.size ?? null);
    const handle = page.getByTestId("left-panel-resize");
    const widthOf = () => panel.evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const before = await widthOf();
    const drag = async (dx: number) => {
      const box = (await handle.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 5 });
    };

    await drag(60);
    await expect.poll(() => page.getByTestId("left-panel-width").textContent()).toContain(`${before + 60} px`);
    await page.mouse.up();
    expect(await widthOf()).toBe(before + 60);
    expect(await storedLeft()).toBe(before + 60);

    await drag(1000);
    await page.mouse.up();
    expect(await widthOf()).toBe(480);
    // The floor is what the tab strip needs with its longest label ("Components") open, so it never clips.
    const activeTab = await panel.locator('[role="tab"][aria-selected="true"]').getAttribute("data-panel-tab");
    await panel.locator('[data-panel-tab="components"]').click();
    await drag(-1000);
    await expect.poll(() => page.getByTestId("left-panel-width").textContent()).toMatch(/^(\d+) px · \1–480$/);
    await page.mouse.up();
    const floor = await widthOf();
    expect(floor).toBeGreaterThan(200);
    const strip = () =>
      panel.locator('[role="tablist"]').evaluate((element) => {
        const label = element.querySelector<HTMLElement>('[data-panel-tab="components"] .tab-label > span')!;
        return { overflows: element.scrollWidth > element.clientWidth, clipped: label.scrollWidth > label.clientWidth };
      });
    await expect.poll(strip).toEqual({ overflows: false, clipped: false });
    // A narrower window shrinks the default widths, but not below the floor either.
    const resize = (width: number) =>
      app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size, 800), width);
    await handle.dblclick();
    await resize(1000);
    await expect.poll(widthOf).toBe(floor);
    await resize(1440);
    await panel.locator(`[data-panel-tab="${activeTab}"]`).click();

    await handle.dblclick();
    await expect.poll(widthOf).toBe(before);
    expect(await storedLeft()).toBeNull();
  });

  it("does not scroll the layers of a shallow project sideways, and keeps row toggles in place", async () => {
    await page.getByTestId("layers-panel").locator(".layer-row").first().waitFor();
    const layout = await page.getByTestId("layers-panel").locator(".panel-body").evaluate((scroller) => {
      const right = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
      const trails = [...scroller.querySelectorAll(".layer-trail")].map((trail) => Math.round(right - trail.getBoundingClientRect().right));
      return { overflow: scroller.scrollWidth - scroller.clientWidth, trails: [...new Set(trails)] };
    });
    expect(layout.overflow).toBe(0);
    expect(layout.trails).toEqual([6]);
  });
});

describe("desktop editor canvas", () => {
  let canvasRoot: string;
  let canvasApp: ElectronApplication;
  let win: Page;

  const design = (file: string) => JSON.parse(readFileSync(join(canvasRoot, "designs", file), "utf8")) as { nodes: Record<string, Record<string, unknown>> };

  beforeAll(async () => {
    canvasRoot = mkdtempSync(join(tmpdir(), "lamsa-canvas-"));
    copyExample(canvasRoot);
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

  it("shows frames as bitmaps when zoomed far out, which still hover and select, and live again zoomed in", async () => {
    await win.keyboard.press("Escape");
    const zoom = async () => Number.parseInt((await win.locator(".zoom .ghost-btn").textContent()) ?? "", 10);
    const wheel = async (deltaY: number) => {
      await win.mouse.move(800, 500);
      await win.keyboard.down("Control");
      await win.mouse.wheel(0, deltaY);
      await win.keyboard.up("Control");
      await win.waitForTimeout(50);
    };
    let notches = 0;
    while ((await zoom()) >= 20 && notches < 30) {
      await wheel(100);
      notches++;
    }
    await expect.poll(() => win.locator(".frame-slot.shows-bitmap").count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const bitmap = win.locator(".frame-slot.shows-bitmap .frame-bitmap").first();
    const box = (await bitmap.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => win.locator(".ov-hover").count()).toBe(1);
    await win.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The frame, or the layer in it under the pointer when the frame was already entered.
    await expect.poll(() => win.locator(".ov-selection").count()).toBe(1);
    const selected = (await win.locator(".ov-selection").boundingBox())!;
    expect(selected.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(selected.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(selected.x + selected.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(selected.y + selected.height).toBeLessThanOrEqual(box.y + box.height + 1);
    for (let i = 0; i < notches; i++) await wheel(-100);
    await expect.poll(() => win.locator(".frame-slot.shows-bitmap").count()).toBe(0);
    await win.keyboard.press("Escape");
  });

  it("validates cleanly after all the edits", () => {
    const result = spawnSync(process.execPath, [CLI, "--json", "validate"], { cwd: canvasRoot, encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: 0 });
  });
});

describe("desktop editor selection and moving", () => {
  let selRoot: string;
  let selApp: ElectronApplication;
  let win: Page;

  const nodes = (file = "checkout.lamsa.json") =>
    (JSON.parse(readFileSync(join(selRoot, "designs", file), "utf8")) as { nodes: Record<string, Record<string, unknown>> }).nodes;
  const childOrder = (parentId: string) =>
    Object.entries(nodes())
      .filter(([, n]) => n.parentId === parentId)
      .sort((a, b) => ((a[1].index as string) < (b[1].index as string) ? -1 : 1))
      .map(([id]) => id);
  const selected = () => win.$$eval(".layer-row.is-selected .layer-name", (rows) => rows.map((row) => row.textContent));
  const rect = (id: string) =>
    win.evaluate((nodeId) => {
      for (const host of document.querySelectorAll(".frame-host")) {
        const el = host.shadowRoot?.querySelector(`[data-node-id="${nodeId}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
        }
      }
      throw new Error(`no element for ${nodeId}`);
    }, id);
  const clickEmpty = () => win.mouse.click(800, 700);

  beforeAll(async () => {
    selRoot = mkdtempSync(join(tmpdir(), "lamsa-select-"));
    copyExample(selRoot);
    selApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", selRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await selApp.firstWindow();
    await win.getByTestId("layers-panel").waitFor();
    await win.waitForTimeout(400);
  }, 60_000);

  afterAll(async () => {
    await selApp?.close();
  });

  it("keeps a moved frame where it was dropped, even the leftmost one in its file", async () => {
    const before = await rect("08JQi0tV");
    await win.mouse.move(before.x + 8, before.y + before.h - 8);
    await win.mouse.down();
    await win.mouse.move(before.x + 108, before.y + before.h + 42, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => nodes()["08JQi0tV"]?.x).not.toBe(0);
    const after = await rect("08JQi0tV");
    expect(Math.round(after.x - before.x)).toBe(100);
    expect(Math.round(after.y - before.y)).toBe(50);
  });

  it("keeps the selection outline on the frame while dragging it", async () => {
    const label = (await win.locator('.frame-label[data-label-for="Inp00001"]').boundingBox())!;
    await win.mouse.click(label.x + 4, label.y + 4);
    await win.mouse.move(label.x + 4, label.y + 4);
    await win.mouse.down();
    await win.mouse.move(label.x + 124, label.y + 64, { steps: 10 });
    await win.waitForTimeout(100);
    const outline = (await win.locator(".ov-selection").boundingBox())!;
    const frame = await rect("Inp00001");
    await win.mouse.up();
    expect(Math.abs(outline.x - frame.x)).toBeLessThan(2);
    expect(Math.abs(outline.y - frame.y)).toBeLessThan(2);
  });

  it("selects one level at a time: click picks the screen's child, double-click goes deeper, Escape goes up", async () => {
    await clickEmpty();
    const email = await rect("63qmJlTo");
    await win.mouse.click(email.cx, email.cy);
    await expect.poll(selected).toEqual(["Form"]);
    await win.mouse.dblclick(email.cx, email.cy);
    await expect.poll(selected).toEqual(["Email field"]);
    const card = await rect("qrAB98yG");
    await win.mouse.click(card.cx, card.cy);
    await expect.poll(selected).toEqual(["Card field"]);
    await win.keyboard.down("Shift");
    await win.mouse.click(email.cx, email.cy);
    await win.keyboard.up("Shift");
    await expect.poll(selected).toEqual(["Email field", "Card field"]);
    await win.mouse.click(email.cx, email.cy);
    await expect.poll(selected).toEqual(["Email field"]);
    await win.keyboard.press("Escape");
    await expect.poll(selected).toEqual(["Form"]);
    await clickEmpty();
    await win.keyboard.down("Control");
    await win.mouse.click(email.cx, email.cy);
    await win.keyboard.up("Control");
    await expect.poll(selected).toEqual(["Email field"]);
    await win.keyboard.down("Control");
    await win.keyboard.down("Shift");
    await win.mouse.click(card.cx, card.cy);
    await win.keyboard.up("Shift");
    await win.keyboard.up("Control");
    await expect.poll(selected).toEqual(["Email field", "Card field"]);
  });

  it("reorders by dragging, moves layers into another frame, and ignores drops on empty canvas", async () => {
    await clickEmpty();
    const email = await rect("63qmJlTo");
    const card = await rect("qrAB98yG");
    await win.keyboard.down("Control");
    await win.mouse.click(card.cx, card.cy);
    await win.keyboard.up("Control");
    await win.mouse.move(card.cx, card.cy);
    await win.mouse.down();
    await win.mouse.move(email.cx, email.y + 3, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => childOrder("7qOxePB7").slice(-2)).toEqual(["qrAB98yG", "63qmJlTo"]);

    const moved = await rect("qrAB98yG");
    const summary = await rect("ddPB6Wpj");
    await win.mouse.move(moved.cx, moved.cy);
    await win.mouse.down();
    await win.mouse.move(summary.x + 4, summary.y + 2, { steps: 10 });
    await win.mouse.up();
    await expect.poll(() => nodes().qrAB98yG?.parentId).toBe("ddPB6Wpj");

    const rootOrder = childOrder("08JQi0tV");
    const header = await rect("Rwwc3Sdq");
    await win.mouse.move(header.cx, header.cy);
    await win.mouse.down();
    await win.mouse.move(800, 650, { steps: 8 });
    await win.mouse.up();
    await win.waitForTimeout(300);
    expect(childOrder("08JQi0tV")).toEqual(rootOrder);
  });

  it("marquee picks enclosed frames, or the children it touches inside a frame", async () => {
    await clickEmpty();
    const button = await rect("Btn00001");
    await win.mouse.move(button.x - 20, button.y - 30);
    await win.mouse.down();
    await win.mouse.move(button.x + button.w + 20, button.y + button.h + 20, { steps: 6 });
    await win.mouse.up();
    await expect.poll(selected).toEqual(["Button"]);

    await clickEmpty();
    const pay = await rect("QkpksTeC");
    await win.mouse.move(pay.x + pay.w + 40, pay.y + pay.h + 30);
    await win.mouse.down();
    await win.mouse.move(pay.cx, pay.cy, { steps: 6 });
    await win.mouse.up();
    await expect.poll(selected).toEqual(["Pay button"]);
  });

  it("opens property menus above the panels and keeps them open until a pick, Escape, or an outside click", async () => {
    await win.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const props = win.getByTestId("properties-panel");
    await props.getByLabel("Choose display").click();
    await win.getByTestId("options-menu").getByText("grid", { exact: true }).click();
    await expect.poll(() => nodes().ddPB6Wpj?.style).toMatchObject({ display: "grid" });

    await props.locator(".panel-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
    await props.getByLabel(/Pick a token for/).last().click();
    const picker = win.getByTestId("token-picker");
    const box = (await picker.boundingBox())!;
    const height = await win.evaluate(() => window.innerHeight);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await win.mouse.move(400, 100);
    await win.waitForTimeout(200);
    expect(await picker.isVisible()).toBe(true);
    await win.keyboard.press("Escape");
    await expect.poll(() => picker.count()).toBe(0);
  });

  it("autocompletes options, tokens, and new properties while typing", async () => {
    await win.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const props = win.getByTestId("properties-panel");
    await props.locator(".panel-body").evaluate((el) => (el.scrollTop = 0));
    const position = props.locator(".field", { hasText: /^position/ }).locator("input");
    await position.click();
    await position.fill("abs");
    await win.getByTestId("autocomplete").getByText("absolute", { exact: true }).waitFor();
    await position.press("Enter");
    await expect.poll(() => nodes().ddPB6Wpj?.style).toMatchObject({ position: "absolute" });

    const background = props.locator(".field", { hasText: /^background/ }).locator("input");
    await background.click();
    await background.fill("{mut");
    await win.getByTestId("autocomplete").getByText("{color.muted}", { exact: true }).waitFor();
    await background.press("Enter");
    await expect.poll(() => nodes().ddPB6Wpj?.style).toMatchObject({ background: "{color.muted}" });

    const add = win.getByTestId("add-property");
    await add.click();
    await add.fill("max-wi");
    await add.press("Enter");
    await expect.poll(() => add.inputValue()).toBe("max-width: ");
    await add.pressSequentially("{spacing.1");
    await win.getByTestId("autocomplete").getByText("{spacing.16}", { exact: true }).click();
    await expect.poll(() => nodes().ddPB6Wpj?.style).toMatchObject({ "max-width": "{spacing.16}" });
  });

  it("shows a check after copying a node ID", async () => {
    await win.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const props = win.getByTestId("properties-panel");
    await props.locator(".panel-body").evaluate((el) => (el.scrollTop = 0));
    await props.getByLabel("Copy node ID").click();
    await props.getByLabel("Copied").waitFor();
    expect(await win.evaluate(() => navigator.clipboard.readText())).toBe("ddPB6Wpj");
  });

  it("zooms one ~1.2x step per mouse-wheel notch", async () => {
    const zoom = async () => Number.parseInt((await win.locator(".zoom .ghost-btn").textContent()) ?? "", 10);
    const start = await zoom();
    await win.mouse.move(800, 500);
    await win.keyboard.down("Control");
    await win.mouse.wheel(0, 100);
    await win.keyboard.up("Control");
    await expect.poll(zoom).toBe(Math.round(start / 1.2));
    await win.keyboard.down("Control");
    await win.mouse.wheel(0, -100);
    await win.keyboard.up("Control");
    await expect.poll(zoom).toBe(start);
  });

  it("keeps frame labels within their frame's width, and hides them when the frame is too narrow or too close below another; file names shrink to an icon", async () => {
    const zoomBy = async (notches: number) => {
      await win.mouse.move(800, 500);
      await win.keyboard.down("Control");
      for (let i = 0; i < Math.abs(notches); i++) await win.mouse.wheel(0, notches > 0 ? 100 : -100);
      await win.keyboard.up("Control");
      await win.waitForTimeout(100);
    };
    const labels = () =>
      win.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".frame-label")]
          .filter((label) => !label.matches(":hover") && !label.classList.contains("is-hovered") && !label.classList.contains("is-selected"))
          .map((label) => {
            const host = document.querySelector<HTMLElement>(`[data-root-id="${label.dataset.labelFor}"]`)!;
            const box = label.getBoundingClientRect();
            const coversAnotherFrame = [...document.querySelectorAll<HTMLElement>("[data-root-id]")].some((other) => {
              if (other === host) return false;
              const rect = other.getBoundingClientRect();
              return rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
            });
            return {
              label: label.querySelector(".frame-label-name")!.getBoundingClientRect().width,
              frame: host.getBoundingClientRect().width,
              hidden: getComputedStyle(label).visibility === "hidden",
              coversAnotherFrame,
            };
          }),
      );
    await win.keyboard.press("Escape");
    await zoomBy(12);
    const shown = await labels();
    expect(shown.length).toBeGreaterThan(0);
    for (const { label, frame, hidden, coversAnotherFrame } of shown) {
      if (frame < 40) expect(hidden).toBe(true);
      if (hidden) continue;
      expect(label).toBeLessThanOrEqual(frame + 1);
      expect(coversAnotherFrame).toBe(false);
    }
    expect(shown.some((entry) => entry.hidden)).toBe(true);
    const fileLabels = await win.evaluate(() => {
      const all = [...document.querySelectorAll<HTMLElement>(".file-label")];
      const shownName = (label: HTMLElement) => getComputedStyle(label.querySelector(".file-label-name")!).display !== "none";
      const resting = all.filter((label) => !label.classList.contains("is-selected"));
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        count: all.length,
        withIcon: all.filter((label) => (label.querySelector(".file-label-icon")?.getBoundingClientRect().width ?? 0) > 0).length,
        cramped: all.filter((label) => label.classList.contains("is-cramped")).length,
        crampedShowingName: resting.filter((label) => label.classList.contains("is-cramped") && shownName(label)).length,
        overlapping: resting
          .filter(shownName)
          .filter((label) => resting.some((other) => other !== label && overlaps(label.getBoundingClientRect(), other.getBoundingClientRect()))).length,
      };
    });
    expect(fileLabels.count).toBeGreaterThan(1);
    expect(fileLabels.withIcon).toBe(fileLabels.count);
    expect(fileLabels.cramped).toBeGreaterThan(0);
    expect(fileLabels.crampedShowingName).toBe(0);
    expect(fileLabels.overlapping).toBe(0);
    await zoomBy(-12);
  });

  it("closes an open menu on an outside click without changing the selection", async () => {
    await win.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    const props = win.getByTestId("properties-panel");
    await props.locator(".panel-body").evaluate((el) => (el.scrollTop = 0));
    await props.getByLabel("Pick a token for gap").click();
    await win.getByTestId("token-picker").waitFor();
    await win.mouse.click(800, 700);
    await expect.poll(() => win.getByTestId("token-picker").count()).toBe(0);
    expect(await selected()).toEqual(["Summary"]);

    const summary = await rect("ddPB6Wpj");
    await win.mouse.click(summary.cx, summary.cy, { button: "right" });
    await win.getByTestId("context-menu").waitFor();
    await win.mouse.click(800, 700);
    await expect.poll(() => win.getByTestId("context-menu").count()).toBe(0);
    expect(await selected()).toEqual(["Summary"]);
  });

  it("marks layers hidden by a component's default props and zooms to something visible", async () => {
    const layers = win.getByTestId("layers-panel");
    const lock = layers.locator(".layer-row", { has: win.locator(".layer-name", { hasText: /^lock$/ }) }).first();
    expect(await lock.getAttribute("class")).toContain("is-hidden");
    const eye = lock.getByLabel("Hidden by a prop");
    expect(await eye.isDisabled()).toBe(true);
    await lock.locator(".layer-name").click();
    const before = JSON.stringify(nodes("components.lamsa.json").BtnIcon1);
    await win.keyboard.press("Control+Shift+H");
    await win.waitForTimeout(300);
    expect(JSON.stringify(nodes("components.lamsa.json").BtnIcon1)).toBe(before);
    await lock.dblclick();
    const zoom = await win.locator(".zoom .ghost-btn").textContent();
    expect(Number.parseInt(zoom ?? "", 10)).toBeGreaterThan(0);
  });

  it("toggles layers with Ctrl-click and selects a range with Shift-click in the layers panel", async () => {
    const layers = win.getByTestId("layers-panel");
    await layers.getByText("Form", { exact: true }).click();
    await layers.getByText("Header", { exact: true }).click({ modifiers: ["Control"] });
    await expect.poll(selected).toEqual(["Header", "Form"]);
    await layers.getByText("Form", { exact: true }).click({ modifiers: ["Control"] });
    await expect.poll(selected).toEqual(["Header"]);
    await layers.getByText("Header", { exact: true }).click();
    await layers.getByText("Summary", { exact: true }).click({ modifiers: ["Shift"] });
    await expect.poll(async () => (await selected())[0]).toBe("Header");
    await expect.poll(async () => (await selected()).at(-1)).toBe("Summary");
    expect(await selected()).toContain("Form");
    expect(await selected()).toContain("Checkout");
  });

  it("previews a main component's variants without saving, and can make one the default", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Button$/ }).first().click();
    const props = win.getByTestId("properties-panel");
    const fileBefore = JSON.stringify(nodes("components.lamsa.json"));
    expect((await rect("BtnIcon1")).w).toBe(0);
    await props.getByRole("group", { name: "icon variant" }).getByText("true", { exact: true }).click();
    await expect.poll(async () => (await rect("BtnIcon1")).w).toBeGreaterThan(0);
    const outlineWidth = () => win.locator(".ov-selection").first().evaluate((el) => el.getBoundingClientRect().width);
    await expect.poll(async () => Math.round((await outlineWidth()) - (await rect("Btn00001")).w)).toBe(0);
    await props.getByRole("group", { name: "variant variant" }).getByText("outline", { exact: true }).click();
    expect(JSON.stringify(nodes("components.lamsa.json"))).toBe(fileBefore);
    await props.getByText("Make default").last().click();
    await expect.poll(() => (nodes("components.lamsa.json").Btn00001 as { component: { props: { variant: { default: string } } } }).component.props.variant.default).toBe("outline");
  });

  it("ignores a click on a resize handle and resizes to whole pixels when dragged", async () => {
    await win.getByTestId("layers-panel").getByText("Summary", { exact: true }).click();
    await win.mouse.move(700, 450);
    await win.keyboard.press("Shift+Digit2");
    await win.waitForTimeout(200);
    const before = JSON.stringify(nodes().ddPB6Wpj);
    const handle = (await win.locator(".ov-handle-se").boundingBox())!;
    await win.mouse.click(handle.x + 4, handle.y + 4);
    await win.waitForTimeout(300);
    expect(JSON.stringify(nodes().ddPB6Wpj)).toBe(before);

    await win.mouse.move(handle.x + 4, handle.y + 4);
    await win.mouse.down();
    await win.mouse.move(handle.x + 17, handle.y + 11, { steps: 4 });
    await win.mouse.up();
    await expect.poll(() => JSON.stringify(nodes().ddPB6Wpj)).not.toBe(before);
    const style = nodes().ddPB6Wpj!.style as { width: number; height: number };
    expect(Number.isInteger(style.width)).toBe(true);
    expect(Number.isInteger(style.height)).toBe(true);
  });

  it("opens the layer menu on right-click in the layers panel", async () => {
    await clickEmpty();
    const row = win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Form$/ });
    await row.click({ button: "right" });
    const menu = win.getByTestId("context-menu");
    await menu.waitFor();
    expect(await selected()).toEqual(["Form"]);
    const box = (await menu.boundingBox())!;
    const rowBox = (await row.boundingBox())!;
    expect(Math.abs(box.y - (rowBox.y + rowBox.height / 2))).toBeLessThan(40);
    const before = childOrder("08JQi0tV").length;
    await menu.getByText("Duplicate").click();
    await expect.poll(() => childOrder("08JQi0tV").length).toBe(before + 1);
  });

  it("shows only the menu actions that fit the selection", async () => {
    const spot = await win.evaluate(() => {
      for (let y = 120; y < innerHeight - 80; y += 20) {
        for (let x = 300; x < innerWidth - 340; x += 20) {
          const top = document.elementsFromPoint(x, y)[0];
          if (top?.classList.contains("canvas") || top?.classList.contains("canvas-grid") || top?.classList.contains("world")) return { x, y };
        }
      }
      throw new Error("no empty canvas spot");
    });
    await win.mouse.click(spot.x, spot.y);
    await expect.poll(selected).toEqual([]);
    await win.mouse.click(spot.x, spot.y, { button: "right" });
    const menu = win.getByTestId("context-menu");
    await menu.waitFor();
    const empty = await menu.locator(".menu-item").allTextContents();
    expect(empty.some((t) => t.startsWith("Paste"))).toBe(true);
    expect(empty.some((t) => t.startsWith("Delete") || t.startsWith("Copy"))).toBe(false);
    await win.keyboard.press("Escape");

    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Pay button$/ }).click();
    await win.keyboard.press("Shift+Digit2");
    await win.waitForTimeout(200);
    const pay = await rect("QkpksTeC");
    await win.mouse.click(pay.cx, pay.cy, { button: "right" });
    await menu.waitFor();
    const forInstance = await menu.locator(".menu-item").allTextContents();
    expect(forInstance.some((t) => t.startsWith("Go to main component"))).toBe(true);
    expect(forInstance.some((t) => t.startsWith("Delete"))).toBe(true);
    await win.keyboard.press("Escape");
  });

  it("selects a main component as a whole until you double-click into it", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Input$/ }).first().click();
    await win.keyboard.press("Shift+Digit2");
    await win.waitForTimeout(200);
    await clickEmpty();
    const label = await rect("InpLabel");
    await win.mouse.click(label.cx, label.cy);
    await expect.poll(selected).toEqual(["Input"]);
    await win.mouse.dblclick(label.cx, label.cy);
    await expect.poll(selected).toEqual(["Label"]);
  });

  it("picks icons from a searchable list and autocompletes typed icon names", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^chevron-left$/ }).click();
    await win.getByLabel("Browse icons").click();
    const picker = win.getByTestId("icon-picker");
    await picker.waitFor();
    await win.keyboard.type("arrow-lef");
    await picker.getByText("arrow-left", { exact: true }).click();
    await expect.poll(() => nodes().HjlWoojj?.icon).toBe("arrow-left");

    const input = win.getByTestId("icon-input");
    await expect.poll(() => input.inputValue()).toBe("arrow-left");
    await input.fill("chevron-ri");
    await win.getByTestId("autocomplete").getByText("chevron-right", { exact: true }).waitFor();
    await input.press("Enter");
    await expect.poll(() => nodes().HjlWoojj?.icon).toBe("chevron-right");
  });

  it("hides and shows layers from the layers panel and the keyboard", async () => {
    const layers = win.getByTestId("layers-panel");
    const summaryRow = layers.locator(".layer-row", { has: win.locator(".layer-name", { hasText: /^Summary$/ }) });
    await summaryRow.hover();
    await summaryRow.getByLabel("Hide layer").click();
    await expect.poll(() => nodes().ddPB6Wpj?.hidden).toBe(true);
    await summaryRow.locator(".layer-name").click();
    await win.keyboard.press("Control+Shift+H");
    await expect.poll(() => nodes().ddPB6Wpj?.hidden).toBeUndefined();
  });

  it("locks a layer so canvas clicks pass through it to its parent", async () => {
    const layers = win.getByTestId("layers-panel");
    const payRow = layers.locator(".layer-row", { has: win.locator(".layer-name", { hasText: /^Pay button$/ }) });
    await payRow.hover();
    await payRow.getByLabel("Lock layer").click();
    await expect.poll(() => nodes().QkpksTeC?.locked).toBe(true);

    await layers.locator(".layer-name", { hasText: /^Checkout · Default$/ }).click();
    await win.keyboard.press("Shift+Digit2");
    await win.waitForTimeout(200);
    await layers.locator(".layer-name", { hasText: /^Header$/ }).click();
    const pay = await rect("QkpksTeC");
    await win.mouse.click(pay.cx, pay.cy);
    await expect.poll(selected).toEqual(["Checkout · Default"]);
    expect(await win.locator(".ov-handle").count()).toBeGreaterThan(0);

    await payRow.locator(".layer-name").click();
    await expect.poll(selected).toEqual(["Pay button"]);
    expect(await win.locator(".ov-handle").count()).toBe(0);
    await win.keyboard.press("Control+Shift+L");
    await expect.poll(() => nodes().QkpksTeC?.locked).toBeUndefined();
  });

  it("inserts an icon picked from the toolbar into the selected frame", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Header$/ }).click();
    await win.getByLabel("Icon", { exact: true }).click();
    await win.getByTestId("insert-icon-picker").waitFor();
    await win.keyboard.type("star");
    await win.keyboard.press("Enter");
    await expect.poll(() => Object.values(nodes()).filter((n) => n.type === "icon" && n.parentId === "Rwwc3Sdq" && n.icon === "star").length).toBe(1);
  });

  it("nudges a top-level frame with the arrow keys", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Button$/ }).first().click();
    await expect.poll(selected).toEqual(["Button"]);
    const start = nodes("components.lamsa.json").Btn00001!;
    await win.keyboard.press("ArrowRight");
    await win.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => [nodes("components.lamsa.json").Btn00001?.x, nodes("components.lamsa.json").Btn00001?.y]).toEqual([
      (start.x as number) + 1,
      (start.y as number) + 10,
    ]);
  });

  it("pastes a copied component with its props pointing at the pasted layers", async () => {
    await win.getByTestId("layers-panel").locator(".layer-name", { hasText: /^Button$/ }).first().click();
    const before = Object.keys(nodes("components.lamsa.json")).length;
    await win.keyboard.press("Control+c");
    await win.keyboard.press("Control+v");
    await expect.poll(() => Object.keys(nodes("components.lamsa.json")).length).toBe(before + 3);
    const result = spawnSync(process.execPath, [CLI, "--json", "validate"], { cwd: selRoot, encoding: "utf8" });
    expect(JSON.parse(result.stdout)).toMatchObject({ errors: 0 });
  });

  it("groups top-level frames into a new frame that keeps their canvas positions", async () => {
    const file = join(selRoot, "designs", "checkout.lamsa.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { nodes: Record<string, unknown> };
    data.nodes.TopA0001 = { type: "frame", name: "Top A", x: 0, y: 1200, style: { width: 120, height: 80, background: "#eee" } };
    data.nodes.TopB0001 = { type: "frame", name: "Top B", x: 200, y: 1260, style: { height: 40, padding: 8 } };
    data.nodes.TopBText1 = { type: "text", parentId: "TopB0001", index: "a0", content: "Second" };
    writeFileSync(file, JSON.stringify(data, null, 2));
    const layers = win.getByTestId("layers-panel");
    await layers.getByText("Top A", { exact: true }).click();
    await layers.getByText("Top B", { exact: true }).click({ modifiers: ["Control"] });
    await expect.poll(selected).toEqual(["Top A", "Top B"]);
    const beforeA = await rect("TopA0001");
    const beforeB = await rect("TopB0001");
    await win.keyboard.press("Control+g");
    await expect.poll(() => nodes().TopA0001?.parentId).toBeTruthy();
    const after = nodes();
    const groupId = after.TopA0001!.parentId as string;
    expect(after[groupId]).toMatchObject({ type: "frame", x: 0, y: 1200, style: { position: "relative", height: 100 } });
    expect(after.TopA0001).not.toHaveProperty("x");
    expect(after.TopA0001!.style).toMatchObject({ position: "absolute", left: 0, top: 0, width: 120 });
    expect(after.TopB0001!.style).toMatchObject({ position: "absolute", left: 200, top: 60 });
    expect(typeof (after.TopB0001!.style as Record<string, unknown>).width).toBe("number");
    await expect.poll(async () => {
      const [a, b] = [await rect("TopA0001"), await rect("TopB0001")];
      return [a.x - beforeA.x, a.y - beforeA.y, b.x - beforeB.x, b.y - beforeB.y].map((d) => Math.round(d));
    }).toEqual([0, 0, 0, 0]);
  });

  it("closes the component picker from its toolbar button, an outside click, or Escape", async () => {
    const button = win.getByRole("button", { name: "Component", exact: true });
    const picker = win.getByTestId("component-picker");
    await button.click();
    await picker.waitFor();
    await button.click();
    await picker.waitFor({ state: "detached" });
    await button.click();
    await picker.waitFor();
    await clickEmpty();
    await picker.waitFor({ state: "detached" });
    await button.click();
    await picker.waitFor();
    await win.keyboard.press("Escape");
    await picker.waitFor({ state: "detached" });
  });

  it("drags a selected frame from over its children, and a plain click still selects the child", async () => {
    const file = join(selRoot, "designs", "checkout.lamsa.json");
    const data = JSON.parse(readFileSync(file, "utf8")) as { nodes: Record<string, unknown> };
    data.nodes.Chip0001 = { type: "frame", name: "Chip", x: 0, y: 1500, style: { display: "flex" } };
    data.nodes.ChipText1 = { type: "text", name: "Chip label", parentId: "Chip0001", index: "a0", content: "Fills the chip" };
    writeFileSync(file, JSON.stringify(data, null, 2));
    const layers = win.getByTestId("layers-panel");
    await layers.getByText("Chip", { exact: true }).click();
    await expect.poll(selected).toEqual(["Chip"]);
    await win.keyboard.press("Shift+Digit2");
    await win.waitForTimeout(200);
    const text = await rect("ChipText1");
    await win.mouse.move(text.cx, text.cy);
    await win.mouse.down();
    await win.mouse.move(text.cx + 60, text.cy + 30, { steps: 8 });
    await win.mouse.up();
    await expect.poll(() => nodes().Chip0001?.x as number).toBeGreaterThan(20);
    expect(nodes().ChipText1).toMatchObject({ parentId: "Chip0001" });
    await expect.poll(selected).toEqual(["Chip"]);
    const moved = await rect("ChipText1");
    await win.mouse.click(moved.cx, moved.cy);
    await expect.poll(selected).toEqual(["Chip label"]);
  });

  it("shows flex and grid fields only where they apply", async () => {
    const labels = () =>
      win.getByTestId("properties-panel").locator(".field-label").evaluateAll((els) => els.map((el) => el.textContent?.trim()));
    const layers = win.getByTestId("layers-panel");
    await layers.getByText("Form", { exact: true }).first().click();
    await expect.poll(labels).toEqual(expect.arrayContaining(["flex-direction", "justify-content", "align-items", "gap", "flex"]));
    await layers.getByText("star", { exact: true }).first().click();
    await expect.poll(selected).toEqual(["star"]);
    const shown = await labels();
    expect(shown).toContain("flex");
    for (const label of ["flex-direction", "justify-content", "align-items", "gap"]) expect(shown).not.toContain(label);
  });

  it("closes an open dropdown without also toggling the section header that was clicked", async () => {
    const props = win.getByTestId("properties-panel");
    await win.getByTestId("layers-panel").getByText("Form", { exact: true }).first().click();
    await props.getByRole("button", { name: "Choose overflow" }).click();
    await win.getByTestId("options-menu").waitFor();
    await props.getByRole("button", { name: "Appearance" }).click();
    await win.getByTestId("options-menu").waitFor({ state: "detached" });
    await expect.poll(() => props.locator(".field-label", { hasText: /^overflow$/ }).count()).toBe(1);
  });

  it("explains why layers can't be grouped", async () => {
    const layers = win.getByTestId("layers-panel");
    await layers.locator(".layer-name", { hasText: /^Button$/ }).first().click();
    await layers.locator(".layer-name", { hasText: /^Input$/ }).first().click({ modifiers: ["Control"] });
    await win.keyboard.press("Control+g");
    await expect.poll(() => win.getByTestId("toasts").textContent()).toContain("Main components stay at the top level");
  });
});

describe("desktop editor collapsing layers", () => {
  const TOP_LEVEL = ["08JQi0tV", "Btn00001", "Inp00001"];
  const SUMMARY = "ddPB6Wpj";
  const SUMMARY_ROWS = ["LGEOBLsf", "RSj5HAWw"];
  const SUBTOTAL = "d08HTIyf";
  let collapseRoot: string;
  let collapseApp: ElectronApplication;
  let win: Page;
  let everyRow: string[];
  const layers = () => win.getByTestId("layers-panel");
  const rows = () => win.$$eval('[data-testid="layers-panel"] .layer-row', (list) => list.map((row) => (row as HTMLElement).dataset.layerId));
  const collapseAll = () => layers().getByTestId("collapse-all");
  const twisty = (id: string) => layers().locator(`.layer-row[data-layer-id="${id}"] .twisty`);
  const fileToggle = (path: string) => layers().getByRole("button", { name: new RegExp(`all layers in ${path}$`) });

  beforeAll(async () => {
    collapseRoot = mkdtempSync(join(tmpdir(), "lamsa-collapse-"));
    copyExample(collapseRoot);
    collapseApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", collapseRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await collapseApp.firstWindow();
    await layers().locator(".layer-row").first().waitFor();
    everyRow = (await rows()) as string[];
  }, 60_000);

  afterAll(async () => {
    await collapseApp?.close();
  });

  it("collapses every layer to the top-level frames and expands them all again", async () => {
    expect(everyRow.length).toBeGreaterThan(TOP_LEVEL.length + 10);
    await expect(collapseAll().getAttribute("aria-label")).resolves.toBe("Collapse all layers");
    await collapseAll().click();
    await expect.poll(rows).toEqual(TOP_LEVEL);
    expect(await layers().locator(".layer-file-name").allTextContents()).toEqual(["checkout.lamsa.json", "components.lamsa.json"]);
    expect(await layers().locator(".twisty.is-open").count()).toBe(0);
    await expect(collapseAll().getAttribute("aria-label")).resolves.toBe("Expand all layers");
    await expect(layers().locator(".search-row .tip").textContent()).resolves.toBe("Expand all layers");
    // Keyboard: the button is a plain button, so focus and Enter work.
    await collapseAll().focus();
    await win.keyboard.press("Enter");
    await expect.poll(rows).toEqual(everyRow);
    await expect(collapseAll().getAttribute("aria-label")).resolves.toBe("Collapse all layers");
  });

  it("expands one file's layers from its header and leaves the other file collapsed", async () => {
    await collapseAll().click();
    await expect.poll(rows).toEqual(TOP_LEVEL);
    const header = layers().locator('.layer-file[data-file="designs/components.lamsa.json"]');
    await header.hover();
    await fileToggle("designs/components.lamsa.json").click();
    await expect.poll(rows).toEqual(["08JQi0tV", ...everyRow.slice(everyRow.indexOf("Btn00001"))]);
    await expect(collapseAll().getAttribute("aria-label")).resolves.toBe("Collapse all layers");
    await expect(fileToggle("designs/components.lamsa.json").getAttribute("aria-label")).resolves.toBe("Collapse all layers in designs/components.lamsa.json");
    await expect(fileToggle("designs/checkout.lamsa.json").getAttribute("aria-label")).resolves.toBe("Expand all layers in designs/checkout.lamsa.json");
    await fileToggle("designs/components.lamsa.json").click();
    await expect.poll(rows).toEqual(TOP_LEVEL);
    await collapseAll().click();
    await expect.poll(rows).toEqual(everyRow);
  });

  it("opens or closes a layer and everything inside it with Alt-click on its twisty", async () => {
    await twisty(SUMMARY).click({ modifiers: ["Alt"] });
    await expect.poll(async () => (await rows()).includes(SUMMARY_ROWS[0]!)).toBe(false);
    await twisty(SUMMARY).click();
    await expect.poll(rows).toEqual(expect.arrayContaining(SUMMARY_ROWS));
    expect(await rows()).not.toContain(SUBTOTAL);
    await twisty(SUMMARY).click();
    await expect.poll(async () => (await rows()).includes(SUMMARY_ROWS[0]!)).toBe(false);
    await twisty(SUMMARY).click({ modifiers: ["Alt"] });
    await expect.poll(rows).toEqual(everyRow);
  });

  it("still opens collapsed parents when a layer is selected on the canvas", async () => {
    await collapseAll().click();
    await expect.poll(rows).toEqual(TOP_LEVEL);
    const point = await win.evaluate((id) => {
      for (const host of document.querySelectorAll(".frame-host")) {
        const element = host.shadowRoot?.querySelector(`[data-node-id="${id}"]`);
        if (!element) continue;
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      }
      throw new Error(`no element for ${id}`);
    }, SUBTOTAL);
    await win.keyboard.down("Control");
    await win.mouse.click(point.x, point.y);
    await win.keyboard.up("Control");
    await layers().locator(`.layer-row.is-selected[data-layer-id="${SUBTOTAL}"]`).waitFor();
    expect(await rows()).toEqual(expect.arrayContaining(["08JQi0tV", SUMMARY, "LGEOBLsf", SUBTOTAL]));
    expect(await rows()).toContain("Rwwc3Sdq");
    expect(await rows()).not.toContain("HjlWoojj");
    await win.keyboard.press("Escape");
    await win.keyboard.press("Escape");
  });

  it("keeps filter matches open and applies the buttons to the unfiltered tree", async () => {
    await collapseAll().click();
    await expect.poll(rows).toEqual(TOP_LEVEL);
    const search = layers().locator(".search input");
    await search.fill("Subtotal");
    await expect.poll(rows).toEqual(["08JQi0tV", SUMMARY, "LGEOBLsf", SUBTOTAL]);
    await collapseAll().click();
    await expect.poll(() => collapseAll().getAttribute("aria-label")).toBe("Collapse all layers");
    expect(await rows()).toEqual(["08JQi0tV", SUMMARY, "LGEOBLsf", SUBTOTAL]);
    await search.fill("");
    await expect.poll(rows).toEqual(everyRow);
  });
});

describe("desktop editor animation preview", () => {
  let motionRoot: string;
  let motionApp: ElectronApplication;
  let win: Page;
  const checkout = () => JSON.parse(readFileSync(join(motionRoot, "designs/checkout.lamsa.json"), "utf8")) as { css?: string; nodes: Record<string, Record<string, unknown>> };

  beforeAll(async () => {
    motionRoot = mkdtempSync(join(tmpdir(), "lamsa-motion-"));
    copyExample(motionRoot);
    const design = checkout();
    design.css = "@keyframes rise { from { translate: 0 12px; opacity: 0; } }";
    design.nodes.QkpksTeC!.css = 'transition: scale 150ms ease-out;\n&:hover { scale: 1.05; }\n&[data-state="open"] { scale: 0.9; }';
    design.nodes.Rwwc3Sdq!.css = "animation: rise 300ms ease-out both;";
    design.css += "\n::view-transition-group(hero) { animation-duration: 400ms; }";
    design.nodes["08JQi0tV"]!.css = "view-transition-name: hero;";
    design.nodes.DoneFrm1 = { type: "frame", name: "Checkout · Done", index: "a9", x: 600, y: 0, css: "view-transition-name: hero;", style: { width: 320, height: 200, background: "{color.muted}" } };
    design.nodes.DoneTxt1 = { type: "text", name: "Thanks", parentId: "DoneFrm1", index: "a0", content: "Order placed" };
    writeFileSync(join(motionRoot, "designs/checkout.lamsa.json"), JSON.stringify(design, null, 2));
    motionApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", motionRoot, "--select", "QkpksTeC"],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await motionApp.firstWindow();
    await win.getByTestId("layers-panel").waitFor();
    await win.waitForTimeout(400);
  }, 60_000);

  afterAll(async () => {
    await motionApp?.close();
  });

  it("shows motion at rest on the canvas", async () => {
    const running = await win.evaluate(() =>
      [...document.querySelectorAll(".frame-host")].flatMap((h) => h.shadowRoot?.getAnimations() ?? []).filter((a) => a.playState === "running").length,
    );
    expect(running).toBe(0);
    const hovered = await win.evaluate(() => {
      const host = [...document.querySelectorAll(".frame-host")].find((h) => h.shadowRoot?.querySelector('[data-node-id="QkpksTeC"]'));
      return host?.shadowRoot?.querySelector("style")?.textContent?.includes(":hover");
    });
    expect(hovered).toBe(false);
  });

  it("previews the selected layers from the context menu and forces states on them", async () => {
    await win.getByTestId("layers-panel").locator(".layer-row.is-selected").first().click({ button: "right" });
    await win.getByTestId("context-menu").getByText("Preview animations").click();
    const panel = win.getByTestId("preview-panel");
    await panel.getByTestId("preview-cell").waitFor();
    await expect.poll(() => panel.getByTestId("preview-states").textContent()).toBe("Noneopen");
    const layer = () =>
      win.evaluate(() => {
        const root = document.querySelector('[data-testid="preview-cell"] .preview-render > div')?.shadowRoot;
        const el = root?.querySelector('[data-node-id="QkpksTeC"]');
        const box = el!.getBoundingClientRect();
        return { scale: getComputedStyle(el!).scale, state: el?.getAttribute("data-state"), x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
    const { x, y } = await layer();
    await win.mouse.move(x, y);
    await expect.poll(async () => (await layer()).scale).toBe("1.05");
    await win.mouse.move(0, 0);
    await expect.poll(async () => (await layer()).scale).toBe("none");
    await panel.getByTestId("preview-states").getByText("open").click();
    await expect.poll(async () => (await layer()).state).toBe("open");

    const cellWidth = async () => (await panel.getByTestId("preview-cell").boundingBox())!.width;
    const before = await cellWidth();
    await panel.getByLabel("Zoom in").click();
    await expect.poll(() => panel.getByTestId("preview-zoom").textContent()).toContain("125%");
    await expect.poll(cellWidth).toBeCloseTo(before * 1.25, 0);
    await panel.press("0");
    await expect.poll(cellWidth).toBeCloseTo(before, 0);

    // The preview opens as the bottom dock's tab; full screen grows that dock over the canvas area.
    const dock = win.getByTestId("dock-centre");
    expect(await dock.locator('[role="tab"][aria-selected="true"]').getAttribute("data-panel-tab")).toBe("preview");
    await panel.getByTestId("preview-fullscreen").click();
    const props = (await win.getByTestId("properties-panel").boundingBox())!;
    const full = (await panel.boundingBox())!;
    expect(full.height).toBeGreaterThan(500);
    expect(full.x + full.width).toBeLessThanOrEqual(props.x);
    expect(await dock.getAttribute("class")).toContain("is-fullscreen");
    await panel.press("Escape");
    await expect.poll(async () => (await panel.boundingBox())!.height).toBeLessThan(full.height);
    await panel.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("edits a layer's CSS as plain text and saves it formatted", async () => {
    const editor = win.getByTestId("css-editor");
    await editor.scrollIntoViewIfNeeded();
    await editor.locator(".cm-content").click();
    await win.keyboard.press("Control+End");
    await win.keyboard.type("\n&:active{scale:0.97}");
    await win.getByTestId("properties-panel").locator(".props-header").click();
    await expect.poll(() => checkout().nodes.QkpksTeC?.css).toContain("&:active {\n  scale: 0.97;\n}");
  });

  it("plays page transitions between whole frames in flow mode", async () => {
    const rows = win.getByTestId("layers-panel").locator(".layer-row");
    await rows.filter({ hasText: "Checkout · Default" }).click();
    await rows.filter({ hasText: "Checkout · Done" }).click({ modifiers: ["Control"] });
    await rows.filter({ hasText: "Checkout · Done" }).click({ button: "right" });
    await win.getByTestId("context-menu").getByText("Preview animations").click();
    const panel = win.getByTestId("preview-panel");
    await panel.getByTestId("preview-mode").getByText("Flow").click();
    await expect.poll(() => panel.getByTestId("preview-flow-step").textContent()).toBe("1 / 2");
    const frame = panel.getByTestId("preview-flow");
    const inFrame = () =>
      frame.evaluate((iframe: HTMLIFrameElement) => {
        const doc = iframe.contentDocument!;
        return {
          shown: doc.querySelector("#lamsa-render > [data-node-id]")?.getAttribute("data-node-id"),
          pseudo: doc.getAnimations().map((a) => (a.effect as KeyframeEffect | null)?.pseudoElement ?? ""),
        };
      });
    await expect.poll(async () => (await inFrame()).shown).toBe("08JQi0tV");
    await panel.getByText("0.1×").click();
    await panel.press("ArrowRight");
    await expect.poll(async () => (await inFrame()).pseudo).toContain("::view-transition-group(hero)");
    await expect.poll(async () => (await inFrame()).shown).toBe("DoneFrm1");
    await expect.poll(() => panel.getByTestId("preview-flow-step").textContent()).toBe("2 / 2");
    await panel.press("ArrowLeft");
    await expect.poll(async () => (await inFrame()).shown, { timeout: 15_000 }).toBe("08JQi0tV");
    await panel.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("edits a page transition from flow mode and writes it as CSS", async () => {
    const rows = win.getByTestId("layers-panel").locator(".layer-row");
    await rows.filter({ hasText: "Checkout · Default" }).click();
    await rows.filter({ hasText: "Checkout · Done" }).click({ modifiers: ["Control"] });
    await win.keyboard.press("p");
    const panel = win.getByTestId("preview-panel");
    await panel.getByTestId("preview-mode").getByText("Flow").click();
    await expect.poll(() => panel.getByTestId("flow-arrow").count()).toBe(1);
    const editor = panel.getByTestId("transition-editor");
    const hero = editor.locator('[data-testid="shared-row"][data-target="hero"]');
    await expect.poll(() => hero.textContent()).toContain("both");

    await editor.getByTestId("page-preset").getByText("Slide").click();
    await expect.poll(() => checkout().css ?? "").toContain("::view-transition-new(root)");
    expect(checkout().css).toContain("@keyframes lamsa-slide-from-right");
    expect(checkout().css).toContain("@keyframes rise");

    const duration = hero.locator(".timing-duration input");
    await duration.fill("520");
    await duration.press("Enter");
    await expect.poll(() => checkout().css ?? "").toMatch(/::view-transition-group\(hero\)\s*\{[^}]*animation-duration: 520ms/);

    await editor.getByTestId("share-layer").click();
    const add = editor.getByTestId("add-shared");
    await add.locator("input").fill("thanks");
    await add.getByTestId("pick-from").click();
    const menu = win.getByTestId("layer-picker-menu");
    expect(await menu.locator('[data-layer-id="08JQi0tV"]').isDisabled()).toBe(true);
    const firstChild = await menu.locator(".menu-item").nth(1).getAttribute("data-layer-id");
    await menu.locator(".menu-item").nth(1).click();
    await add.getByTestId("pick-to").click();
    await menu.locator('[data-layer-id="DoneTxt1"]').click();
    await add.getByText("Share", { exact: true }).click();
    await expect.poll(() => String(checkout().nodes.DoneTxt1?.css ?? "")).toContain("view-transition-name: thanks");
    expect(String(checkout().nodes["08JQi0tV"]?.css)).toContain("hero");
    expect(String(checkout().nodes[firstChild!]?.css)).toContain("view-transition-name: thanks");
    await expect.poll(() => editor.locator('[data-target="thanks"]').count()).toBe(1);

    await win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await win.keyboard.press("Control+z");
    await expect.poll(() => String(checkout().nodes.DoneTxt1?.css ?? "")).not.toContain("thanks");
    await panel.press("Escape");
    await panel.waitFor({ state: "detached" });
  });

  it("opens a frame's preview from its label, then zooms with the wheel and pans with the middle button", async () => {
    const rows = win.getByTestId("layers-panel").locator(".layer-row");
    await rows.filter({ hasText: "Checkout · Default" }).click();
    await win.keyboard.press("Shift+Digit2");
    const label = win.locator('.frame-label[data-label-for="08JQi0tV"]');
    await label.hover();
    await label.getByTestId("frame-label-play").click();
    const panel = win.getByTestId("preview-panel");
    await expect.poll(() => panel.getByTestId("preview-cell").count()).toBe(1);
    await expect.poll(() => win.locator('[data-panel-tab="preview"]').getAttribute("class")).toContain("is-active");

    const stage = panel.getByTestId("preview-stage");
    const box = (await stage.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + 40);
    await win.mouse.wheel(0, -300);
    await expect.poll(() => panel.getByTestId("preview-zoom").textContent()).not.toContain("100%");

    const world = panel.locator(".preview-world");
    const before = await world.evaluate((element) => getComputedStyle(element).transform);
    await win.mouse.move(box.x + 40, box.y + 40);
    await win.mouse.down({ button: "middle" });
    await win.mouse.move(box.x + 120, box.y + 90, { steps: 4 });
    await win.mouse.up({ button: "middle" });
    await expect.poll(() => world.evaluate((element) => getComputedStyle(element).transform)).not.toBe(before);

    await panel.press("0");
    await expect.poll(() => panel.getByTestId("preview-zoom").textContent()).toContain("100%");
    await win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await win.keyboard.press("p");
    const closing = await panel.evaluate((element) => ({
      state: element.closest(".presence")?.getAttribute("data-state"),
      cells: element.querySelectorAll('[data-testid="preview-cell"]').length,
    }));
    expect(closing).toEqual({ state: "closed", cells: 1 });
    await panel.waitFor({ state: "detached" });
  });

  it("shows the keyboard shortcuts from the toolbar or ?", async () => {
    await win.getByTestId("open-shortcuts").click();
    const help = win.getByTestId("shortcuts-help");
    await expect.poll(() => help.getByText("Zoom to selection").count()).toBe(1);
    await win.keyboard.press("Escape");
    await help.waitFor({ state: "detached" });
    await win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await win.keyboard.press("Shift+Slash");
    await help.waitFor();
    await win.keyboard.press("Shift+Slash");
    await help.waitFor({ state: "detached" });
  });

  it("keeps a closing side panel mounted until its exit transition ends", async () => {
    const layers = win.getByTestId("layers-panel");
    await win.keyboard.press("Control+BracketLeft");
    await expect.poll(() => layers.evaluate((element) => element.closest(".presence")?.getAttribute("data-state"))).toBe("closed");
    await layers.waitFor({ state: "detached" });
    await win.keyboard.press("Control+BracketLeft");
    await layers.waitFor();
  });

  it("opens and scrolls a layer's row to the middle of the list when it's selected on the canvas", async () => {
    const panel = win.getByTestId("layers-panel");
    const rootRow = panel.locator('[data-layer-id="08JQi0tV"]');
    if ((await rootRow.locator(".twisty.is-open").count()) > 0) await rootRow.locator(".twisty").click();
    await expect.poll(() => panel.locator('.layer-row').evaluateAll((rows) => rows.length)).toBeGreaterThan(0);
    const list = panel.locator(".panel-body");
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const target = await win.evaluate(() => {
      const host = document.querySelector('[data-root-id="08JQi0tV"]')!;
      const inner = [...host.shadowRoot!.querySelectorAll("[data-node-id]")].at(-1) as HTMLElement;
      const r = inner.getBoundingClientRect();
      return { id: inner.getAttribute("data-node-id")!, x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await win.mouse.click(target.x, target.y);
    const row = panel.locator(".layer-row.is-selected").first();
    await row.waitFor();
    const selectedId = await row.getAttribute("data-layer-id");
    expect(selectedId).not.toBe("08JQi0tV");
    const inView = () =>
      row.evaluate((element) => {
        const box = element.closest(".panel-body")!.getBoundingClientRect();
        const r = element.getBoundingClientRect();
        const scroller = element.closest(".panel-body")!;
        const centred = Math.abs(r.top + r.height / 2 - (box.top + box.height / 2)) < 2;
        const atEnd = scroller.scrollTop <= 0 || scroller.scrollTop + 2 >= scroller.scrollHeight - scroller.clientHeight;
        return centred || atEnd;
      });
    await expect.poll(inView).toBe(true);
    await win.keyboard.press("Escape");
  });
});

describe("desktop editor open files", () => {
  let filesRoot: string;
  let outside: string;
  let filesApp: ElectronApplication;
  let win: Page;
  const session = () => JSON.parse(readFileSync(join(filesRoot, ".lamsa/session.json"), "utf8")) as { open?: string[] };
  const shownRoots = () => win.evaluate(() => [...document.querySelectorAll(".frame-host")].map((host) => host.getAttribute("data-root-id")));
  const fileHeaders = () => win.getByTestId("layers-panel").locator(".layer-file-name").allTextContents();
  const extra = (name: string, title: string) =>
    JSON.stringify({ version: 1, nodes: { [`${name}Frm1`]: { type: "frame", name: title, x: 2000, y: 0, style: { width: 200, height: 120, background: "{color.muted}" } } } });

  beforeAll(async () => {
    filesRoot = mkdtempSync(join(tmpdir(), "lamsa-files-"));
    copyExample(filesRoot, { openAll: false });
    outside = mkdtempSync(join(tmpdir(), "lamsa-outside-"));
    writeFileSync(join(outside, "elsewhere.lamsa.json"), extra("Elsw", "Elsewhere"));
    filesApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", filesRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await filesApp.firstWindow();
    await win.getByTestId("open-files-dialog").waitFor();
  }, 60_000);

  afterAll(async () => {
    await filesApp?.close();
  });

  it("asks which files to open the first time, and remembers the answer", async () => {
    const dialog = win.getByTestId("open-files-dialog");
    expect(await dialog.locator("[data-file]").count()).toBe(2);
    await dialog.locator('[data-file="designs/checkout.lamsa.json"]').click();
    await dialog.getByTestId("open-files-confirm").click();
    await dialog.waitFor({ state: "detached" });
    expect(session().open).toEqual(["designs/checkout.lamsa.json"]);
    expect(await fileHeaders()).toEqual(["checkout.lamsa.json"]);
    // The Button component lives in a file that isn't open, but its instances still render.
    await expect.poll(() => win.evaluate(() => document.querySelector(".frame-host")?.shadowRoot?.textContent ?? "")).toContain("Pay");
  });

  it("adds a project file from the layers panel and closes it again", async () => {
    await win.getByTestId("layers-panel").getByTestId("add-file").click();
    await win.getByTestId("add-file-menu").locator('[data-file="designs/components.lamsa.json"]').click();
    await expect.poll(fileHeaders).toEqual(["checkout.lamsa.json", "components.lamsa.json"]);
    expect(session().open).toEqual(["designs/checkout.lamsa.json", "designs/components.lamsa.json"]);
    const header = win.getByTestId("layers-panel").locator(".layer-file", { hasText: "components.lamsa.json" });
    await header.hover();
    await header.getByRole("button", { name: /Close/ }).click();
    await expect.poll(fileHeaders).toEqual(["checkout.lamsa.json"]);
    expect(session().open).toEqual(["designs/checkout.lamsa.json"]);
  });

  it("opens files the agent creates, and files from outside the repo", async () => {
    writeFileSync(join(filesRoot, "designs/new.lamsa.json"), extra("Newf", "New screen"));
    await expect.poll(fileHeaders).toContain("new.lamsa.json");
    await expect.poll(shownRoots).toContain("NewfFrm1");

    const result = await win.evaluate((path) => window.lamsa.addFiles([path]), join(outside, "elsewhere.lamsa.json"));
    const key = result.open.find((path) => path.endsWith("elsewhere.lamsa.json"))!;
    expect(key.startsWith("../")).toBe(true);
    expect(result.errors).toEqual([]);
    expect(session().open).toContain(key);
    // A reload restores the session, including the file outside the repo.
    await win.reload();
    await win.getByTestId("layers-panel").waitFor();
    await expect.poll(shownRoots).toContain("ElswFrm1");
    expect(await win.getByTestId("open-files-dialog").count()).toBe(0);
  });

  it("keeps files apart on the canvas and moves a whole file by its name", async () => {
    const labelCount = () => win.locator(".file-label").count();
    const frameBoxes = () =>
      win.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>(".frame-host")].map((host) => {
          const r = host.getBoundingClientRect();
          return { id: host.getAttribute("data-root-id")!, left: r.left, right: r.right };
        }),
      );
    // Close and reopen files in an order that used to put two of them in the same place.
    await win.getByTestId("layers-panel").getByTestId("add-file").click();
    await win.getByTestId("add-file-menu").locator('[data-file="designs/components.lamsa.json"]').click();
    await expect.poll(labelCount).toBe(4);
    const spans = async () => {
      const boxes = await frameBoxes();
      const labels = await win.evaluate(() => [...document.querySelectorAll<HTMLElement>(".file-label")].map((l) => ({ file: l.dataset.file!, left: l.getBoundingClientRect().left })));
      labels.sort((a, b) => a.left - b.left);
      return labels.map((label, i) => {
        const next = labels[i + 1]?.left ?? Infinity;
        const own = boxes.filter((b) => b.left >= label.left - 1 && b.left < next - 1);
        return { file: label.file, left: Math.min(...own.map((b) => b.left)), right: Math.max(...own.map((b) => b.right)) };
      });
    };
    const ranges = await spans();
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]!.left).toBeGreaterThan(ranges[i - 1]!.right);

    await win.keyboard.press("Escape");
    await win.keyboard.press("Shift+Digit1");
    await win.waitForTimeout(300);
    const label = win.locator('.file-label[data-file="designs/checkout.lamsa.json"]');
    const before = JSON.parse(readFileSync(join(filesRoot, "designs/checkout.lamsa.json"), "utf8")).nodes as Record<string, { parentId?: string; x?: number }>;
    const roots = Object.entries(before).filter(([, n]) => n.parentId === undefined).map(([id]) => id);
    const box = (await label.boundingBox())!;
    await win.mouse.move(box.x + 10, box.y + box.height / 2);
    await win.mouse.down();
    const header = win.getByTestId("properties-panel").locator(".props-header");
    await expect.poll(() => header.textContent()).toContain(roots.length === 1 ? `id ${roots[0]}` : `${roots.length} layers`);
    await win.mouse.move(box.x + 70, box.y + box.height / 2 + 20, { steps: 6 });
    await win.mouse.up();
    await expect
      .poll(() => {
        const after = JSON.parse(readFileSync(join(filesRoot, "designs/checkout.lamsa.json"), "utf8")).nodes as Record<string, { x?: number }>;
        return roots.every((id) => (after[id]?.x ?? 0) > (before[id]?.x ?? 0));
      })
      .toBe(true);
  });

  it("goes back to the welcome screen from the project menu, and reopens the project from there", async () => {
    await win.getByTestId("project-menu").click();
    await win.getByTestId("go-home").click();
    const welcome = win.getByTestId("welcome");
    await welcome.waitFor();
    await welcome.locator(`.recent-open[title="${filesRoot}"]`).click();
    await win.getByTestId("layers-panel").waitFor();
    // The session comes back with it: same files open, no prompt.
    expect(await win.getByTestId("open-files-dialog").count()).toBe(0);
    await expect.poll(() => win.getByTestId("layers-panel").locator(".layer-file").count()).toBeGreaterThan(0);
    await expect.poll(() => win.getByTestId("project-menu").textContent()).toContain(filesRoot.split("/").pop()!);
  });

  it("opens with several layers selected, opening the files they're in instead of asking", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "lamsa-files-"));
    copyExample(fresh, { openAll: false });
    const other = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", fresh, "--select", "QkpksTeC,Inp00001", "--select", "Btn00001"],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    try {
      const page = await other.firstWindow();
      await expect
        .poll(() => page.getByTestId("layers-panel").locator(".layer-file-name").allTextContents())
        .toEqual(["checkout.lamsa.json", "components.lamsa.json"]);
      const selected = () => (JSON.parse(readFileSync(join(fresh, ".lamsa/session.json"), "utf8")) as { selection: string[] }).selection.slice().sort();
      await expect.poll(selected).toEqual(["Btn00001", "Inp00001", "QkpksTeC"]);
      expect(await page.getByTestId("open-files-dialog").count()).toBe(0);
    } finally {
      await other.close();
    }
  }, 60_000);

  it("opens nothing when the prompt is dismissed, and offers to open a file from the empty canvas", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "lamsa-files-"));
    copyExample(fresh, { openAll: false });
    const other = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", fresh],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    try {
      const page = await other.firstWindow();
      const dialog = page.getByTestId("open-files-dialog");
      await dialog.waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      const empty = page.getByTestId("no-files-open");
      await empty.waitFor();
      expect(JSON.parse(readFileSync(join(fresh, ".lamsa/session.json"), "utf8")).open).toEqual([]);
      await empty.getByTestId("add-file").click();
      await page.getByTestId("add-file-menu").locator('[data-file="designs/checkout.lamsa.json"]').click();
      await empty.waitFor({ state: "detached" });
      await expect.poll(() => page.getByTestId("layers-panel").locator(".layer-file-name").allTextContents()).toEqual(["checkout.lamsa.json"]);
    } finally {
      await other.close();
    }
  }, 60_000);
});

describe("desktop editor dockable panels", () => {
  let dockApp: ElectronApplication;
  let win: Page;

  const tabsIn = (dock: string) => win.getByTestId(`dock-${dock}`).locator("[data-panel-tab]").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-panel-tab")));
  const activeIn = (dock: string) => win.getByTestId(`dock-${dock}`).locator('[role="tab"][aria-selected="true"]').getAttribute("data-panel-tab");
  const storedLayout = () => win.evaluate(() => JSON.parse(localStorage.getItem("lamsa.panelLayout") ?? "null"));

  /** Drags a panel's tab onto a dock's drop zone (or onto a point), checking the zones show and highlight on the way. */
  async function dragTab({ panel, to }: { panel: string; to: string | { x: number; y: number } }) {
    const tab = (await win.locator(`[data-panel-tab="${panel}"]`).boundingBox())!;
    await win.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await win.mouse.down();
    await win.mouse.move(tab.x + tab.width / 2 + 20, tab.y + tab.height / 2 + 20, { steps: 3 });
    await win.getByTestId("dock-ghost").waitFor();
    let point = typeof to === "string" ? null : to;
    if (typeof to === "string") {
      const zone = (await win.getByTestId(`dock-zone-${to}`).boundingBox())!;
      point = { x: zone.x + zone.width / 2, y: zone.y + zone.height / 2 };
    }
    await win.mouse.move(point!.x, point!.y, { steps: 6 });
    if (typeof to === "string") expect(await win.getByTestId(`dock-zone-${to}`).getAttribute("data-over")).toBe("");
    await win.mouse.up();
    await win.getByTestId("dock-ghost").waitFor({ state: "detached" });
  }

  beforeAll(async () => {
    const dockRoot = mkdtempSync(join(tmpdir(), "lamsa-docks-"));
    copyExample(dockRoot);
    dockApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", dockRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await dockApp.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.getByTestId("layers-panel").waitFor();
  }, 60_000);

  afterAll(async () => {
    await dockApp?.close();
  });

  /** Labels that take up space: inactive ones are collapsed to zero width (they animate open and shut). */
  const visibleTabLabels = (dock: string) =>
    win
      .getByTestId(`dock-${dock}`)
      .locator(".tab-label")
      .evaluateAll((labels) => labels.filter((label) => label.getBoundingClientRect().width > 1).map((label) => label.textContent));

  it("draws the left panels as icon tabs, Agent first, with only the open tab's label and a tooltip on hover", async () => {
    expect(await tabsIn("left")).toEqual(["agent", "layers", "files", "components"]);
    expect(await tabsIn("right")).toEqual(["properties", "comments"]);
    await expect.poll(() => visibleTabLabels("left")).toEqual(["Layers"]);
    const files = win.locator('[data-panel-tab="files"]');
    const tip = files.locator("xpath=..").getByRole("tooltip");
    expect(await tip.isVisible()).toBe(false);
    await files.hover();
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.textContent()).toBe("FilesCtrl+3");
    await files.click();
    expect(await activeIn("left")).toBe("files");
    await expect.poll(() => visibleTabLabels("left")).toEqual(["Files"]);
    await win.getByTestId("files-panel").waitFor();
  });

  it("opens a tooltip after a rest, then instantly on the next tab, hides it on press, and cools down after leaving", async () => {
    const tipOf = (panel: string) => win.locator(`[data-panel-tab="${panel}"]`).locator("xpath=..").locator(".tip");
    const tipState = (panel: string) =>
      tipOf(panel).evaluate((tip) => {
        const style = getComputedStyle(tip);
        return { visible: style.display !== "none" && style.visibility === "visible", delay: style.transitionDelay };
      });
    const warm = () => win.evaluate(() => document.body.dataset.tipsWarm !== undefined);
    const setWarm = (on: boolean) =>
      win.evaluate((value) => {
        if (value) document.body.dataset.tipsWarm = "";
        else delete document.body.dataset.tipsWarm;
      }, on);
    // Mouse moves into this hidden test window can take longer than the delay itself, so this checks the wiring, not the clock.
    const centreOf = async (panel: string) => {
      const box = (await win.locator(`[data-panel-tab="${panel}"]`).boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    await win.mouse.move(700, 500);
    await expect.poll(warm, { timeout: 5000 }).toBe(false);

    const files = await centreOf("files");
    await win.mouse.move(files.x, files.y);
    await expect.poll(() => tipState("files")).toEqual({ visible: true, delay: "0s" });
    expect(await warm()).toBe(true);
    await setWarm(false);
    expect((await tipState("files")).delay).toBe("0.5s");
    await setWarm(true);

    const components = await centreOf("components");
    await win.mouse.move(components.x, components.y);
    expect(await tipState("components")).toEqual({ visible: true, delay: "0s" });
    expect((await tipState("files")).visible).toBe(false);

    await win.mouse.down();
    expect((await tipState("components")).visible).toBe(false);
    await win.mouse.move(700, 500);
    await win.mouse.up();
    await expect.poll(warm, { timeout: 5000 }).toBe(false);
  });

  it("animates a tab switch made with the pointer and keeps keyboard switches instant", async () => {
    const transitioning = (panel: string) =>
      win.locator(`[data-panel-tab="${panel}"] .tab-label`).evaluate((label) => label.getAnimations().length > 0);
    const before = await activeIn("left");
    const target = before === "layers" ? "components" : "layers";
    await win.locator(`[data-panel-tab="${target}"]`).click();
    expect([await transitioning(target), await transitioning(before ?? "")]).toEqual([true, true]);
    await expect.poll(() => visibleTabLabels("left")).toHaveLength(1);

    await win.mouse.move(700, 500);
    await win.locator(`[data-panel-tab="${target}"]`).focus();
    await win.keyboard.press("ArrowRight");
    const next = await activeIn("left");
    expect(next).not.toBe(target);
    expect(await transitioning(next ?? "")).toBe(false);
    await win.locator(`[data-panel-tab="${before}"]`).click();
  });

  it("moves a tab from the left dock to the right one, and back again", async () => {
    await dragTab({ panel: "components", to: "right" });
    expect(await tabsIn("right")).toEqual(["properties", "comments", "components"]);
    expect(await activeIn("right")).toBe("components");
    expect(await tabsIn("left")).toEqual(["agent", "layers", "files"]);
    await win.getByTestId("dock-right").getByTestId("components-panel").waitFor();

    // Dropped onto the left tab strip, before Files.
    const files = (await win.locator('[data-panel-tab="files"]').boundingBox())!;
    await dragTab({ panel: "components", to: { x: files.x + 2, y: files.y + files.height / 2 } });
    expect(await tabsIn("left")).toEqual(["agent", "layers", "components", "files"]);
    expect(await tabsIn("right")).toEqual(["properties", "comments"]);
  });

  it("collapses a dock that has no tabs left, and widens the canvas area into its place", async () => {
    // Toasts sit beside the right dock while it's open, so their right edge shows where the canvas area ends.
    const canvasAreaRight = () => win.getByTestId("toasts").evaluate((element) => Math.round(element.getBoundingClientRect().right));
    const before = await canvasAreaRight();
    await dragTab({ panel: "comments", to: "left" });
    await dragTab({ panel: "properties", to: "left" });
    expect(await tabsIn("left")).toEqual(["agent", "layers", "components", "files", "comments", "properties"]);
    await win.getByTestId("dock-right").waitFor({ state: "detached" });
    expect(await win.getByTestId("toggle-right-dock").isDisabled()).toBe(true);
    await expect.poll(canvasAreaRight).toBeGreaterThan(before + 200);
    await win.getByTestId("dock-left").getByTestId("properties-panel").waitFor();
  });

  it("docks a panel at the bottom, under the canvas", async () => {
    await dragTab({ panel: "layers", to: "centre" });
    const centre = win.getByTestId("dock-centre");
    await centre.getByTestId("layers-panel").waitFor();
    const box = (await centre.boundingBox())!;
    const left = (await win.getByTestId("dock-left").boundingBox())!;
    expect(box.x).toBeGreaterThan(left.x + left.width);
    // Nothing sits under it: it reaches down to the window's edge, one gap above it.
    const innerHeight = await win.evaluate(() => window.innerHeight);
    await expect.poll(async () => innerHeight - (await centre.evaluate((element) => element.getBoundingClientRect().bottom))).toBeCloseTo(12, 0);
    expect(await tabsIn("left")).not.toContain("layers");
  });

  it("cancels a drag with Escape or a drop outside the zones", async () => {
    const tab = (await win.locator('[data-panel-tab="files"]').boundingBox())!;
    await win.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await win.mouse.down();
    await win.mouse.move(700, 300, { steps: 5 });
    await win.keyboard.press("Escape");
    await win.getByTestId("dock-ghost").waitFor({ state: "detached" });
    await win.mouse.up();
    await dragTab({ panel: "files", to: { x: 700, y: 200 } });
    expect(await tabsIn("left")).toContain("files");
  });

  it("keeps the layout and each dock's size across a reload", async () => {
    const handle = win.getByTestId("centre-panel-resize");
    const box = (await handle.boundingBox())!;
    const height = () => win.getByTestId("dock-centre").evaluate((element) => Math.round(element.getBoundingClientRect().height));
    const before = await height();
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 50, { steps: 5 });
    await win.mouse.up();
    expect(await height()).toBe(before + 50);
    const leftWidth = await win.getByTestId("dock-left").evaluate((element) => Math.round(element.getBoundingClientRect().width));

    const layout = await storedLayout();
    await win.reload();
    await win.getByTestId("dock-centre").getByTestId("layers-panel").waitFor();
    expect(await storedLayout()).toEqual(layout);
    expect(await tabsIn("left")).toEqual(["agent", "components", "files", "comments", "properties"]);
    expect(await height()).toBe(before + 50);
    expect(await win.getByTestId("dock-left").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(leftWidth);
  });

  it("remembers each side dock's width on its own", async () => {
    await dragTab({ panel: "properties", to: "right" });
    // Let the dock finish sliding in before grabbing its edge.
    await win.waitForTimeout(300);
    const width = (dock: string) => win.getByTestId(`dock-${dock}`).evaluate((element) => Math.round(element.getBoundingClientRect().width));
    const left = await width("left");
    const right = await width("right");
    const box = (await win.getByTestId("right-panel-resize").boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2, { steps: 5 });
    expect(await win.getByTestId("right-panel-width").textContent()).toContain(`${right + 40} px`);
    await win.mouse.up();
    expect(await width("right")).toBe(right + 40);
    expect(await width("left")).toBe(left);
    expect((await storedLayout()).right.size).toBe(right + 40);
  });

  it("reaches and moves tabs from the keyboard", async () => {
    await win.keyboard.press("Control+3");
    await expect.poll(() => win.evaluate(() => document.activeElement?.getAttribute("data-panel-tab"))).toBe("files");
    expect(await activeIn("left")).toBe("files");
    await win.keyboard.press("ArrowRight");
    expect(await activeIn("left")).toBe("comments");
    await win.keyboard.press("ArrowLeft");
    await win.keyboard.press("Shift+F10");
    await win.getByTestId("panel-tab-menu").locator('[data-dock-target="right"]').click();
    await expect.poll(() => tabsIn("right")).toEqual(["properties", "files"]);
    await expect.poll(() => win.evaluate(() => document.activeElement?.getAttribute("data-panel-tab"))).toBe("files");
  });

  it("resets to the default layout from the project menu, the shortcuts list, and the keyboard", async () => {
    await win.getByTestId("project-menu").click();
    await win.getByTestId("reset-panel-layout").click();
    expect(await tabsIn("left")).toEqual(["agent", "layers", "files", "components"]);
    expect(await tabsIn("right")).toEqual(["properties", "comments"]);
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
    expect(await storedLayout()).toBeNull();

    await dragTab({ panel: "layers", to: "right" });
    await win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await win.keyboard.press("Control+Alt+0");
    expect(await tabsIn("left")).toEqual(["agent", "layers", "files", "components"]);

    await win.keyboard.press("Shift+Slash");
    await expect.poll(() => win.getByTestId("shortcuts-help").getByText("Reset panel layout").count()).toBe(1);
    await win.keyboard.press("Escape");
  });
});

describe("desktop editor preview dock", () => {
  let previewApp: ElectronApplication;
  let win: Page;

  const tabsIn = (dock: string) => win.getByTestId(`dock-${dock}`).locator("[data-panel-tab]").evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("data-panel-tab")));
  const activeIn = (dock: string) => win.getByTestId(`dock-${dock}`).locator('[role="tab"][aria-selected="true"]').getAttribute("data-panel-tab");
  const visibleTabLabels = (dock: string) =>
    win
      .getByTestId(`dock-${dock}`)
      .locator(".tab-label")
      .evaluateAll((labels) => labels.filter((label) => label.getBoundingClientRect().width > 1).map((label) => label.textContent));
  const focusCanvas = () => win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
  /** Moves a tab to another dock with its Shift+F10 menu. */
  const moveTab = async ({ panel, to }: { panel: string; to: string }) => {
    await win.locator(`[data-panel-tab="${panel}"]`).focus();
    await win.keyboard.press("Shift+F10");
    await win.getByTestId("panel-tab-menu").locator(`[data-dock-target="${to}"]`).click();
    await win.getByTestId(`dock-${to}`).locator(`[data-panel-tab="${panel}"]`).waitFor();
  };

  beforeAll(async () => {
    const previewRoot = mkdtempSync(join(tmpdir(), "lamsa-preview-dock-"));
    copyExample(previewRoot);
    previewApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", previewRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await previewApp.firstWindow();
    await win.setViewportSize({ width: 1440, height: 900 });
    await win.getByTestId("layers-panel").waitFor();
  }, 60_000);

  afterAll(async () => {
    await previewApp?.close();
  });

  it("keeps the bottom dock closed until the preview opens, with Preview as its icon tab", async () => {
    expect(await win.getByTestId("dock-centre").count()).toBe(0);
    await focusCanvas();
    await win.keyboard.press("p");
    await win.getByTestId("dock-centre").waitFor();
    expect(await tabsIn("centre")).toEqual(["preview"]);
    await expect.poll(() => visibleTabLabels("centre")).toEqual(["Preview"]);
    expect(await win.locator('[data-panel-tab="preview"] svg').count()).toBe(1);
    const tab = win.locator('[data-panel-tab="preview"]');
    await tab.hover();
    const tip = tab.locator("xpath=..").getByRole("tooltip");
    await expect.poll(() => tip.isVisible()).toBe(true);
    expect(await tip.textContent()).toBe("PreviewCtrl+6");
    // Nothing was selected, so the preview explains how to fill it.
    await win.getByTestId("preview-empty").waitFor();
    expect(await win.getByTestId("preview-selection").isDisabled()).toBe(true);
    expect(await win.locator('[data-panel-tab="preview"]').getAttribute("class")).toContain("is-active");
    await focusCanvas();
    await win.keyboard.press("p");
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
  });

  it("previews the selection from the empty state and toggles the bottom dock from the top bar", async () => {
    await win.getByTestId("toggle-centre-dock").click();
    await win.getByTestId("preview-empty").waitFor();
    await win.getByTestId("layers-panel").getByText("Checkout · Default", { exact: true }).click();
    await win.getByTestId("preview-selection").click();
    await expect.poll(() => win.getByTestId("preview-cell").count()).toBe(1);
    await win.getByTestId("toggle-centre-dock").click();
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
    // Ctrl+6 brings the tab back with what it was playing.
    await focusCanvas();
    await win.keyboard.press("Control+6");
    await expect.poll(() => win.getByTestId("preview-cell").count()).toBe(1);
    await win.keyboard.press("Control+'");
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
  });

  it("hides the bottom dock from its own button, even in full screen, and keeps the button clear of the tabs", async () => {
    await focusCanvas();
    await win.keyboard.press("Control+6");
    const dock = win.getByTestId("dock-centre");
    await dock.waitFor();
    const hide = dock.getByTestId("hide-bottom-panel");
    const layout = await dock.evaluate((element) => {
      const strip = element.querySelector(".tabs")!.getBoundingClientRect();
      const tabs = Array.from(element.querySelectorAll("[data-panel-tab]")).map((tab) => tab.getBoundingClientRect().right);
      const button = element.querySelector('[data-testid="hide-bottom-panel"]')!.getBoundingClientRect();
      return { insideStrip: button.top >= strip.top && button.bottom <= strip.bottom, clearOfTabs: Math.max(...tabs) <= button.left, nearRight: Math.round(element.getBoundingClientRect().right - button.right) };
    });
    expect(layout).toEqual({ insideStrip: true, clearOfTabs: true, nearRight: 9 });
    expect(await win.getByTestId("dock-left").getByTestId("hide-bottom-panel").count()).toBe(0);
    expect(await win.getByTestId("dock-right").getByTestId("hide-bottom-panel").count()).toBe(0);
    expect(await hide.getAttribute("aria-label")).toBe("Hide bottom panel");

    await hide.click();
    await dock.waitFor({ state: "detached" });
    // Ctrl+6 brings it back with Preview still active.
    await focusCanvas();
    await win.keyboard.press("Control+6");
    await dock.waitFor();
    expect(await dock.locator('[data-panel-tab="preview"]').getAttribute("class")).toContain("is-active");
    await hide.click();
    await dock.waitFor({ state: "detached" });

    await win.getByTestId("layers-panel").locator(".layer-row").filter({ hasText: "Checkout · Default" }).click();
    await win.keyboard.press("p");
    const panel = dock.getByTestId("preview-panel");
    await expect.poll(() => panel.getByTestId("preview-cell").count()).toBe(1);
    await panel.press("f");
    await expect.poll(() => dock.getAttribute("class")).toContain("is-fullscreen");
    await hide.click();
    await dock.waitFor({ state: "detached" });
    await focusCanvas();
    await win.keyboard.press("Control+6");
    await dock.waitFor();
    expect(await dock.getAttribute("class")).not.toContain("is-fullscreen");
    await hide.click();
    await dock.waitFor({ state: "detached" });
  });

  it("moves Preview to the left dock, opens it there with P, and hands the dock back on close", async () => {
    await win.keyboard.press("Control+6");
    await win.getByTestId("dock-centre").waitFor();
    await moveTab({ panel: "preview", to: "left" });
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
    expect(await activeIn("left")).toBe("preview");
    await win.getByTestId("dock-left").getByTestId("preview-panel").waitFor();
    await win.locator('[data-panel-tab="layers"]').click();

    await win.getByTestId("layers-panel").getByText("Checkout · Default", { exact: true }).click();
    await win.keyboard.press("p");
    await expect.poll(() => activeIn("left")).toBe("preview");
    await expect.poll(() => win.getByTestId("dock-left").getByTestId("preview-cell").count()).toBe(1);
    await win.keyboard.press("p");
    await expect.poll(() => activeIn("left")).toBe("layers");
    expect(await win.getByTestId("dock-left").isVisible()).toBe(true);
  });

  it("puts Preview back in the bottom dock when the layout is reset", async () => {
    await focusCanvas();
    await win.keyboard.press("Control+Alt+0");
    expect(await tabsIn("left")).toEqual(["agent", "layers", "files", "components"]);
    await win.keyboard.press("p");
    await win.getByTestId("dock-centre").getByTestId("preview-panel").waitFor();
    await win.keyboard.press("p");
    await win.getByTestId("dock-centre").waitFor({ state: "detached" });
  });

  it("adds Preview to its home dock when a layout saved before it existed is loaded", async () => {
    await win.evaluate(() =>
      localStorage.setItem(
        "lamsa.panelLayout",
        JSON.stringify({
          left: { tabs: ["agent", "layers", "files", "components"], active: "layers", size: 300 },
          right: { tabs: ["properties"], active: "properties", size: null },
          centre: { tabs: [], active: null, size: null },
        }),
      ),
    );
    await win.reload();
    await win.getByTestId("layers-panel").waitFor();
    expect(await win.getByTestId("dock-centre").count()).toBe(0);
    expect(await win.getByTestId("dock-left").evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(300);
    await focusCanvas();
    await win.keyboard.press("p");
    expect(await tabsIn("centre")).toEqual(["preview"]);
    await win.keyboard.press("p");
    await win.keyboard.press("Control+Alt+0");
  });

  describe("draws every dock's tab strip the same way", () => {
    beforeAll(async () => {
      await focusCanvas();
      await win.keyboard.press("Control+6");
      await win.getByTestId("dock-centre").waitFor();
      await moveTab({ panel: "components", to: "centre" });
      await moveTab({ panel: "files", to: "right" });
      // Two tab drags; under a full parallel run they can take longer than the default 10 s.
    }, 30_000);

    it.each(["left", "right", "centre"])("%s dock: icon tabs, only the open tab's label, tooltips, and a resize handle", async (dock) => {
      const container = win.getByTestId(`dock-${dock}`);
      const tabs = (await tabsIn(dock)) as string[];
      expect(tabs.length).toBeGreaterThan(1);
      for (const panel of tabs) {
        await container.locator(`[data-panel-tab="${panel}"]`).click();
        const title = await container.locator(`[data-panel-tab="${panel}"]`).getAttribute("aria-label");
        await expect.poll(() => visibleTabLabels(dock)).toEqual([title]);
        // Polled: the label animates open after the click.
        const strip = () =>
          container.locator('[role="tablist"]').evaluate((element) => {
            const label = element.querySelector<HTMLElement>('[aria-selected="true"] .tab-label > span')!;
            return { overflows: element.scrollWidth > element.clientWidth, clipped: label.scrollWidth > label.clientWidth };
          });
        await expect.poll(strip, { message: `${panel} in the ${dock} dock` }).toEqual({ overflows: false, clipped: false });
      }
      expect(await container.locator("[data-panel-tab] svg").count()).toBe(tabs.length);
      const other = container.locator(`[data-panel-tab="${tabs[0]}"]`);
      await win.mouse.move(700, 450);
      await other.hover();
      const tip = other.locator("xpath=..").getByRole("tooltip");
      await expect.poll(() => tip.isVisible()).toBe(true);
      expect(await tip.textContent()).toMatch(/Ctrl\+\d$/);
      await win.getByTestId(`${dock}-panel-resize`).waitFor();
    });
  });
});

describe("desktop editor agent chat", () => {
  const FAKE_BIN = join(repo, "tests/fixtures/fake-claude");
  let chatRoot: string;
  let claudeProjects: string;
  let terminalLog: string;
  let chatApp: ElectronApplication;
  let win: Page;

  const thread = () => win.getByTestId("agent-thread");
  const send = async (text: string) => {
    await win.getByTestId("agent-input").fill(text);
    await win.getByTestId("agent-input").press("Enter");
  };
  const idle = () => win.getByTestId("agent-working").waitFor({ state: "detached", timeout: 15_000 });
  /** Each test starts from the chat, even if the one before it stopped part way through the history list. */
  const backToChat = async () => {
    if (await win.getByTestId("agent-history-back").count()) await win.getByTestId("agent-history-back").click();
  };
  const sessionSelection = () => {
    try {
      return (JSON.parse(readFileSync(join(chatRoot, ".lamsa/session.json"), "utf8")) as { selection: string[] }).selection;
    } catch {
      return [];
    }
  };

  beforeAll(async () => {
    chatRoot = mkdtempSync(join(tmpdir(), "lamsa-chat-"));
    copyExample(chatRoot);
    terminalLog = join(mkdtempSync(join(tmpdir(), "lamsa-terminal-log-")), "opened.txt");
    claudeProjects = mkdtempSync(join(tmpdir(), "lamsa-claude-projects-"));
    chatApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", chatRoot],
      env: {
        ...process.env,
        LAMSA_HIDDEN: "1",
        LAMSA_MULTI_INSTANCE: "1",
        // A fake claude and terminal: the chat runs offline and opens no windows.
        PATH: `${FAKE_BIN}:${process.env.PATH}`,
        TERMINAL: join(FAKE_BIN, "terminal"),
        FAKE_TERMINAL_LOG: terminalLog,
        FAKE_CLAUDE_PROJECTS: claudeProjects,
        FAKE_CLAUDE_TERMINAL_MS: "2000",
      },
    });
    win = await chatApp.firstWindow();
    await win.locator('[data-panel-tab="agent"]').click();
    await win.getByTestId("agent-input").waitFor();
  }, 60_000);

  afterAll(async () => {
    await chatApp?.close();
  });

  it("sends a message, streams the reply, and links the layers it changed to the canvas", async () => {
    await expect.poll(() => win.getByTestId("agent-title").textContent()).toBe("New chat");
    await send("Please edit the checkout title");
    await expect.poll(() => win.getByTestId("agent-title").textContent()).toBe("Please edit the checkout title");
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("Done. The title now reads");
    await idle();
    const steps = win.getByTestId("agent-step");
    await expect.poll(() => steps.allTextContents()).toEqual(["Editdesigns/checkout.lamsa.json", "Validatelamsa validate"]);
    const change = win.getByTestId("agent-change-row");
    await expect.poll(() => change.getAttribute("data-node-id")).toBe("gmrdFHB9");
    expect(await win.getByTestId("agent-changes").textContent()).toContain("content");
    await change.click();
    await expect.poll(sessionSelection).toEqual(["gmrdFHB9"]);
  });

  it("starts a new chat, lists past conversations, and resumes one where it left off", async () => {
    await win.getByTestId("agent-new-chat").click();
    await expect.poll(() => win.getByTestId("agent-title").textContent()).toBe("New chat");
    await send("hello there");
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("You said: hello there");
    await idle();

    await win.getByTestId("agent-history-button").click();
    const rows = win.getByTestId("agent-history-row");
    await expect.poll(() => rows.count()).toBe(2);
    expect(await rows.nth(0).textContent()).toMatch(/^hello there.*Open$/);
    expect(await rows.nth(1).textContent()).toContain("1 layer changed");

    await rows.nth(1).click();
    await expect.poll(() => win.getByTestId("agent-title").textContent()).toBe("Please edit the checkout title");
    // The conversation comes back from claude's own session file, with lamsa's record of what it changed.
    await win.getByTestId("agent-changes").waitFor();
    await send("and once more");
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("You said: and once more");
    await idle();
    expect(await win.getByTestId("agent-error").count()).toBe(0);
    expect(await win.getByTestId("agent-user-message").count()).toBe(2);
  });

  it("shows a failed turn with a way to retry", async () => {
    await backToChat();
    await send("please fail");
    await win.getByTestId("agent-error").waitFor({ timeout: 15_000 });
    expect(await win.getByTestId("agent-error").textContent()).toContain("usage limit reached");
    await idle();
    await win.getByTestId("agent-error").getByRole("button", { name: "Retry" }).waitFor();
  });

  it("stops a turn from the message box", async () => {
    await backToChat();
    await send("be slow");
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("Working on it");
    const errors = await win.getByTestId("agent-error").count();
    await win.getByTestId("agent-stop").click();
    await idle();
    await expect.poll(() => thread().locator(".agent-note").last().textContent()).toBe("Stopped");
    expect(await win.getByTestId("agent-error").count()).toBe(errors);
    await win.getByTestId("agent-send").waitFor();
  });

  it("shows a refused command as blocked, and allows it for the chat on request", async () => {
    await backToChat();
    await send("clean the build folder");
    await win.getByTestId("agent-blocked-step").waitFor({ timeout: 15_000 });
    await idle();
    expect(await win.getByTestId("agent-blocked-step").textContent()).toContain("Blocked:rm -rf build");
    await win.getByTestId("agent-blocked-step").getByRole("button", { name: "Allow & retry" }).click();
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("Cleaned the build folder.");
    await idle();
  });

  it("continues the chat in the user's terminal and picks it up when that closes", async () => {
    await backToChat();
    await win.getByTestId("agent-title").click();
    await win.keyboard.press("Control+j");
    await win.getByTestId("agent-continued").waitFor({ timeout: 10_000 });
    await expect.poll(() => (existsSync(terminalLog) ? readFileSync(terminalLog, "utf8") : "")).toMatch(/claude'? '--resume' '[0-9a-f-]{36}'/);
    expect(readFileSync(terminalLog, "utf8").split("\n")[0]).toBe(chatRoot);
    await win.getByTestId("agent-continued").waitFor({ state: "detached", timeout: 15_000 });
    await expect.poll(() => thread().textContent()).toContain("Picked up in the terminal.");
    await win.getByTestId("agent-input").waitFor();
  });

  it("turns pasted layers and layer ids into pills, sends them as layer links, and links them back to the canvas", async () => {
    await backToChat();
    await win.getByTestId("agent-new-chat").click();
    const input = win.getByTestId("agent-input");
    const pills = input.locator('[data-testid="agent-input-pill"]');
    const paste = async (text?: string) => {
      if (text !== undefined) await win.evaluate((value) => navigator.clipboard.writeText(value), text);
      await input.click();
      await win.keyboard.press("Control+v");
    };

    // Copy a layer on the canvas; the selection itself shows nowhere in the message box.
    await win.locator('[data-panel-tab="layers"]').click();
    await win.getByTestId("layers-panel").getByText("Pay button", { exact: true }).click();
    await expect.poll(sessionSelection).toEqual(["QkpksTeC"]);
    await win.keyboard.press("Control+c");
    await expect.poll(() => win.evaluate(() => navigator.clipboard.readText())).toContain('"id": "QkpksTeC"');
    await win.locator('[data-panel-tab="agent"]').click();
    await expect.poll(() => input.getAttribute("data-placeholder")).toBe("Ask about the selection…");
    expect(await win.locator(".agent-composer .agent-chip, [data-testid='agent-context-chip']").count()).toBe(0);
    expect(await pills.count()).toBe(0);

    await paste();
    await expect.poll(() => pills.count()).toBe(1);
    expect(await pills.textContent()).toBe("Pay button");
    expect(await pills.getAttribute("title")).toBe("QkpksTeC · designs/checkout.lamsa.json");
    expect(await input.textContent()).not.toContain("{");

    // Backspace takes the pill out whole (the first one removes the space after it).
    await win.keyboard.press("Backspace");
    await win.keyboard.press("Backspace");
    await expect.poll(() => pills.count()).toBe(0);
    await expect.poll(() => input.textContent()).toBe("");

    await paste("QkpksTeC please, not abcd1234");
    await expect.poll(() => pills.count()).toBe(1);
    expect(await input.textContent()).toBe("Pay button please, not abcd1234");

    await input.press("Enter");
    await expect.poll(() => thread().textContent(), { timeout: 15_000 }).toContain("You said: Pay button please, not abcd1234");
    await idle();
    expect(await input.textContent()).toBe("");
    // The agent got the layer as a link with its id.
    const transcripts = readdirSync(claudeProjects, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"));
    const prompts = transcripts.map((name) => readFileSync(join(claudeProjects, name), "utf8")).join("\n");
    expect(prompts).toContain(JSON.stringify("[Pay button](lamsa:QkpksTeC) please, not abcd1234"));
    await expect.poll(() => win.getByTestId("agent-title").textContent()).toBe("Pay button please, not abcd1234");

    // In the thread, the user's message and the reply both show the layer as a pill that selects it.
    const threadPills = thread().getByTestId("agent-layer-pill");
    await expect.poll(() => threadPills.count()).toBe(2);
    const userPill = win.getByTestId("agent-user-message").last().getByTestId("agent-layer-pill");
    expect(await userPill.textContent()).toBe("Pay button");
    await win.getByTestId("canvas").click({ position: { x: 5, y: 5 } });
    await expect.poll(sessionSelection).toEqual([]);
    await userPill.click();
    await expect.poll(sessionSelection).toEqual(["QkpksTeC"]);
  });

  it("explains when claude isn't installed, and recovers when it is", async () => {
    const configFile = join(chatRoot, "lamsa.config.json");
    const original = readFileSync(configFile, "utf8");
    const config = JSON.parse(original);
    writeFileSync(configFile, JSON.stringify({ ...config, agent: { command: "/nowhere/claude", args: [] } }, null, 2));
    await expect.poll(() => win.getByTestId("agent-notice").textContent(), { timeout: 10_000 }).toContain("isn't installed");
    writeFileSync(configFile, original);
    await win.getByTestId("agent-input").waitFor({ timeout: 10_000 });
  });

  it("keeps the chat in a readable centred column when docked in the wide bottom panel", async () => {
    await win.getByTestId("agent-new-chat").click();
    await win.locator(".agent-suggestion").first().waitFor();
    await win.locator('[data-panel-tab="agent"]').focus();
    await win.keyboard.press("Shift+F10");
    await win.getByTestId("panel-tab-menu").locator('[data-dock-target="centre"]').click();
    const dock = win.getByTestId("dock-centre");
    await dock.locator('[data-panel-tab="agent"]').waitFor();
    const column = () =>
      dock.evaluate((element) => {
        const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
        const panel = box(".agent");
        return [".agent-composer-box", ".agent-suggestions"].map((selector) => {
          const rect = box(selector);
          return { panel: Math.round(panel.width), width: Math.round(rect.width), offCentre: Math.round(Math.abs(rect.left + rect.width / 2 - (panel.left + panel.width / 2))) };
        });
      });
    await expect.poll(async () => (await column())[0]!.panel).toBeGreaterThan(760);
    for (const { width, offCentre } of await column()) {
      expect(width).toBeLessThanOrEqual(684);
      expect(width).toBeGreaterThan(600);
      expect(offCentre).toBeLessThanOrEqual(2);
    }
    await win.locator('[data-panel-tab="agent"]').focus();
    await win.keyboard.press("Shift+F10");
    await win.getByTestId("panel-tab-menu").locator('[data-dock-target="left"]').click();
    await win.getByTestId("dock-left").locator('[data-panel-tab="agent"]').waitFor();
    const narrow = await win.getByTestId("dock-left").evaluate((element) => {
      const panel = element.querySelector(".agent")!.getBoundingClientRect();
      const box = element.querySelector(".agent-composer-box")!.getBoundingClientRect();
      return Math.round(panel.width - box.width);
    });
    expect(narrow).toBeLessThanOrEqual(24);
  });
});

describe("desktop editor agent changes and presence", () => {
  let presenceRoot: string;
  let presenceApp: ElectronApplication;
  let win: Page;
  const checkout = () => join(presenceRoot, "designs/checkout.lamsa.json");
  const design = () => JSON.parse(readFileSync(checkout(), "utf8")) as { nodes: Record<string, Record<string, unknown>> };
  const agent = (...args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, "--json", ...args], {
      cwd: presenceRoot,
      encoding: "utf8",
      env: { ...process.env, LAMSA_AGENT_NAME: "Tester", CLAUDECODE: "" },
    });
    return JSON.parse(result.stdout || "{}") as Record<string, unknown>;
  };
  const flashOn = (id: string) => win.locator(`.ov-flash[data-flash-id="${id}"]`);
  const rowFlashOn = (id: string) => win.locator(`.layer-row[data-layer-id="${id}"] .layer-flash`);
  const cursor = () => win.getByTestId("agent-cursor");
  const waitForQuiet = async () => {
    await win.locator(".ov-flash").first().waitFor({ state: "detached", timeout: 8000 });
    await cursor().waitFor({ state: "detached", timeout: 8000 });
  };

  beforeAll(async () => {
    presenceRoot = mkdtempSync(join(tmpdir(), "lamsa-presence-"));
    copyExample(presenceRoot);
    presenceApp = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", presenceRoot],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await presenceApp.firstWindow();
    await win.getByTestId("layers-panel").waitFor();
    await win.waitForTimeout(400);
  }, 60_000);

  afterAll(async () => {
    await presenceApp?.close();
  });

  it("highlights a layer the agent adds on the canvas and in the layers panel, with its cursor there, then fades both", async () => {
    const added = agent("add", "--parent", "7qOxePB7", "--tree", JSON.stringify({ type: "text", name: "Agent line", content: "Added by the agent" }));
    const [id] = added.rootIds as string[];
    await flashOn(id!).waitFor({ timeout: 10_000 });
    await rowFlashOn(id!).waitFor();
    await win.getByTestId("toasts").getByRole("button", { name: "Show changes" }).first().waitFor();
    const [flashBox, layerBox] = await win.evaluate((nodeId) => {
      const flash = document.querySelector(`.ov-flash[data-flash-id="${nodeId}"]`)!.getBoundingClientRect();
      const host = [...document.querySelectorAll(".frame-host")].map((h) => h.shadowRoot?.querySelector(`[data-node-id="${nodeId}"]`)).find(Boolean)!;
      const layer = host.getBoundingClientRect();
      return [flash, layer].map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }));
    }, id!);
    expect(flashBox).toEqual(layerBox);
    // An overlay only: nothing about the highlight reaches the design.
    expect(JSON.stringify(design().nodes[id!])).not.toMatch(/flash|highlight/);

    await cursor().waitFor();
    expect(await cursor().getAttribute("data-target")).toBe(id);
    expect(await cursor().getAttribute("data-kind")).toBe("write");
    expect(await cursor().textContent()).toBe("Tester");

    await flashOn(id!).waitFor({ state: "detached", timeout: 4000 });
    expect(await rowFlashOn(id!).count()).toBe(0);
    await cursor().waitFor({ state: "detached", timeout: 6000 });
  });

  it("restarts the highlight when the agent changes the same layer again, without stacking a second one", async () => {
    await waitForQuiet();
    const data = design();
    (data.nodes.LnRn8NkJ as { content?: string }).content = "First agent pass";
    writeFileSync(checkout(), JSON.stringify(data, null, 2));
    await flashOn("LnRn8NkJ").waitFor({ timeout: 10_000 });
    await flashOn("LnRn8NkJ").evaluate((element) => element.setAttribute("data-first", ""));
    await win.waitForTimeout(1200);
    (data.nodes.LnRn8NkJ as { content?: string }).content = "Second agent pass";
    writeFileSync(checkout(), JSON.stringify(data, null, 2));
    await win.locator('.ov-flash[data-flash-id="LnRn8NkJ"]:not([data-first])').waitFor({ timeout: 10_000 });
    expect(await flashOn("LnRn8NkJ").count()).toBe(1);
    // Past when the first highlight would have ended, the restarted one is still there.
    await win.waitForTimeout(1200);
    expect(await flashOn("LnRn8NkJ").count()).toBe(1);
  });

  it("moves the cursor faintly to what the agent reads, without highlighting it", async () => {
    await waitForQuiet();
    agent("tree", "qrAB98yG");
    await cursor().waitFor({ timeout: 10_000 });
    expect(await cursor().getAttribute("data-kind")).toBe("read");
    expect(await cursor().getAttribute("data-target")).toBe("qrAB98yG");
    expect(await cursor().textContent()).toBe("Tester · reading");
    expect(Number(await cursor().locator(".agent-cursor-arrow").evaluate((element) => getComputedStyle(element).opacity))).toBeLessThan(1);
    // The label sits beside the layer, never over it.
    const [label, layer] = await win.evaluate((nodeId) => {
      const host = [...document.querySelectorAll(".frame-host")].map((h) => h.shadowRoot?.querySelector(`[data-node-id="${nodeId}"]`)).find(Boolean)!;
      return [document.querySelector(".agent-cursor-label")!.getBoundingClientRect(), host.getBoundingClientRect()].map((r) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    }, "qrAB98yG");
    expect(label!.left).toBeGreaterThanOrEqual(layer!.right);
    expect(await win.locator(".ov-flash").count()).toBe(0);
  });

  it("doesn't highlight the user's own edits or their undo", async () => {
    await waitForQuiet();
    await win.getByTestId("layers-panel").locator('.layer-row[data-layer-id="Rwwc3Sdq"]').click();
    const gap = win.getByTestId("properties-panel").locator(".field", { hasText: /^gap/ }).locator("input").first();
    await gap.fill("14");
    await gap.press("Enter");
    await expect.poll(() => design().nodes["Rwwc3Sdq"]?.style).toMatchObject({ gap: 14 });
    await win.locator(".canvas").click({ position: { x: 700, y: 120 } }).catch(() => {});
    await win.keyboard.press("Control+z");
    await expect.poll(() => (design().nodes["Rwwc3Sdq"]?.style as Record<string, unknown>)?.gap).not.toBe(14);
    await win.waitForTimeout(800);
    expect(await win.locator(".ov-flash").count()).toBe(0);
    expect(await win.locator(".layer-flash").count()).toBe(0);
    expect(await cursor().count()).toBe(0);
  });

  it("shows a whole added subtree as one highlight, and merges a large rewrite to its frame", async () => {
    await waitForQuiet();
    const children = Array.from({ length: 60 }, (_, i) => ({ type: "text", name: `Line ${i}`, content: `Line ${i}` }));
    const added = agent("add", "--parent", "7qOxePB7", "--tree", JSON.stringify({ type: "frame", name: "Agent list", children }));
    const [listId] = added.rootIds as string[];
    await flashOn(listId!).waitFor({ timeout: 10_000 });
    expect(await win.locator(".ov-flash").count()).toBe(1);

    await waitForQuiet();
    const data = design();
    for (const node of Object.values(data.nodes)) if (node.parentId === listId) node.content = `${node.content} (edited)`;
    writeFileSync(checkout(), JSON.stringify(data, null, 2));
    await flashOn("08JQi0tV").waitFor({ timeout: 10_000 });
    expect(await win.locator(".ov-flash").count()).toBe(1);
    expect(await cursor().getAttribute("data-target")).toBe("08JQi0tV");
  });

  it("shows and removes the highlight without fading when the system asks for reduced motion", async () => {
    await waitForQuiet();
    await win.emulateMedia({ reducedMotion: "reduce" });
    try {
      const data = design();
      (data.nodes.LnRn8NkJ as { content?: string }).content = "Reduced motion pass";
      writeFileSync(checkout(), JSON.stringify(data, null, 2));
      await flashOn("LnRn8NkJ").waitFor({ timeout: 10_000 });
      const style = await flashOn("LnRn8NkJ").evaluate((element) => ({ animation: getComputedStyle(element).animationName, opacity: getComputedStyle(element).opacity }));
      expect(style).toEqual({ animation: "none", opacity: "1" });
      await flashOn("LnRn8NkJ").waitFor({ state: "detached", timeout: 4000 });
    } finally {
      await win.emulateMedia({ reducedMotion: null });
    }
  });
});
