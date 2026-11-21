import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeStressProject } from "./stress/fixture.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");

let app: ElectronApplication;
let page: Page;

/** Milliseconds from the shortcut until the frame after `ready` holds. */
async function timeShortcut({ key, ready }: { key: string; ready: string }): Promise<number> {
  const start = await page.evaluate(() => performance.now());
  await page.keyboard.press(key);
  return page.evaluate(
    async ({ expression, start }) => {
      const check = new Function(`return (${expression});`) as () => boolean;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      while (!check()) await frame();
      await frame();
      return performance.now() - start;
    },
    { expression: ready, start },
  );
}

describe("editor with a large project", () => {
  beforeAll(async () => {
    const root = makeStressProject({ nodes: 10_000 });
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", root],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    page = await app.firstWindow();
    await page.getByTestId("layers-panel").locator(".layer-row").first().waitFor({ timeout: 60_000 });
  }, 90_000);

  afterAll(async () => {
    await app?.close();
  });

  it("renders only the layer rows near the view", async () => {
    const rows = await page.getByTestId("layers-panel").locator(".layer-row").count();
    expect(rows).toBeGreaterThan(10);
    expect(rows).toBeLessThan(200);
  });

  it("toggles the layers panel quickly", async () => {
    const panel = `document.querySelector('[data-testid="layers-panel"]')`;
    // Generous bounds: before the list was virtualised these took seconds at this size.
    expect(await timeShortcut({ key: "Control+BracketLeft", ready: `!${panel}` })).toBeLessThan(1000);
    expect(await timeShortcut({ key: "Control+BracketLeft", ready: `${panel}?.querySelector(".layer-row")` })).toBeLessThan(1000);
  });

  it("drags a panel tab between docks without touching the canvas until the drop", async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const styleWork = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
      return { recalcs: value("RecalcStyleCount"), recalcMs: value("RecalcStyleDuration") * 1000, layoutMs: value("LayoutDuration") * 1000 };
    };
    const tab = (await page.locator('[data-panel-tab="components"]').boundingBox())!;
    const zone = async () => (await page.getByTestId("dock-zone-right").boundingBox())!;
    const moves = 60;
    const sweep = async (end: { x: number; y: number }) => {
      for (let i = 1; i <= moves; i++) await page.mouse.move(tab.x + 40 + ((end.x - tab.x - 40) * i) / moves, tab.y + 40 + ((end.y - tab.y - 40) * i) / moves);
    };
    // The same pointer path without a drag, for comparison: plain hovering over the panels and canvas.
    const end = { x: 1250, y: tab.y + 340 };
    await page.mouse.move(tab.x + 40, tab.y + 40);
    const idleBefore = await styleWork();
    await sweep(end);
    const idle = await styleWork();
    await page.evaluate(() => {
      const counts = { canvas: 0 };
      new MutationObserver((records) => (counts.canvas += records.length)).observe(document.querySelector(".canvas")!, { subtree: true, childList: true, attributes: true });
      (window as unknown as { __dockDrag: typeof counts }).__dockDrag = counts;
    });
    await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
    await page.mouse.down();
    await page.mouse.move(tab.x + 40, tab.y + 40, { steps: 2 });
    const target = await zone();
    const before = await styleWork();
    await sweep({ x: target.x + target.width / 2, y: end.y });
    const during = await styleWork();
    const dropStart = await page.evaluate(() => performance.now());
    await page.mouse.up();
    const dropMs = await page.evaluate(async (start) => {
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      while (!document.querySelector('[data-testid="dock-right"] [data-testid="components-panel"]')) await frame();
      await frame();
      return performance.now() - start;
    }, dropStart);
    const canvasMutations = await page.evaluate(() => (window as unknown as { __dockDrag: { canvas: number } }).__dockDrag.canvas);
    const perMove = { recalcMs: (during.recalcMs - before.recalcMs) / moves, layoutMs: (during.layoutMs - before.layoutMs) / moves };
    const idlePerMove = ((idle.recalcMs - idleBefore.recalcMs) + (idle.layoutMs - idleBefore.layoutMs)) / moves;
    console.log(
      `tab drag over ${moves} moves: ${perMove.recalcMs.toFixed(3)} ms style + ${perMove.layoutMs.toFixed(3)} ms layout per move ` +
        `(plain hover on the same path: ${idlePerMove.toFixed(3)} ms); drop on screen in ${dropMs.toFixed(0)} ms; canvas mutations ${canvasMutations}`,
    );
    expect(canvasMutations).toBe(0);
    expect(perMove.recalcMs + perMove.layoutMs).toBeLessThan(2);
    expect(dropMs).toBeLessThan(1000);
    await page.keyboard.press("Control+Alt+0");
  });

  it("opens and closes the preview dock without touching or restyling the canvas", async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const styleMs = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
      return (value("RecalcStyleDuration") + value("LayoutDuration")) * 1000;
    };
    await page.evaluate(() => {
      const counts = { canvas: 0 };
      new MutationObserver((records) => (counts.canvas += records.length)).observe(document.querySelector(".canvas")!, { subtree: true, childList: true, attributes: true });
      (window as unknown as { __previewDock: typeof counts }).__previewDock = counts;
    });
    const dock = `document.querySelector('[data-testid="dock-centre"]')`;
    // The left panel's toggle restyles the same editor-level classes, so it's the yardstick.
    const leftBefore = await styleMs();
    await timeShortcut({ key: "Control+BracketLeft", ready: `!document.querySelector('[data-testid="dock-left"]')` });
    await timeShortcut({ key: "Control+BracketLeft", ready: `document.querySelector('[data-testid="dock-left"] .layer-row')` });
    const leftMs = (await styleMs()) - leftBefore;
    const before = await styleMs();
    const openMs = await timeShortcut({ key: "Control+6", ready: `${dock}?.querySelector('[data-testid="preview-empty"]')` });
    const closeMs = await timeShortcut({ key: "Control+'", ready: `!${dock}` });
    const previewMs = (await styleMs()) - before;
    const canvasMutations = await page.evaluate(() => (window as unknown as { __previewDock: { canvas: number } }).__previewDock.canvas);
    console.log(
      `preview dock: open ${openMs.toFixed(0)} ms, close ${closeMs.toFixed(0)} ms, ${previewMs.toFixed(1)} ms style + layout ` +
        `(left panel hide + show: ${leftMs.toFixed(1)} ms); canvas mutations ${canvasMutations}`,
    );
    expect(canvasMutations).toBe(0);
    expect(openMs).toBeLessThan(1000);
    expect(previewMs).toBeLessThan(Math.max(30, leftMs * 2));
  });

  it("scrolls a layer far down the list to the middle when it is selected on the canvas", async () => {
    const target = await page.evaluate(() => {
      for (const host of document.querySelectorAll<HTMLElement>("[data-root-id]")) {
        const inner = [...host.shadowRoot!.querySelectorAll<HTMLElement>("[data-node-id]")].filter((element) => !element.dataset.nodeId!.includes("/")).at(-1);
        if (!inner) continue;
        const r = inner.getBoundingClientRect();
        const center = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        if (r.width < 2 || r.height < 2 || document.elementFromPoint(center.x, center.y) !== host) continue;
        return { id: inner.dataset.nodeId!, ...center };
      }
      throw new Error("no frame is clear of the panels");
    });
    await page.keyboard.down("Control");
    await page.mouse.click(target.x, target.y);
    await page.keyboard.up("Control");
    const row = page.getByTestId("layers-panel").locator(`.layer-row.is-selected[data-layer-id="${target.id}"]`);
    await row.waitFor();
    await expect
      .poll(() =>
        row.evaluate((element) => {
          const box = element.closest(".panel-body")!.getBoundingClientRect();
          const r = element.getBoundingClientRect();
          return Math.abs(r.top + r.height / 2 - (box.top + box.height / 2));
        }),
      )
      .toBeLessThan(2);
  });
});

describe("layers panel with a 60-deep frame chain", () => {
  /** The fixture's first file starts with the chain: `S0000000` is its frame, then 60 levels, then this text at depth 62. */
  const CHAIN = "S0000000";
  const DEEPEST = "S000001p";
  /** The top-level frame right after the chain, so it is in view whenever the deepest row is. */
  const SHALLOW = "S000001q";
  let deep: ElectronApplication;
  let win: Page;
  const body = () => win.getByTestId("layers-panel").locator(".panel-body");
  const scrollTo = (position: { left?: number; top?: number }) =>
    body().evaluate((element, { left, top }) => {
      if (left !== undefined) element.scrollLeft = left === -1 ? element.scrollWidth : left;
      if (top !== undefined) element.scrollTop = top;
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, position);
  const rowBox = (id: string, part: string) =>
    win.locator(`.layer-row[data-layer-id="${id}"]`).evaluate((row, selector) => {
      const scroller = row.closest(".panel-body")!;
      const view = scroller.getBoundingClientRect();
      const left = view.left + scroller.clientLeft;
      const box = (selector ? row.querySelector(selector)! : row).getBoundingClientRect();
      return { left: box.left - left, right: box.right - left, width: box.width, view: scroller.clientWidth };
    }, part);

  beforeAll(async () => {
    const root = makeStressProject({ nodes: 2000 });
    deep = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", root, "--select", DEEPEST],
      env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await deep.firstWindow();
    await win.locator(`.layer-row.is-selected[data-layer-id="${DEEPEST}"]`).waitFor({ timeout: 60_000 });
  }, 90_000);

  afterAll(async () => {
    await deep?.close();
  });

  it("scrolls sideways to show the deepest name when it is selected from outside the list", async () => {
    await expect.poll(() => body().evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    const name = await rowBox(DEEPEST, ".layer-name");
    const trail = await rowBox(DEEPEST, ".layer-trail");
    expect(name.left).toBeGreaterThanOrEqual(0);
    expect(name.width).toBeGreaterThanOrEqual(64);
    expect(trail.left - name.left).toBeGreaterThanOrEqual(64);
    expect(await win.locator(`.layer-row[data-layer-id="${DEEPEST}"] .layer-name`).textContent()).toBe("Bottom of the chain");
  });

  it("keeps the trailing toggles pinned to the right edge at any sideways offset", async () => {
    for (const left of [0, -1]) {
      await scrollTo({ left });
      for (const id of [SHALLOW, DEEPEST]) {
        const trail = await rowBox(id, ".layer-trail");
        expect(trail.right).toBeCloseTo(trail.view - 6, 0);
        expect(trail.width).toBeGreaterThan(30);
        const toggle = await rowBox(id, ".layer-action:last-child");
        expect(toggle.right).toBeCloseTo(toggle.view - 14, 0);
        // Nothing of the row's name shows between the toggles and the panel's edge.
        const behind = await win.locator(`.layer-row[data-layer-id="${id}"]`).evaluate((row) => {
          const scroller = row.closest(".layers-body")!;
          const right = scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
          const box = row.getBoundingClientRect();
          return [8, 3].map((inset) => document.elementFromPoint(right - inset - 1, box.top + box.height / 2)?.closest(".layer-name") != null);
        });
        expect(behind).toEqual([false, false]);
      }
    }
  });

  it("keeps row backgrounds, the search row and file headers spanning the visible width while scrolled sideways", async () => {
    await scrollTo({ left: 300, top: 0 });
    const row = await rowBox(CHAIN, "");
    expect(row.left).toBeLessThanOrEqual(0);
    expect(row.right).toBeGreaterThanOrEqual(row.view);
    const fixed = await body().evaluate((scroller) => {
      const left = scroller.getBoundingClientRect().left + scroller.clientLeft;
      const box = (selector: string) => {
        const r = scroller.querySelector(selector)!.getBoundingClientRect();
        return { left: r.left - left, right: r.right - left };
      };
      return { search: box(".search-row"), file: box(".layer-file"), view: scroller.clientWidth };
    });
    expect(fixed.search.left).toBeCloseTo(0, 0);
    expect(fixed.search.right).toBeCloseTo(fixed.view, 0);
    expect(fixed.file.left).toBeCloseTo(6, 0);
    expect(fixed.file.right).toBeCloseTo(fixed.view - 6, 0);
  });

  it("sizes the sideways scroll from the deepest row in the whole list, so it holds steady while scrolling down", async () => {
    await scrollTo({ left: 0, top: 0 });
    const widths = new Set<number>();
    const height = await body().evaluate((element) => element.scrollHeight);
    for (let top = 0; top < height; top += 2000) {
      await scrollTo({ top });
      widths.add(await body().evaluate((element) => element.scrollWidth));
    }
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBeGreaterThan(62 * 14);
  });

  it("follows the left panel's width: a wider panel scrolls less and the toggles stay pinned", async () => {
    const overflow = () => body().evaluate((element) => element.scrollWidth - element.clientWidth);
    const before = await overflow();
    const handle = win.getByTestId("left-panel-resize");
    const box = (await handle.boundingBox())!;
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.down();
    await win.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 5 });
    await win.mouse.up();
    await expect.poll(overflow).toBe(before - 120);
    await scrollTo({ left: -1, top: 0 });
    const trail = await rowBox(CHAIN, ".layer-trail");
    expect(trail.right).toBeCloseTo(trail.view - 6, 0);
    await handle.dblclick();
  });
});
