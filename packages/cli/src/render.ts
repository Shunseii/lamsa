import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { allFileCss, allNodes, lucideIconSvg } from "@lamsa/core";
import { applyMotionState, buildRenderTree, motionLength, renderDocument, seekAnimations, settleAnimations } from "@lamsa/renderer";
import type { Page } from "playwright-core";
import type { TokenMode } from "@lamsa/schema";
import { chromium, type Browser } from "playwright-core";
import type { Workspace } from "./context.js";
import { CliError, ExitCode } from "./output.js";

const require = createRequire(import.meta.url);

/** Layers to outline in one colour on a second, marked copy of a render. */
export interface Mark {
  ids: string[];
  color: string;
}

export interface RenderedFrame {
  id: string;
  /** With `marks`: the copy with the marked layers outlined. */
  markedPath?: string;
  name?: string;
  path: string;
  width: number;
  height: number;
  mode: TokenMode;
  missingTokens: string[];
  missingIcons: string[];
  /** With `animate`: the moments captured, in ms. */
  times?: number[];
}

const call = (fn: (...args: never[]) => unknown, ...args: unknown[]) =>
  `(${fn.toString()})(${args.map((arg) => (arg === "document" ? "document" : JSON.stringify(arg))).join(", ")})`;

/** Screenshots the frame at evenly spaced moments of its motion and lays them out in one image. */
async function captureStrip({ page, frames, path, label }: { page: Page; frames: number; path: string; label: string }): Promise<number[]> {
  const target = page.locator("#lamsa-render > div").first();
  const length = (await page.evaluate(call(motionLength, "document"))) as number;
  const count = length > 0 ? Math.max(2, frames) : 1;
  const times = Array.from({ length: count }, (_, i) => (count === 1 ? 0 : Math.round((length * i) / (count - 1))));
  const shots: string[] = [];
  for (const time of times) {
    await page.evaluate(call(seekAnimations, "document", time));
    shots.push((await target.screenshot({ omitBackground: true })).toString("base64"));
  }
  const box = (await target.boundingBox())!;
  const cellWidth = Math.min(box.width, 480);
  const cells = shots
    .map(
      (shot, i) =>
        `<figure><img src="data:image/png;base64,${shot}" style="width:${cellWidth}px"><figcaption>${times[i]} ms</figcaption></figure>`,
    )
    .join("");
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#f3f2ee;font:12px ui-monospace,monospace;color:#585955">
<div id="strip" style="display:inline-flex;flex-direction:column;gap:8px;padding:16px">
<div>${label}${length > 0 ? ` · ${length} ms` : " · no animations"}</div>
<div style="display:flex;gap:16px;align-items:flex-start">${cells}</div></div>
<style>figure{margin:0;display:flex;flex-direction:column;gap:6px;align-items:center}img{display:block;background:#fff;outline:1px solid #e2dfd8}</style>
</body></html>`);
  await page.setViewportSize({ width: Math.ceil(32 + count * (cellWidth + 16)), height: 900 });
  await page.locator("#strip").screenshot({ path });
  return times;
}

/**
 * Outlines layers over the render. A layer inside a component instance renders as `<instance>/<layer>`,
 * so a component's own layer IDs find it in every instance.
 */
function drawMarks(marks: Mark[]) {
  const target = document.querySelector("#lamsa-render > div");
  if (!target) return;
  const frame = target.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.id = "lamsa-marks";
  layer.style.cssText = `position:absolute;left:${frame.left + scrollX}px;top:${frame.top + scrollY}px;width:${frame.width}px;height:${frame.height}px;pointer-events:none;z-index:2147483647`;
  for (const { ids, color } of marks) {
    for (const id of ids) {
      const escaped = CSS.escape(id);
      for (const element of Array.from(document.querySelectorAll(`[data-node-id="${escaped}"], [data-node-id$="/${escaped}"]`))) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const outline = document.createElement("div");
        const left = Math.max(0, box.left - frame.left - 2);
        const top = Math.max(0, box.top - frame.top - 2);
        const right = Math.min(frame.width, box.right - frame.left + 2);
        const bottom = Math.min(frame.height, box.bottom - frame.top + 2);
        outline.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;border:2px solid ${color};border-radius:4px;background:color-mix(in srgb, ${color} 12%, transparent);box-sizing:border-box`;
        layer.append(outline);
      }
    }
  }
  document.body.append(layer);
}

function installChromium(log: (message: string) => void) {
  if (process.env.LAMSA_NO_BROWSER_DOWNLOAD) {
    throw new CliError(
      "no Chrome or Chromium found and LAMSA_NO_BROWSER_DOWNLOAD is set",
      ExitCode.renderFailed,
      "install Google Chrome, or unset LAMSA_NO_BROWSER_DOWNLOAD to let lamsa download Chromium once",
    );
  }
  log("lamsa: downloading Chromium for rendering (one time)…");
  const cli = join(dirname(require.resolve("playwright-core/package.json")), "cli.js");
  // Inside the desktop app, process.execPath is Electron; this makes it run the script as Node.
  execFileSync(process.execPath, [cli, "install", "chromium-headless-shell"], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
}

export async function launchBrowser(log: (message: string) => void = () => {}): Promise<Browser> {
  if (!process.env.LAMSA_BUNDLED_CHROMIUM) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      // fall through to the bundled Chromium
    }
  }
  try {
    return await chromium.launch();
  } catch (error) {
    if (!/Executable doesn't exist|install/i.test((error as Error).message)) throw error;
  }
  installChromium(log);
  return chromium.launch();
}

export async function renderFrames({
  workspace,
  ids,
  outDir,
  scale = 2,
  mode,
  naming,
  log,
  animate,
  state,
  marks,
  markedNaming,
}: {
  workspace: Workspace;
  ids: string[];
  outDir: string;
  scale?: number;
  mode?: TokenMode;
  naming: (id: string) => string;
  log?: (message: string) => void;
  /** Capture this many moments of the frame's motion into one strip image. */
  animate?: number;
  /** Put every node into this state first: hover, press, focus, or a `data-state` value. */
  state?: string;
  /** Per frame, layers to outline in a second copy of the render, named by `markedNaming`. */
  marks?: Record<string, Mark[]>;
  markedNaming?: (id: string) => string;
}): Promise<RenderedFrame[]> {
  const { project, tokens, fonts } = workspace;
  const nodes = allNodes(project);
  const fileCss = allFileCss(project);
  const browser = await launchBrowser(log);
  const scratch = mkdtempSync(join(tmpdir(), "lamsa-render-"));
  const baseHref = pathToFileURL(project.root + "/").href;
  const results: RenderedFrame[] = [];
  try {
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    for (const id of ids) {
      const result = buildRenderTree({ nodes, rootId: id, tokens, mode, iconSvg: lucideIconSvg, fileCss });
      const html = renderDocument({ result, tokens, fontCss: fonts.css, fontLinks: fonts.links, baseHref });
      await page.setViewportSize({ width: 1440, height: 900 });
      const file = join(scratch, `${id}.html`);
      writeFileSync(file, html);
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      if (state) {
        // Entrance animations finish first, so the strip shows only the state change.
        await page.evaluate(call(settleAnimations, "document"));
        await page.evaluate(call(applyMotionState, "document", state));
        await page.evaluate(() => document.body.getBoundingClientRect());
      }
      if (!animate) await page.evaluate(call(settleAnimations, "document"));
      const target = page.locator("#lamsa-render > div").first();
      const box = await target.boundingBox();
      if (!box) throw new CliError(`node ${id} rendered with no size`, ExitCode.renderFailed, "give the frame a width and height", id);
      if (box.width > 1440 || box.height > 900) {
        await page.setViewportSize({ width: Math.ceil(Math.max(1440, box.width)), height: Math.ceil(Math.max(900, box.height)) });
      }
      const path = join(outDir, naming(id));
      let times: number[] | undefined;
      if (animate) times = await captureStrip({ page, frames: animate, path, label: `${nodes[id]?.name ?? id}${state ? ` · ${state}` : ""}` });
      else await target.screenshot({ path, omitBackground: true });
      let markedPath: string | undefined;
      const frameMarks = marks?.[id]?.filter((mark) => mark.ids.length > 0);
      if (!animate && frameMarks?.length && markedNaming) {
        markedPath = join(outDir, markedNaming(id));
        await page.evaluate(call(drawMarks, frameMarks));
        await target.screenshot({ path: markedPath, omitBackground: true });
      }
      results.push({
        markedPath,
        times,
        id,
        name: nodes[id]?.name,
        path,
        width: Math.round(box.width),
        height: Math.round(box.height),
        mode: result.mode,
        missingTokens: result.missingTokens,
        missingIcons: result.missingIcons,
      });
    }
    await context.close();
  } finally {
    await browser.close();
    rmSync(scratch, { recursive: true, force: true });
  }
  return results;
}
