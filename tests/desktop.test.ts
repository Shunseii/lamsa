import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** The example project as committed, so local experiments in examples/ don't change test results. */
function copyExample(dest: string) {
  const archive = spawnSync("git", ["archive", "HEAD", "examples/shadcn-app"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", dest, "--strip-components=2"], { input: archive.stdout });
  if (archive.status !== 0 || untar.status !== 0) throw new Error(`could not copy the example: ${archive.stderr}${untar.stderr}`);
}

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

  it("explains why layers can't be grouped", async () => {
    const layers = win.getByTestId("layers-panel");
    await layers.locator(".layer-name", { hasText: /^Button$/ }).first().click();
    await layers.locator(".layer-name", { hasText: /^Input$/ }).first().click({ modifiers: ["Control"] });
    await win.keyboard.press("Control+g");
    await expect.poll(() => win.getByTestId("toasts").textContent()).toContain("Main components stay at the top level");
  });
});
