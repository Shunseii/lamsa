import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addComment, commentAuthor, loadComments, reopenComment, replyToComment, resolveComment, validateComments } from "@lamsa/core";
import { commentThreadSchema, configSchema } from "@lamsa/schema";
import { copyExample, tempRepo } from "./helpers.js";

const repo = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(repo, "packages/cli/dist/cli.js");
const DESKTOP = join(repo, "apps/desktop");
const ELECTRON = join(DESKTOP, "node_modules/electron/dist/electron");

/** The CLI as an agent runs it: `LAMSA_AGENT_NAME` signs its comments, and the test runner's own agent markers are dropped. */
function lamsa({ cwd, args, agent = "Claude" }: { cwd: string; args: string[]; agent?: string }) {
  const { CLAUDECODE: _claudeCode, LAMSA_AUTHOR: _author, ...env } = process.env;
  const result = spawnSync(process.execPath, [CLI, "--json", ...args], { cwd, encoding: "utf8", env: { ...env, LAMSA_AGENT_NAME: agent } });
  return { code: result.status, json: JSON.parse(result.stdout || "{}") as Record<string, unknown> };
}

const DESIGN = {
  version: 1,
  nodes: {
    Screen01: { type: "frame", name: "Checkout", x: 0, y: 0, style: { width: 390, height: 600 } },
    PayBtn01: { type: "frame", name: "Pay button", parentId: "Screen01", index: "a0", style: { height: 44 } },
  },
};

function commentRepo() {
  return tempRepo({ "lamsa.config.json": { designs: ["designs/**/*.lamsa.json"] }, "designs/checkout.lamsa.json": DESIGN });
}

const location = (root: string) => ({ root, config: configSchema.parse({}) });

describe("comment threads (core)", () => {
  it("adds, replies, resolves and reopens a thread in its own file, read fresh each time", async () => {
    const root = commentRepo();
    const at = new Date("2026-11-20T10:00:00.000Z");
    const thread = await addComment({ location: location(root), nodeId: "PayBtn01", text: "  make this denser ", author: "Sara", offset: { x: 12.4, y: 8.6 }, now: at });
    expect(thread).toMatchObject({ id: expect.stringMatching(/^[A-Za-z0-9]{8}$/), path: `designs/comments/${thread.id}.json`, text: "make this denser", offset: { x: 12, y: 9 } });
    const onDisk = JSON.parse(readFileSync(join(root, thread.path), "utf8")) as Record<string, unknown>;
    expect(commentThreadSchema.parse(onDisk)).toEqual({ version: 1, nodeId: "PayBtn01", offset: { x: 12, y: 9 }, author: "Sara", createdAt: at.toISOString(), text: "make this denser", replies: [] });
    expect(onDisk).not.toHaveProperty("id");

    await replyToComment({ location: location(root), id: thread.id, text: "On it", author: "Claude" });
    const resolved = await resolveComment({ location: location(root), id: thread.id, author: "Claude", reply: "Gap is 16 now" });
    expect(resolved.replies.map((reply) => reply.text)).toEqual(["On it", "Gap is 16 now"]);
    expect(resolved.resolved?.author).toBe("Claude");
    // Resolving again keeps who resolved it first.
    expect((await resolveComment({ location: location(root), id: thread.id, author: "Sara" })).resolved?.author).toBe("Claude");
    expect((await reopenComment({ location: location(root), id: thread.id })).resolved).toBeUndefined();

    const { threads, issues } = await loadComments(location(root));
    expect(issues).toEqual([]);
    expect(threads.map((t) => [t.id, t.replies.length, !!t.resolved])).toEqual([[thread.id, 2, false]]);
  });

  it("reports unreadable thread files and comments pinned to deleted nodes", async () => {
    const root = commentRepo();
    await addComment({ location: location(root), nodeId: "Gone0001", text: "is this still needed?", author: "Sara" });
    writeFileSync(join(root, "designs/comments/broken01.json"), "{ not json");
    writeFileSync(join(root, "designs/comments/wrong001.json"), JSON.stringify({ version: 1, nodeId: "PayBtn01" }));
    const { threads, issues } = await loadComments(location(root));
    expect(issues.map((issue) => [issue.file, issue.code])).toEqual([
      ["designs/comments/broken01.json", "comment-invalid"],
      ["designs/comments/wrong001.json", "comment-invalid"],
    ]);
    expect(validateComments({ threads, nodes: DESIGN.nodes as never })).toEqual([
      expect.objectContaining({ severity: "warning", code: "comment-orphaned", nodeId: "Gone0001", fix: expect.stringContaining("lamsa comments resolve") }),
    ]);
  });

  it("has no comments, and creates no files, until the first one is added", async () => {
    const root = commentRepo();
    expect(await loadComments(location(root))).toEqual({ threads: [], issues: [] });
    expect(existsSync(join(root, "designs/comments"))).toBe(false);
  });

  it("signs comments with --author, LAMSA_AUTHOR, the agent, then git's user.name", () => {
    const root = commentRepo();
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Sara Q"], { cwd: root });
    expect(commentAuthor({ root, explicit: "Omar", env: { LAMSA_AUTHOR: "Ana" } })).toBe("Omar");
    expect(commentAuthor({ root, env: { LAMSA_AUTHOR: "Ana", CLAUDECODE: "1" } })).toBe("Ana");
    expect(commentAuthor({ root, env: { CLAUDECODE: "1" } })).toBe("Claude");
    expect(commentAuthor({ root, env: { LAMSA_AGENT_NAME: "Codex" } })).toBe("Codex");
    // The editor is the person at the keyboard, even when it was started from an agent's shell.
    expect(commentAuthor({ root, env: { CLAUDECODE: "1" }, detectAgent: false })).toBe("Sara Q");
  });
});

describe("lamsa comments (CLI)", () => {
  it("adds, lists, replies to and resolves comments with JSON output", () => {
    const root = commentRepo();
    const added = lamsa({ cwd: root, args: ["comment", "add", "--node", "PayBtn01", "--offset", "24,8", "make", "this", "denser"], agent: "Sara" });
    expect(added.code).toBe(0);
    const comment = added.json.comment as { id: string; node: unknown; open: boolean; orphaned: boolean; offset: unknown; author: string; text: string };
    expect(comment).toMatchObject({ author: "Sara", text: "make this denser", offset: { x: 24, y: 8 }, open: true, orphaned: false, node: { name: "Pay button", type: "frame", file: "designs/checkout.lamsa.json" } });

    const listed = lamsa({ cwd: root, args: ["comments", "--open"] });
    expect(listed.json).toMatchObject({ ok: true, counts: { open: 1, resolved: 0 }, comments: [{ id: comment.id, nodeId: "PayBtn01" }] });
    expect(lamsa({ cwd: root, args: ["comments", "--node", "PayBtn01"] }).json.comments).toHaveLength(1);
    expect(lamsa({ cwd: root, args: ["comments", "--node", "Screen01"] }).json.comments).toHaveLength(0);

    const reply = lamsa({ cwd: root, args: ["comments", "reply", comment.id, "Working", "on", "it"] });
    expect((reply.json.comment as { replies: { author: string; text: string }[] }).replies).toEqual([expect.objectContaining({ author: "Claude", text: "Working on it" })]);

    const resolved = lamsa({ cwd: root, args: ["comments", "resolve", comment.id, "--reply", "Gap is 16 now"] });
    expect(resolved.json.comment).toMatchObject({ open: false, resolved: { author: "Claude" } });
    expect(lamsa({ cwd: root, args: ["comments", "--open"] }).json).toMatchObject({ counts: { open: 0, resolved: 1 }, comments: [] });
    expect(lamsa({ cwd: root, args: ["comments", "--resolved"] }).json.comments).toHaveLength(1);
    expect(lamsa({ cwd: root, args: ["comments", "reopen", comment.id] }).json.comment).toMatchObject({ open: true });
  });

  it("names the missing node or comment with a did-you-mean, and exits with meaningful codes", () => {
    const root = commentRepo();
    const missingNode = lamsa({ cwd: root, args: ["comment", "add", "--node", "PayBtn0l", "hi"] });
    expect(missingNode.code).toBe(3);
    expect(missingNode.json).toMatchObject({ ok: false, error: { message: 'no node "PayBtn0l"', fix: 'did you mean "PayBtn01"?', nodeId: "PayBtn0l" } });

    const { json } = lamsa({ cwd: root, args: ["comment", "add", "--node", "PayBtn01", "hi"] });
    const id = (json.comment as { id: string }).id;
    const missingComment = lamsa({ cwd: root, args: ["comments", "resolve", id.slice(0, 7)] });
    expect(missingComment.code).toBe(3);
    expect(missingComment.json).toMatchObject({ ok: false, error: { fix: `did you mean "${id}"?` } });

    expect(lamsa({ cwd: root, args: ["comments", "reply", id, " "] })).toMatchObject({ code: 2, json: { error: { message: "comment text is empty" } } });
    expect(lamsa({ cwd: root, args: ["comment", "add", "--node", "PayBtn01", "--offset", "12", "hi"] }).code).toBe(2);
    expect(lamsa({ cwd: root, args: ["comments", "--open", "--resolved"] }).code).toBe(2);
    expect(lamsa({ cwd: root, args: ["comments", "--node", "Nope0001"] }).code).toBe(3);
  });

  it("warns about comments on deleted nodes in validate, and errors on broken thread files", () => {
    const root = commentRepo();
    const { json } = lamsa({ cwd: root, args: ["comment", "add", "--node", "PayBtn01", "is this needed?"] });
    const id = (json.comment as { id: string }).id;
    expect(lamsa({ cwd: root, args: ["delete", "PayBtn01"] }).code).toBe(0);
    const validated = lamsa({ cwd: root, args: ["validate"] });
    expect(validated.code).toBe(0);
    expect(validated.json).toMatchObject({ ok: true, warnings: 1, issues: [{ code: "comment-orphaned", nodeId: "PayBtn01", file: `designs/comments/${id}.json` }] });
    expect(lamsa({ cwd: root, args: ["comments"] }).json.comments).toEqual([expect.objectContaining({ id, orphaned: true, node: null })]);

    writeFileSync(join(root, "designs/comments/broken01.json"), "{");
    expect(lamsa({ cwd: root, args: ["validate"] })).toMatchObject({ code: 1, json: { errors: 1 } });
  });

  it("tells agents to check, address and resolve comments in the skill and AGENTS.md", () => {
    const skill = lamsa({ cwd: commentRepo(), args: ["skill"] }).json.skill as string;
    expect(skill).toContain("lamsa comments --open --json");
    expect(skill).toContain('lamsa comments resolve <id> --reply "');
    const root = tempRepo({});
    expect(lamsa({ cwd: root, args: ["init", "--yes"] }).code).toBe(0);
    expect(readFileSync(join(root, "AGENTS.md"), "utf8")).toContain("lamsa comments --open --json");
    expect(JSON.parse(readFileSync(join(root, "lamsa.config.json"), "utf8"))).toMatchObject({ commentsDir: "designs/comments" });
  });
});

describe("desktop editor comments", () => {
  let root: string;
  let app: ElectronApplication;
  let win: Page;
  let commentId: string;

  const threads = () => {
    const dir = join(root, "designs/comments");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((name) => ({ id: name.replace(/\.json$/, ""), ...(JSON.parse(readFileSync(join(dir, name), "utf8")) as { nodeId: string; text: string; author: string; replies: { text: string }[]; resolved?: unknown }) }));
  };
  const pins = () => win.getByTestId("comment-pin");
  const panel = () => win.getByTestId("comments-panel");
  /** The pay button's box on screen, from the rendered frame. */
  const payButton = () =>
    win.evaluate(() => {
      for (const host of document.querySelectorAll(".frame-host")) {
        const element = host.shadowRoot?.querySelector<HTMLElement>('[data-node-id="QkpksTeC"]');
        if (element) {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }
      }
      throw new Error("pay button not rendered");
    });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "lamsa-comments-"));
    copyExample(root);
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Sara Q"], { cwd: root });
    const { CLAUDECODE: _claudeCode, LAMSA_AUTHOR: _author, ...env } = process.env;
    app = await _electron.launch({
      executablePath: ELECTRON,
      args: [DESKTOP, "--root", root],
      env: { ...env, LAMSA_HIDDEN: "1", LAMSA_MULTI_INSTANCE: "1" },
    });
    win = await app.firstWindow();
    await win.getByTestId("layers-panel").waitFor();
    await win.locator('[data-root-id="08JQi0tV"]').waitFor();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it("pins a comment to the layer clicked with the comment tool, and lists it in the Comments panel", async () => {
    await win.getByTestId("canvas").click({ position: { x: 5, y: 300 } });
    await win.keyboard.press("m");
    await expect.poll(() => win.locator('[data-tool="comment"]').getAttribute("class")).toContain("is-active");
    const box = await payButton();
    await win.mouse.click(box.x + 30, box.y + 10);
    const input = win.getByTestId("comment-input");
    await expect.poll(() => input.evaluate((element) => element === document.activeElement)).toBe(true);
    await input.fill("Make the pay button full width");
    await input.press("Enter");
    await win.getByTestId("comment-draft").waitFor({ state: "detached" });

    await expect.poll(() => threads().length).toBe(1);
    const [thread] = threads();
    commentId = thread!.id;
    expect(thread).toMatchObject({ nodeId: "QkpksTeC", text: "Make the pay button full width", author: "Sara Q", offset: { x: expect.any(Number), y: expect.any(Number) } });

    // The pin's point is where the layer was clicked.
    await expect.poll(() => pins().count()).toBe(1);
    const pin = (await pins().first().boundingBox())!;
    expect(Math.abs(pin.x - (box.x + 30))).toBeLessThan(2);
    expect(Math.abs(pin.y + pin.height - (box.y + 10))).toBeLessThan(2);

    await win.keyboard.press("Control+7");
    await panel().getByTestId("comment-row").filter({ hasText: "Make the pay button full width" }).waitFor();
    expect(await panel().getByTestId("comment-row").textContent()).toContain("Pay button");
    await expect.poll(() => win.getByTestId("comments-tab-badge").textContent()).toBe("1");
  });

  it("keeps pins on their layer while the canvas pans and zooms", async () => {
    await win.getByTestId("canvas").click({ position: { x: 5, y: 300 } });
    await win.keyboard.press("v");
    const offset = async () => {
      const pin = (await pins().first().boundingBox())!;
      const box = await payButton();
      return { x: Math.round(pin.x - box.x), y: Math.round(pin.y + pin.height - box.y) };
    };
    const before = await offset();
    await win.mouse.move(700, 400);
    await win.mouse.wheel(120, 80);
    await expect.poll(offset).toEqual(before);
    await win.keyboard.press("Control+=");
    // Zoomed in, the point inside the layer scales with it.
    await expect.poll(async () => (await offset()).x).toBeGreaterThan(before.x + 2);
    await win.keyboard.press("Control+-");
    await expect.poll(offset).toEqual(before);
    // Back where it was, so the pin isn't under a panel for the next tests.
    await win.mouse.wheel(-120, -80);
  });

  it("shows a reply from the agent's CLI live in the open thread", async () => {
    await pins().first().click();
    const popover = win.getByTestId("comment-popover");
    await popover.getByText("Make the pay button full width").waitFor();
    expect(lamsa({ cwd: root, args: ["comments", "reply", commentId, "Full width now, using the ghost variant for Back"] }).code).toBe(0);
    await popover.getByText("Full width now, using the ghost variant for Back").waitFor({ timeout: 10_000 });
    expect(await popover.locator(".comment-author").allTextContents()).toEqual(["Sara Q", "Claude"]);
    // The open thread already shows the reply, so no toast repeats it.
    await win.waitForTimeout(300);
    expect(await win.getByTestId("toasts").getByText("Claude replied").count()).toBe(0);
    // The thread sits beside the layer it's about, whole, and clear of the panels.
    const card = (await popover.boundingBox())!;
    const button = await payButton();
    const separate = card.x >= button.x + button.width || card.x + card.width <= button.x || card.y >= button.y + button.height || card.y + card.height <= button.y;
    expect(separate).toBe(true);
    const viewport = win.viewportSize() ?? (await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })));
    expect(card.y + card.height).toBeLessThanOrEqual(viewport.height);
    const right = (await win.getByTestId("dock-right").boundingBox())!;
    expect(card.x + card.width).toBeLessThanOrEqual(right.x);
  });

  it("toasts an agent reply to a thread that isn't open", async () => {
    await win.keyboard.press("Escape");
    await win.getByTestId("comment-popover").waitFor({ state: "detached" });
    expect(lamsa({ cwd: root, args: ["comments", "reply", commentId, "Also checked dark mode"] }).code).toBe(0);
    await win.getByTestId("toasts").getByText("Claude replied").waitFor({ timeout: 10_000 });
    await pins().first().click();
    await win.getByTestId("comment-popover").getByText("Also checked dark mode").waitFor();
  });

  it("replies from the editor, signed with the git user", async () => {
    const reply = win.getByTestId("comment-popover").getByTestId("comment-reply-input");
    await reply.fill("Thanks!");
    await reply.press("Enter");
    await expect.poll(() => threads()[0]?.replies.map((r) => r.text)).toEqual(["Full width now, using the ghost variant for Back", "Also checked dark mode", "Thanks!"]);
    await expect.poll(() => reply.inputValue()).toBe("");
  });

  it("drops a thread the CLI resolves from the open filter, and keeps it under Resolved", async () => {
    expect(lamsa({ cwd: root, args: ["comments", "resolve", commentId, "--reply", "Done"] }).code).toBe(0);
    // The thread being read stays open, now marked resolved; closing it removes its pin from the open view.
    await win.getByTestId("comment-popover").getByText("Resolved by Claude").waitFor({ timeout: 10_000 });
    await panel().getByTestId("comments-empty").getByText("No open comments").waitFor();
    await win.keyboard.press("Escape");
    await win.getByTestId("comment-popover").waitFor({ state: "detached" });
    await expect.poll(() => pins().count()).toBe(0);
    await win.getByTestId("comments-tab-badge").waitFor({ state: "detached" });

    await panel().getByTestId("comments-filter-resolved").click();
    await panel().getByTestId("comment-row").waitFor();
    await expect.poll(() => pins().getAttribute("data-state")).toBe("resolved");
    await panel().getByTestId("comment-row").click();
    const popover = win.getByTestId("comment-popover");
    await popover.getByTestId("comment-resolved").getByText("Resolved by Claude").waitFor();
    await popover.getByTestId("comment-reopen").click();
    await expect.poll(() => threads()[0]?.resolved).toBeUndefined();
    await panel().getByTestId("comments-filter-open").click();
    await expect.poll(() => pins().count()).toBe(1);
  });

  it("selects and reveals a comment's layer when it's picked in the panel", async () => {
    await win.getByTestId("canvas").click({ position: { x: 5, y: 300 } });
    await win.keyboard.press("Escape");
    await panel().getByTestId("comment-row").click();
    await expect.poll(() => lamsa({ cwd: root, args: ["selection"] }).json.selection).toEqual([expect.objectContaining({ id: "QkpksTeC" })]);
    await win.getByTestId("comment-popover").waitFor();
  });

  it("lists a comment whose layer was deleted as orphaned, with no pin, and opens its thread in the panel", async () => {
    const added = lamsa({ cwd: root, args: ["comment", "add", "--node", "Rwwc3Sdq", "Is the header still needed?"] });
    const id = (added.json.comment as { id: string }).id;
    await expect.poll(() => pins().count(), { timeout: 10_000 }).toBe(2);
    expect(lamsa({ cwd: root, args: ["delete", "Rwwc3Sdq"] }).code).toBe(0);
    const row = panel().locator(`[data-testid="comment-row"][data-comment-id="${id}"]`);
    await expect.poll(() => row.getAttribute("data-orphaned"), { timeout: 10_000 }).toBe("true");
    expect(await row.textContent()).toContain("Layer deleted · Rwwc3Sdq");
    await expect.poll(() => pins().count()).toBe(1);
    await row.click();
    await panel().getByTestId("comment-thread").getByText("Is the header still needed?").waitFor();
  });
});
