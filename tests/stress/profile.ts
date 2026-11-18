/**
 * CPU-profiles one interaction in the real app and prints the functions with the most self time.
 *
 *   node --experimental-strip-types tests/stress/profile.ts 30000 <layers|properties|select|drag|search|external>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type Page } from "playwright-core";
import { makeStressProject } from "./fixture.ts";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

function topSelfTime(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }, count = 20): string[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, i) => {
    const frame = byId.get(id)!.callFrame;
    const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber}`;
    self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${key}`);
}

const [size = "30000", interaction = "layers"] = process.argv.slice(2);
const root = makeStressProject({ nodes: Number(size) });
const app = await _electron.launch({ executablePath: ELECTRON, args: [DESKTOP, "--root", root], env: { ...process.env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" } });
const page: Page = await app.firstWindow();
await page.locator('[data-testid="layers-panel"] .layer-row').first().waitFor({ timeout: 120_000 });
await page.waitForTimeout(3000);
const cdp = await page.context().newCDPSession(page);
const tracing = process.env.TRACE === "1";
const traceEvents: { name: string; ph: string; dur?: number; tid: number }[] = [];
if (tracing) {
  cdp.on("Tracing.dataCollected", (event: { value: typeof traceEvents }) => void traceEvents.push(...event.value));
  await cdp.send("Tracing.start", { categories: "devtools.timeline,blink,cc,disabled-by-default-devtools.timeline", transferMode: "ReportEvents" });
}
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
if (interaction === "layers") {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Control+BracketLeft");
    await page.waitForTimeout(600);
  }
} else if (interaction === "properties") {
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Control+BracketRight");
    await page.waitForTimeout(600);
  }
} else if (interaction === "select") {
  await page.locator('[data-testid="layers-panel"] .layer-row').nth(4).click();
  await page.waitForTimeout(600);
} else if (interaction === "search") {
  await page.locator('[data-testid="layers-panel"] .search input').pressSequentially("Screen 12");
  await page.waitForTimeout(600);
} else if (interaction === "drag") {
  const from = await page.evaluate(() => {
    for (const label of document.querySelectorAll<HTMLElement>(".frame-label")) {
      const box = label.getBoundingClientRect();
      const point = { x: box.left + 8, y: box.top + box.height / 2 };
      if (document.elementFromPoint(point.x, point.y) === label) return point;
    }
    throw new Error("no frame label is under the pointer");
  });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(from.x + step * 6, from.y + step * 3);
  await page.mouse.up();
  await page.waitForTimeout(800);
} else if (interaction === "external") {
  const path = join(root, "designs/stress-1.lamsa.json");
  const design = JSON.parse(readFileSync(path, "utf8")) as { nodes: Record<string, Record<string, unknown>> };
  const first = Object.keys(design.nodes)[0]!;
  design.nodes[first]!.name = "Renamed";
  writeFileSync(path, JSON.stringify(design, null, 2));
  await page.waitForTimeout(3000);
}
const { profile } = await cdp.send("Profiler.stop");
console.log(topSelfTime(profile as never).join("\n"));
if (tracing) {
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  await done;
  const totals = new Map<string, number>();
  for (const event of traceEvents) if (event.ph === "X" && event.dur) totals.set(event.name, (totals.get(event.name) ?? 0) + event.dur / 1000);
  console.log([...totals].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, ms]) => `${ms.toFixed(0).padStart(6)} ms  ${name}`).join("\n"));
}
await app.close();
