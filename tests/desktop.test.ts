import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function copyExample(dest: string, { openAll = true }: { openAll?: boolean } = {}) {
  const archive = spawnSync("git", ["archive", "HEAD", "examples/shadcn-app"], { cwd: repo, maxBuffer: 64 * 1024 * 1024 });
  const untar = spawnSync("tar", ["-x", "-C", dest, "--strip-components=2"], { input: archive.stdout });
  if (archive.status !== 0 || untar.status !== 0) throw new Error(`could not copy the example: ${archive.stderr}${untar.stderr}`);
  // The motion showcase is for people trying the example; the tests' canvas positions and file counts assume the other two files.
  rmSync(join(dest, "designs/motion.lamsa.json"), { force: true });
  if (!openAll) return;
  // Most tests want every file open, as if the user had already answered the first-open prompt.
  const designs = readdirSync(join(dest, "designs")).filter((name) => name.endsWith(".lamsa.json"));
  mkdirSync(join(dest, ".lamsa"), { recursive: true });
  writeFileSync(join(dest, ".lamsa/session.json"), JSON.stringify({ selection: [], open: designs.map((name) => `designs/${name}`) }));
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
          .filter((label) => !label.closest(".frame-slot")!.matches(":hover") && !label.classList.contains("is-selected"))
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

    await panel.getByTestId("preview-fullscreen").click();
    const props = (await win.getByTestId("properties-panel").boundingBox())!;
    const full = (await panel.boundingBox())!;
    expect(full.height).toBeGreaterThan(500);
    expect(full.x + full.width).toBeLessThanOrEqual(props.x);
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
    await expect.poll(() => win.getByTestId("toggle-preview").getAttribute("class")).toContain("is-active");

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
    await win.getByTestId("toggle-preview").click();
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
    await expect.poll(() => layers.evaluate((element) => element.parentElement?.getAttribute("data-state"))).toBe("closed");
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
  const fileHeaders = () => win.getByTestId("layers-panel").locator(".layer-file").allTextContents();
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
    await expect.poll(() => win.getByTestId("status-bar").textContent()).toContain(`${roots.length} selected`);
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
        .poll(() => page.getByTestId("layers-panel").locator(".layer-file").allTextContents())
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
      await expect.poll(() => page.getByTestId("layers-panel").locator(".layer-file").allTextContents()).toEqual(["checkout.lamsa.json"]);
    } finally {
      await other.close();
    }
  }, 60_000);
});
