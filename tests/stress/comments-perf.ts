/**
 * Pan and zoom cost on a large project with and without comment pins, in the real Electron app.
 *
 *   pnpm build && node --experimental-strip-types tests/stress/comments-perf.ts [30000] [pins]
 *
 * For each case it scrolls the canvas one wheel step per frame (pan, then ctrl-wheel zoom) and reports the median and
 * slowest frame, plus the style and layout time Chrome spent per step.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type Page } from "playwright-core";
import { makeStressProject } from "./fixture.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");
const STEPS = 90;

/** Pins comments on `count` layers spread through the first design file, near the top of the canvas so they're on screen. */
function addComments(root: string, count: number) {
  const file = readdirSync(join(root, "designs")).filter((name) => name.startsWith("stress-")).sort()[0]!;
  const nodes = (JSON.parse(readFileSync(join(root, "designs", file), "utf8")) as { nodes: Record<string, { parentId?: string }> }).nodes;
  const ids = Object.keys(nodes).filter((id) => nodes[id]!.parentId);
  mkdirSync(join(root, "designs/comments"), { recursive: true });
  for (let i = 0; i < count; i++) {
    const nodeId = ids[Math.floor((i * ids.length) / count / 4)]!;
    const id = `Perf${String(i).padStart(4, "0")}`;
    writeFileSync(
      join(root, "designs/comments", `${id}.json`),
      JSON.stringify({ version: 1, nodeId, offset: { x: 4, y: 4 }, author: i % 2 ? "Claude" : "Sara", createdAt: new Date(Date.UTC(2026, 10, 20, 10, i)).toISOString(), text: `Comment ${i}`, replies: [] }),
    );
  }
}

async function sweep(page: Page, { zoom }: { zoom: boolean }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const work = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
    return (value("RecalcStyleDuration") + value("LayoutDuration")) * 1000;
  };
  const before = await work();
  const frames = await page.evaluate(
    async ({ steps, zoom }) => {
      const canvas = document.querySelector<HTMLElement>(".canvas")!;
      const box = canvas.getBoundingClientRect();
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      let previous = await frame();
      const times: number[] = [];
      for (let i = 0; i < steps; i++) {
        const direction = Math.floor(i / 15) % 2 ? -1 : 1;
        canvas.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: zoom ? 0 : 24 * direction,
            deltaY: zoom ? -20 * direction : 16 * direction,
            ctrlKey: zoom,
            clientX: box.left + box.width / 2,
            clientY: box.top + box.height / 2,
            bubbles: true,
            cancelable: true,
          }),
        );
        const now = await frame();
        times.push(now - previous);
        previous = now;
      }
      return times;
    },
    { steps: STEPS, zoom },
  );
  const styleLayout = (await work()) - before;
  const sorted = [...frames].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)]!, slowest: sorted.at(-1)!, styleLayoutPerStep: styleLayout / STEPS };
}

async function run({ nodes, pins }: { nodes: number; pins: number }) {
  const root = makeStressProject({ nodes });
  if (pins) addComments(root, pins);
  const app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP, "--root", root], env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" } });
  try {
    const page = await app.firstWindow();
    await page.locator('[data-testid="layers-panel"] .layer-row').first().waitFor({ timeout: 120_000 });
    if (pins) await page.locator('[data-testid="comment-pin"]').first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const shownPins = await page.locator('[data-testid="comment-pin"]').count();
    const pan = await sweep(page, { zoom: false });
    const zoom = await sweep(page, { zoom: true });
    return { pins: shownPins, pan, zoom };
  } finally {
    await app.close();
  }
}

const nodes = Number(process.argv[2] ?? 30_000);
const pins = Number(process.argv[3] ?? 40);
const fmt = (sample: { median: number; slowest: number; styleLayoutPerStep: number }) =>
  `median frame ${sample.median.toFixed(1)} ms, slowest ${sample.slowest.toFixed(1)} ms, style+layout ${sample.styleLayoutPerStep.toFixed(2)} ms/step`;
for (const count of [0, pins]) {
  const result = await run({ nodes, pins: count });
  console.log(`${nodes} layers, ${result.pins} pins on screen\n  pan:  ${fmt(result.pan)}\n  zoom: ${fmt(result.zoom)}`);
}
