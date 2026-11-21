import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createClaudeStreamParser, applyAgentEvents, type AgentEvent, type ChatItem } from "../apps/desktop/src/shared/agent";
import { driverFor } from "../apps/desktop/src/main/agent/drivers";
import { AgentRunner } from "../apps/desktop/src/main/agent/runner";
import { listSessions, loadTranscript, mangleProjectPath, recordTurnChanges } from "../apps/desktop/src/main/agent/sessions";
import type { AgentTurnEvents } from "../apps/desktop/src/shared/agent";
import { layerLink, parseLayerPaste, splitLayerLinks, stripLayerLinks } from "../apps/desktop/src/shared/layer-links";

const fixtures = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude/claude", import.meta.url));

/** Feeds a recorded stream through the parser the way the runner does, line by line. */
function parse(file: string): AgentEvent[] {
  const parser = createClaudeStreamParser();
  return readFileSync(join(fixtures, file), "utf8")
    .split("\n")
    .flatMap((line) => parser.push(line));
}

const chat = (events: AgentEvent[]) => applyAgentEvents([], events);

describe("Claude stream-json parser", () => {
  it("streams a text reply and reports the session and a successful result", () => {
    const events = parse("text-reply.jsonl");
    expect(events[0]).toEqual({ type: "session", sessionId: "11111111-2222-4333-8444-555555555555" });
    expect(events.filter((e) => e.type === "message-chunk").map((e) => (e as { text: string }).text).join("")).toBe("pong");
    // The full assistant message repeats the streamed text; it must not show twice.
    expect(events.some((e) => e.type === "message")).toBe(false);
    expect(events.some((e) => e.type === "turn-error")).toBe(false);
    expect(chat(events)).toEqual([{ kind: "text", id: expect.any(String), text: "pong" }]);
  });

  it("turns a tool call into one step that finishes with its output, then the reply", () => {
    const items = chat(parse("tool-call.jsonl"));
    expect(items.map((item) => item.kind)).toEqual(["tool", "text"]);
    expect(items[0]).toMatchObject({ kind: "tool", name: "Bash", input: { command: "echo hi" }, status: "done", output: "hi" });
    expect(items[1]).toMatchObject({ kind: "text", text: "done" });
  });

  it("reads a saved session transcript into the same chat items", () => {
    const items = chat(parse("session.jsonl"));
    expect(items.map((item) => item.kind)).toEqual(["user", "text", "user", "tool", "text"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "Reply with exactly the word: pong" });
    expect(items[3]).toMatchObject({ kind: "tool", status: "done", output: "hi" });
  });

  it("reports a failed turn, and recognises a missing login", () => {
    const parser = createClaudeStreamParser();
    const limit = parser.push(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached" }));
    expect(limit).toEqual([{ type: "turn-error", message: "Claude AI usage limit reached" }]);
    const auth = parser.push(JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }));
    expect(auth[0]).toMatchObject({ type: "turn-error", reason: "auth" });
    const items = applyAgentEvents([{ kind: "tool", id: "t", name: "Bash", status: "running" }], limit);
    expect(items.map((item) => (item.kind === "tool" ? item.status : item.kind))).toEqual(["error", "error"]);
  });

  it("turns a refused tool call into a blocked step with the rule that would allow it", () => {
    const parser = createClaudeStreamParser();
    const lines = [
      { type: "assistant", uuid: "a1", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "rm -rf build" } }] } },
      { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] } },
      { type: "result", subtype: "success", is_error: false, permission_denials: [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm -rf build" } }] },
    ];
    const items = applyAgentEvents([], lines.flatMap((line) => parser.push(JSON.stringify(line))));
    expect(items).toEqual([expect.objectContaining({ kind: "tool", status: "blocked", rule: "Bash(rm -rf build)" })]);
  });

  it("skips subagent messages, injected context, and non-JSON lines", () => {
    const parser = createClaudeStreamParser();
    const sidechain = { type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "m", content: [{ type: "text", text: "inner" }] } };
    const reminder = { type: "user", uuid: "u1", message: { role: "user", content: "<system-reminder>hi</system-reminder>" } };
    const meta = { type: "user", uuid: "u2", isMeta: true, message: { role: "user", content: "Caveat: generated" } };
    expect([JSON.stringify(sidechain), JSON.stringify(reminder), JSON.stringify(meta), "warning: not json", ""].flatMap((l) => parser.push(l))).toEqual([]);
  });
});

describe("chat items", () => {
  it("updates a turn's changes card in place and drops it when the changes are undone", () => {
    const files = [{ file: "designs/a.lamsa.json", layers: [{ id: "n1", name: "Title", type: "text", kind: "changed" as const }] }];
    let items: ChatItem[] = applyAgentEvents([], [{ type: "changes", id: "c", files }, { type: "message", id: "t", text: "Done" }]);
    items = applyAgentEvents(items, [{ type: "changes", id: "c", files: [{ ...files[0]!, layers: [...files[0]!.layers, { id: "n2", name: "Body", type: "text", kind: "added" }] }] }]);
    expect(items.map((item) => item.kind)).toEqual(["changes", "text"]);
    expect(items[0]!.kind === "changes" && items[0]!.files[0]!.layers.length).toBe(2);
    expect(applyAgentEvents(items, [{ type: "changes", id: "c", files: [] }]).map((item) => item.kind)).toEqual(["text"]);
  });

  it("returns the same array when an event changes nothing", () => {
    const items: ChatItem[] = [{ kind: "user", id: "u", text: "hi" }];
    expect(applyAgentEvents(items, [{ type: "session", sessionId: "s" }, { type: "user-message", id: "u", text: "hi" }])).toBe(items);
  });
});

describe("layer links in chat messages", () => {
  const layers = new Set(["QkpksTeC", "gmrdFHB9", "a-b_1"]);
  const exists = (id: string) => layers.has(id);

  it("turns the canvas's copied layer JSON into one layer per top-level node, without the JSON", () => {
    const copied = JSON.stringify(
      [
        { id: "QkpksTeC", type: "frame", name: "Pay button", children: [{ id: "a-b_1", type: "text", content: "Pay" }] },
        { id: "gone1234", type: "text" },
        { id: "gmrdFHB9", type: "text", content: "Checkout" },
      ],
      null,
      2,
    );
    expect(parseLayerPaste({ text: copied, exists })).toEqual([
      { kind: "layer", id: "QkpksTeC" },
      { kind: "text", text: " " },
      { kind: "layer", id: "gmrdFHB9" },
    ]);
    expect(parseLayerPaste({ text: JSON.stringify({ id: "gmrdFHB9", type: "text" }), exists })).toEqual([{ kind: "layer", id: "gmrdFHB9" }]);
  });

  it("pastes JSON that isn't copied layers, or names no open layer, as text", () => {
    const foreign = JSON.stringify([{ id: "elsewhere", type: "frame" }]);
    expect(parseLayerPaste({ text: foreign, exists })).toEqual([{ kind: "text", text: foreign }]);
    expect(parseLayerPaste({ text: '{"id":"QkpksTeC"}', exists })).toEqual([{ kind: "text", text: '{"id":"QkpksTeC"}' }]);
    expect(parseLayerPaste({ text: "[not json", exists })).toEqual([{ kind: "text", text: "[not json" }]);
  });

  it("turns layer ids in pasted text into layers and keeps the rest, including unknown ids, as text", () => {
    expect(parseLayerPaste({ text: "QkpksTeC please", exists })).toEqual([
      { kind: "layer", id: "QkpksTeC" },
      { kind: "text", text: " please" },
    ]);
    expect(parseLayerPaste({ text: "align gmrdFHB9,QkpksTeC\nand nope1234", exists })).toEqual([
      { kind: "text", text: "align " },
      { kind: "layer", id: "gmrdFHB9" },
      { kind: "text", text: "," },
      { kind: "layer", id: "QkpksTeC" },
      { kind: "text", text: "\nand nope1234" },
    ]);
    // Part of a word isn't an id.
    expect(parseLayerPaste({ text: "xQkpksTeC.", exists })).toEqual([{ kind: "text", text: "xQkpksTeC." }]);
    expect(parseLayerPaste({ text: "", exists })).toEqual([]);
  });

  it("brings back layers copied from the message box as links", () => {
    expect(parseLayerPaste({ text: `see ${layerLink({ id: "QkpksTeC", name: "Pay" })} and ${layerLink({ id: "zzz", name: "Old" })}`, exists })).toEqual([
      { kind: "text", text: "see " },
      { kind: "layer", id: "QkpksTeC" },
      { kind: "text", text: " and Old" },
    ]);
  });

  it("writes a layer as a markdown link and reads it back, names with brackets included", () => {
    const link = layerLink({ id: "QkpksTeC", name: "Pay [primary]\nbutton" });
    expect(link).toBe("[Pay \\[primary\\] button](lamsa:QkpksTeC)");
    expect(layerLink({ id: "my id", name: "Odd" })).toBe("[Odd](lamsa:my%20id)");
    const message = `Make ${link} as wide as [Summary](lamsa:gmrdFHB9). See [docs](https://x.y).`;
    expect(splitLayerLinks(message)).toEqual([
      { kind: "text", text: "Make " },
      { kind: "layer", id: "QkpksTeC", name: "Pay [primary] button" },
      { kind: "text", text: " as wide as " },
      { kind: "layer", id: "gmrdFHB9", name: "Summary" },
      { kind: "text", text: ". See [docs](https://x.y)." },
    ]);
    expect(splitLayerLinks("[Odd](lamsa:my%20id)")).toEqual([{ kind: "layer", id: "my id", name: "Odd" }]);
    expect(stripLayerLinks(message)).toBe("Make Pay [primary] button as wide as Summary. See [docs](https://x.y).");
  });
});

describe("Claude session storage", () => {
  const sessionId = "11111111-2222-4333-8444-555555555555";

  function project() {
    const base = mkdtempSync(join(tmpdir(), "lamsa-agent-"));
    const root = join(base, "my app");
    const projectsDir = join(base, "projects");
    const folder = join(projectsDir, mangleProjectPath(root));
    mkdirSync(folder, { recursive: true });
    mkdirSync(root, { recursive: true });
    return { root, projectsDir, folder };
  }

  it("lists this project's conversations newest first, titled by their first message", async () => {
    const { root, projectsDir, folder } = project();
    expect(mangleProjectPath("/home/me/my app.v2")).toBe("-home-me-my-app-v2");
    copyFileSync(join(fixtures, "session.jsonl"), join(folder, `${sessionId}.jsonl`));
    const older = "22222222-2222-4333-8444-555555555555";
    writeFileSync(
      join(folder, `${older}.jsonl`),
      [
        { type: "user", isMeta: true, message: { content: "<local-command-caveat>x</local-command-caveat>" } },
        { type: "user", message: { content: "Make a dark mode copy\nof Checkout" } },
        { type: "custom-title", customTitle: "Dark mode" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    utimesSync(join(folder, `${older}.jsonl`), new Date(2026, 0, 1), new Date(2026, 0, 1));
    // Sessions with nothing the user typed (e.g. one that only ran a slash command) aren't conversations.
    writeFileSync(join(folder, "33333333-2222-4333-8444-555555555555.jsonl"), JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }));
    await recordTurnChanges({ root, sessionId, prompt: 1, changes: [{ file: "designs/a.lamsa.json", layers: [{ id: "n1", name: "Title", type: "text", kind: "changed" }] }] });

    const sessions = await listSessions({ projectsDir, root });
    expect(sessions.map((s) => [s.id, s.title, s.layersChanged])).toEqual([
      [sessionId, "Reply with exactly the word: pong", 1],
      [older, "Dark mode", undefined],
    ]);
  });

  it("titles a conversation by its first message with layer links shown as layer names", async () => {
    const { root, projectsDir, folder } = project();
    writeFileSync(join(folder, `${sessionId}.jsonl`), JSON.stringify({ type: "user", message: { content: "Make [Pay button](lamsa:QkpksTeC) full width" } }));
    const sessions = await listSessions({ projectsDir, root });
    expect(sessions.map((s) => s.title)).toEqual(["Make Pay button full width"]);
  });

  it("loads a transcript with each turn's recorded changes after that turn", async () => {
    const { root, projectsDir, folder } = project();
    copyFileSync(join(fixtures, "session.jsonl"), join(folder, `${sessionId}.jsonl`));
    await recordTurnChanges({ root, sessionId, prompt: 0, changes: [{ file: "designs/a.lamsa.json", layers: [{ id: "n1", name: "Title", type: "text", kind: "added" }] }] });
    const items = await loadTranscript({ projectsDir, root, sessionId, parser: createClaudeStreamParser() });
    expect(items?.map((item) => item.kind)).toEqual(["user", "text", "changes", "user", "tool", "text"]);
    expect(await loadTranscript({ projectsDir, root, sessionId: "../../etc/passwd", parser: createClaudeStreamParser() })).toBeNull();
  });
});

describe("agent runner", () => {
  function run({ prompt, stopAfterMs }: { prompt: string; stopAfterMs?: number }) {
    const cwd = mkdtempSync(join(tmpdir(), "lamsa-runner-"));
    process.env.FAKE_CLAUDE_PROJECTS = join(cwd, ".projects");
    const batches: AgentTurnEvents[] = [];
    return new Promise<{ items: ChatItem[]; batches: AgentTurnEvents[] }>((resolve, reject) => {
      const runner = new AgentRunner({ emit: (batch) => batches.push(batch), finished: () => {}, current: () => new Map() });
      const started = runner.start({
        driver: driverFor("claude")!,
        cwd,
        command: FAKE_CLAUDE,
        args: [],
        sessionId: "44444444-2222-4333-8444-555555555555",
        resume: false,
        prompt,
        context: [{ id: "abc", name: "Pay button", type: "instance" }],
        promptIndex: 0,
        allow: [],
        baseline: new Map(),
      });
      if (!started.ok) reject(new Error(started.error));
      if (stopAfterMs) setTimeout(() => runner.stop(), stopAfterMs);
      const timer = setInterval(() => {
        if (!batches.some((batch) => batch.events.some((event) => event.type === "turn-end"))) return;
        clearInterval(timer);
        resolve({ items: applyAgentEvents([], batches.flatMap((batch) => batch.events)), batches });
      }, 20);
    });
  }

  it("streams a reply in batched events and ends the turn", async () => {
    const { items, batches } = await run({ prompt: "hello there" });
    expect(items).toEqual([{ kind: "text", id: expect.any(String), text: "You said: hello there" }]);
    // Deltas are merged per flush, so a short reply arrives in a handful of batches rather than one per word.
    expect(batches.length).toBeLessThan(6);
    expect(batches.at(-1)!.events.at(-1)).toEqual({ type: "turn-end", stopReason: "end_turn" });
  });

  it("reports a failed turn with the agent's message", async () => {
    const { items } = await run({ prompt: "please fail" });
    expect(items.at(-1)).toMatchObject({ kind: "error", message: expect.stringContaining("usage limit") });
  });

  it("stops a turn and says so, without an error", async () => {
    const { items } = await run({ prompt: "be slow", stopAfterMs: 400 });
    expect(items.map((item) => item.kind)).toEqual(["text", "stopped"]);
  });
});
