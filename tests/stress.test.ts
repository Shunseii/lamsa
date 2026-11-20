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
