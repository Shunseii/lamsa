import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OpenRequest } from "../apps/desktop/src/shared/api.js";
import { copyExample } from "./helpers.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(repo, "packages/cli/dist/cli.js");
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");
const FAKE_BIN = join(repo, "tests/fixtures/fake-claude");

interface TestWindow {
  marker?: string;
  lamsa: { assetHost: string; openProject(root: string): Promise<unknown> };
}

/** Closes a window from its page on the next tick, so the evaluate call returns before the page goes away. */
const closeWindow = (page: Page) => page.evaluate(() => void setTimeout(() => window.close(), 0));

const project = (prefix: string) => {
  const root = mkdtempSync(join(tmpdir(), `lamsa-${prefix}-`));
  copyExample(root);
  return root;
};

const sessionSelection = (root: string) => {
  try {
    return (JSON.parse(readFileSync(join(root, ".lamsa/session.json"), "utf8")) as { selection: string[] }).selection;
  } catch {
    return [];
  }
};

describe("one window per project", () => {
  let app: ElectronApplication;
  let rootA: string;
  let rootB: string;
  let rootC: string;
  let pageA: Page;
  let pageB: Page;

  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  /** What `lamsa open` does when lamsa is already running: the running app gets the request. */
  const secondInstance = (request: OpenRequest) =>
    app.evaluate(({ app }, data) => {
      app.emit("second-instance", {}, [], "/", data);
    }, request);
  const projectName = (page: Page) => page.getByTestId("project-menu").locator(".project-name").textContent();
  /** Set on a page to tell whether it was reloaded: a reload clears it. */
  const mark = (page: Page) =>
    page.evaluate(() => {
      (window as unknown as TestWindow).marker = "kept";
    });
  const marker = (page: Page) => page.evaluate(() => (window as unknown as TestWindow).marker);
  const thread = (page: Page) => page.getByTestId("agent-thread");

  beforeAll(async () => {
    [rootA, rootB, rootC] = [project("window-a"), project("window-b"), project("window-c")];
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", rootA, "--select", "QkpksTeC"],
      env: {
        ...process.env,
        LAMSA_HIDDEN: "1",
        LAMSA_MULTI_INSTANCE: "1",
        PATH: `${FAKE_BIN}:${process.env.PATH}`,
        TERMINAL: join(FAKE_BIN, "terminal"),
        FAKE_CLAUDE_PROJECTS: mkdtempSync(join(tmpdir(), "lamsa-claude-projects-")),
      },
    });
    pageA = await app.firstWindow();
    await pageA.getByTestId("project-menu").waitFor();
    await mark(pageA);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("opens another project's request in a new window, leaving the first window, its selection and its agent turn alone", async () => {
    await expect.poll(() => sessionSelection(rootA)).toEqual(["QkpksTeC"]);
    await pageA.locator('[data-panel-tab="agent"]').click();
    await pageA.getByTestId("agent-input").fill("be slow");
    await pageA.getByTestId("agent-input").press("Enter");
    await expect.poll(() => thread(pageA).textContent(), { timeout: 15_000 }).toContain("Working on it");

    const opened = app.waitForEvent("window");
    await secondInstance({ root: rootB, select: ["gmrdFHB9"] });
    pageB = await opened;
    await expect.poll(() => projectName(pageB), { timeout: 20_000 }).toBe(basename(rootB));
    await expect.poll(() => sessionSelection(rootB)).toEqual(["gmrdFHB9"]);

    expect(await windowCount()).toBe(2);
    expect(await marker(pageA)).toBe("kept");
    expect(await projectName(pageA)).toBe(basename(rootA));
    expect(sessionSelection(rootA)).toEqual(["QkpksTeC"]);
    expect(await pageA.getByTestId("agent-working").count()).toBe(1);
    expect(await thread(pageA).locator(".agent-note").allTextContents()).not.toContain("Stopped");
    // Each window loads images and fonts from its own project.
    const hosts = await Promise.all([pageA, pageB].map((page) => page.evaluate(() => (window as unknown as TestWindow).lamsa.assetHost)));
    expect(new Set(hosts).size).toBe(2);
  });

  it("brings the window that already has the project forward and selects what was asked for there", async () => {
    await secondInstance({ root: rootA, select: ["gmrdFHB9"] });
    await expect.poll(() => sessionSelection(rootA)).toEqual(["gmrdFHB9"]);
    expect(await windowCount()).toBe(2);
    expect(await marker(pageA)).toBe("kept");
    expect(sessionSelection(rootB)).toEqual(["gmrdFHB9"]);
    expect(await pageA.getByTestId("agent-working").count()).toBe(1);
  });

  it("never opens a project twice from the project menu", async () => {
    await pageB.getByTestId("project-menu").click();
    const recent = pageB.getByTestId("project-menu-list").locator(`[data-root="${rootA}"]`);
    await recent.click();
    await pageB.waitForTimeout(300);
    expect(await windowCount()).toBe(2);
    expect(await projectName(pageB)).toBe(basename(rootB));
    expect(await marker(pageA)).toBe("kept");
    // The same holds from A's side, through the API the welcome screen and the folder picker use.
    expect(await pageA.evaluate((root) => (window as unknown as TestWindow).lamsa.openProject(root), rootB)).toBeNull();
    expect(await windowCount()).toBe(2);
  });

  it("opens a different project from the menu in a new window, since this one has a project", async () => {
    const opened = app.waitForEvent("window");
    expect(await pageB.evaluate((root) => (window as unknown as TestWindow).lamsa.openProject(root), rootC)).toBeNull();
    const pageC = await opened;
    await expect.poll(() => projectName(pageC), { timeout: 20_000 }).toBe(basename(rootC));
    expect(await projectName(pageB)).toBe(basename(rootB));
    expect(await windowCount()).toBe(3);
    await closeWindow(pageC);
    await expect.poll(windowCount).toBe(2);
  });

  it("keeps the first window working after another window closes", async () => {
    await closeWindow(pageB);
    await expect.poll(windowCount).toBe(1);
    const added = spawnSync(
      process.execPath,
      [CLI, "--json", "add", "--parent", "7qOxePB7", "--tree", JSON.stringify({ type: "text", name: "Still live", content: "Still live in A" })],
      { cwd: rootA, encoding: "utf8" },
    );
    expect(JSON.parse(added.stdout).ok).toBe(true);
    await expect
      .poll(() => pageA.evaluate(() => [...document.querySelectorAll(".frame-host")].map((h) => h.shadowRoot?.textContent ?? "").join(" ")), {
        timeout: 10_000,
      })
      .toContain("Still live in A");
    expect(await pageA.getByTestId("agent-working").count()).toBe(1);
    await pageA.getByTestId("agent-stop").click();
    await pageA.getByTestId("agent-working").waitFor({ state: "detached", timeout: 15_000 });
    await expect.poll(() => thread(pageA).locator(".agent-note").last().textContent()).toBe("Stopped");
  });

  it("leaves the window empty when its project closes, and opens the next request there", async () => {
    await pageA.getByTestId("project-menu").click();
    await pageA.getByTestId("go-home").click();
    await pageA.getByTestId("welcome").waitFor();
    await secondInstance({ root: rootB });
    await expect.poll(() => projectName(pageA).catch(() => null), { timeout: 20_000 }).toBe(basename(rootB));
    expect(await windowCount()).toBe(1);
  });
});
