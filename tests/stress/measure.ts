/**
 * Measures editor interactions in the real Electron app against generated stress projects.
 *
 *   pnpm build && node --experimental-strip-types tests/stress/measure.ts [2000 10000 30000]
 *
 * Each number is the median of a few runs: milliseconds from the input until the change is on
 * screen (the frame after the DOM reflects it), and the long-task time (main-thread work in
 * tasks over 50ms) spent in that window.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type Page } from "playwright-core";
import { makeStressProject } from "./fixture.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");
const RUNS = 3;

interface Sample {
  ms: number;
  blocked: number;
}

declare global {
  interface Window {
    __stress?: { start: number; blocked: number[]; observer: PerformanceObserver };
  }
}

async function begin(page: Page) {
  await page.evaluate(() => {
    const blocked: number[] = [];
    const observer = new PerformanceObserver((list) => blocked.push(...list.getEntries().map((entry) => entry.duration)));
    observer.observe({ type: "longtask" });
    window.__stress = { start: performance.now(), blocked, observer };
  });
}

/** Waits until `ready` holds, then for the next painted frame, and returns the elapsed time. */
async function settle(page: Page, ready: string): Promise<Sample> {
  return page.evaluate(async (expression) => {
    const check = new Function(`return (${expression});`) as () => boolean;
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const deadline = performance.now() + 30_000;
    while (!check()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${expression}`);
      await frame();
    }
    await frame();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stress = window.__stress!;
    const ms = performance.now() - stress.start;
    await new Promise((resolve) => setTimeout(resolve, 60));
    stress.blocked.push(...stress.observer.takeRecords().map((entry) => entry.duration));
    stress.observer.disconnect();
    return { ms, blocked: stress.blocked.reduce((sum, d) => sum + d, 0) };
  }, ready);
}

async function measure(page: Page, { act, ready }: { act: () => Promise<void>; ready: string }): Promise<Sample> {
  await begin(page);
  await act();
  return settle(page, ready);
}

function median(samples: Sample[]): Sample {
  const pick = (values: number[]) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  return { ms: Math.round(pick(samples.map((s) => s.ms))), blocked: Math.round(pick(samples.map((s) => s.blocked))) };
}

async function repeat(times: number, run: () => Promise<Sample>): Promise<Sample> {
  const samples: Sample[] = [];
  for (let i = 0; i < times; i++) samples.push(await run());
  return median(samples);
}

const LAYERS_PANEL = `document.querySelector('[data-testid="layers-panel"]')`;
const PROPERTIES_PANEL = `document.querySelector('[data-testid="properties-panel"]')`;

export async function measureSize(size: number): Promise<Record<string, Sample>> {
  const root = makeStressProject({ nodes: size });
  const designs = ["stress-0", "stress-1"].map((name) => JSON.parse(readFileSync(join(root, `designs/${name}.lamsa.json`), "utf8")) as { nodes: Record<string, Record<string, unknown>> });
  const firstRoot = Object.entries(designs[1]!.nodes).find(([, node]) => node.parentId === undefined)![0];
  const results: Record<string, Sample> = {};

  const launchedAt = Date.now();
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [DESKTOP, "--root", root],
    env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
  });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-testid="layers-panel"] .layer-row').first().waitFor({ timeout: 120_000 });
    await page.locator(`[data-root-id="${firstRoot}"]`).waitFor({ state: "attached", timeout: 120_000 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    results["initial load"] = { ms: Date.now() - launchedAt, blocked: 0 };
    await page.waitForTimeout(1500);

    results["layers close"] = await repeat(RUNS, async () => {
      const sample = await measure(page, { act: () => page.keyboard.press("Control+BracketLeft"), ready: `!${LAYERS_PANEL}` });
      await measure(page, { act: () => page.keyboard.press("Control+BracketLeft"), ready: `${LAYERS_PANEL}?.querySelector(".layer-row")` });
      await page.waitForTimeout(300);
      return sample;
    });
    results["layers open"] = await repeat(RUNS, async () => {
      await measure(page, { act: () => page.keyboard.press("Control+BracketLeft"), ready: `!${LAYERS_PANEL}` });
      await page.waitForTimeout(300);
      const sample = await measure(page, { act: () => page.keyboard.press("Control+BracketLeft"), ready: `${LAYERS_PANEL}?.querySelector(".layer-row")` });
      await page.waitForTimeout(300);
      return sample;
    });
    results["properties toggle"] = await repeat(RUNS, async () => {
      const closed = await measure(page, { act: () => page.keyboard.press("Control+BracketRight"), ready: `!${PROPERTIES_PANEL}` });
      const opened = await measure(page, { act: () => page.keyboard.press("Control+BracketRight"), ready: `${PROPERTIES_PANEL}` });
      await page.waitForTimeout(300);
      return { ms: closed.ms + opened.ms, blocked: closed.blocked + opened.blocked };
    });

    let rowIndex = 3;
    results["select layer"] = await repeat(RUNS, async () => {
      const row = page.locator('[data-testid="layers-panel"] .layer-row').nth(rowIndex++);
      const id = await row.getAttribute("data-layer-id");
      const sample = await measure(page, {
        act: () => row.click(),
        ready: `document.querySelector('.layer-row.is-selected[data-layer-id="${id}"]') && document.querySelector(".props-header")`,
      });
      await page.waitForTimeout(200);
      return sample;
    });

    results["drag frame"] = await repeat(RUNS, async () => {
      const target = await page.evaluate(() => {
        for (const label of document.querySelectorAll<HTMLElement>(".frame-label")) {
          const box = label.getBoundingClientRect();
          const point = { x: box.left + 8, y: box.top + box.height / 2 };
          if (document.elementFromPoint(point.x, point.y) === label) return { id: label.dataset.labelFor!, point };
        }
        throw new Error("no frame label is under the pointer");
      });
      const from = target.point;
      const draggedRoot = target.id;
      const before = await page.evaluate((id) => document.querySelector<HTMLElement>(`[data-root-id="${id}"]`)!.parentElement!.style.left, draggedRoot);
      const sample = await measure(page, {
        act: async () => {
          await page.mouse.move(from.x, from.y);
          await page.mouse.down();
          for (let step = 1; step <= 10; step++) await page.mouse.move(from.x + step * 6, from.y + step * 3);
          await page.mouse.up();
        },
        ready: `document.querySelector('[data-root-id="${draggedRoot}"]').parentElement.style.left !== ${JSON.stringify(before)}`,
      });
      await page.waitForTimeout(300);
      return sample;
    });

    const search = page.locator('[data-testid="layers-panel"] .search input');
    results["type in search"] = await repeat(RUNS, async () => {
      await search.click();
      const sample = await measure(page, {
        act: () => search.pressSequentially("Screen 12"),
        ready: `document.querySelector('[data-testid="layers-panel"] .search input').value === "Screen 12"`,
      });
      await search.fill("");
      await page.waitForTimeout(500);
      return sample;
    });

    let edit = 0;
    results["external change"] = await repeat(RUNS, async () => {
      const path = join(root, "designs/stress-1.lamsa.json");
      const design = JSON.parse(readFileSync(path, "utf8")) as { nodes: Record<string, Record<string, unknown>> };
      const name = `Renamed ${edit++}`;
      design.nodes[firstRoot]!.name = name;
      const sample = await measure(page, {
        act: async () => writeFileSync(path, JSON.stringify(design, null, 2)),
        ready: `document.querySelector('[data-label-for="${firstRoot}"]')?.textContent.includes(${JSON.stringify(name)})`,
      });
      await page.waitForTimeout(2000);
      return sample;
    });
  } finally {
    await app.close();
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sizes = process.argv.slice(2).map(Number);
  const table: Record<string, Record<string, string>> = {};
  for (const size of sizes.length ? sizes : [2000, 10000, 30000]) {
    const results = await measureSize(size);
    for (const [name, sample] of Object.entries(results)) {
      table[name] ??= {};
      table[name]![`${size}`] = sample.blocked ? `${sample.ms} ms (${sample.blocked} blocked)` : `${sample.ms} ms`;
    }
    console.error(`measured ${size}`);
  }
  console.table(table);
}
