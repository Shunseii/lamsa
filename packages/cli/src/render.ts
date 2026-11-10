import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { allNodes, lucideIconSvg } from "@lamsa/core";
import { buildRenderTree, renderDocument } from "@lamsa/renderer";
import type { TokenMode } from "@lamsa/schema";
import { chromium, type Browser } from "playwright-core";
import type { Workspace } from "./context.js";
import { CliError, ExitCode } from "./output.js";

const require = createRequire(import.meta.url);

export interface RenderedFrame {
  id: string;
  name?: string;
  path: string;
  width: number;
  height: number;
  mode: TokenMode;
  missingTokens: string[];
  missingIcons: string[];
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
  execFileSync(process.execPath, [cli, "install", "chromium-headless-shell"], {
    stdio: ["ignore", "ignore", "inherit"],
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
}: {
  workspace: Workspace;
  ids: string[];
  outDir: string;
  scale?: number;
  mode?: TokenMode;
  naming: (id: string) => string;
  log?: (message: string) => void;
}): Promise<RenderedFrame[]> {
  const { project, tokens, fonts } = workspace;
  const nodes = allNodes(project);
  const browser = await launchBrowser(log);
  const scratch = mkdtempSync(join(tmpdir(), "lamsa-render-"));
  const baseHref = pathToFileURL(project.root + "/").href;
  const results: RenderedFrame[] = [];
  try {
    const context = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    for (const id of ids) {
      const result = buildRenderTree({ nodes, rootId: id, tokens, mode, iconSvg: lucideIconSvg });
      const html = renderDocument({ result, tokens, fontCss: fonts.css, fontLinks: fonts.links, baseHref });
      const file = join(scratch, `${id}.html`);
      writeFileSync(file, html);
      await page.goto(pathToFileURL(file).href, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const target = page.locator("#lamsa-render > div").first();
      const box = await target.boundingBox();
      if (!box) throw new CliError(`node ${id} rendered with no size`, ExitCode.renderFailed, "give the frame a width and height", id);
      if (box.width > 1440 || box.height > 900) {
        await page.setViewportSize({ width: Math.ceil(Math.max(1440, box.width)), height: Math.ceil(Math.max(900, box.height)) });
      }
      const path = join(outDir, naming(id));
      await target.screenshot({ path, omitBackground: true });
      results.push({
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
