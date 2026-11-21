import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { DesignNode } from "@lamsa/schema";
import type { AgentEvent, AgentStreamParser, AgentTurnEvents, ChangedFile, ChangedLayer, ContextLayer, StopReason } from "../../shared/agent.js";
import type { ExternalChange } from "../../shared/api.js";
import { findCommand } from "../terminal.js";
import type { AgentDriver } from "./drivers.js";

/** Events stream to the renderer at most this often, so a fast reply doesn't re-render the chat per token. */
const FLUSH_MS = 32;
const STDERR_LIMIT = 4000;
const KILL_GRACE_MS = 3000;
/** The file watcher reports an edit shortly after it's written, so changes still count for a moment after the agent exits. */
const TRAILING_CHANGES_MS = 1500;

export interface TurnRequest {
  driver: AgentDriver;
  cwd: string;
  command: string;
  args: string[];
  sessionId: string;
  resume: boolean;
  prompt: string;
  context: ContextLayer[];
  promptIndex: number;
  /** Extra permissions the user granted for this chat. */
  allow: string[];
  /** Every loaded file's nodes when the turn starts; changes are reported against these. */
  baseline: Map<string, Record<string, DesignNode>>;
}

export interface TurnOutcome {
  sessionId: string;
  promptIndex: number;
  changes: ChangedFile[];
}

const SYSTEM_PROMPT = [
  "You are running inside the lamsa desktop editor's chat panel, in the project's root folder.",
  "The user sees the design canvas update live as design files change.",
  "Work on designs through the `lamsa` CLI with Bash: `lamsa selection` (what the user selected), `lamsa tree`, `lamsa add`/`move`/`delete`,",
  "`lamsa render`, `lamsa diff`, `lamsa open --select <ids>` (show layers in the editor), and `lamsa validate` after editing; `lamsa skill` prints the full guide.",
  "A markdown link like `[Pay button](lamsa:QkpksTeC)` names a layer: the text is its name and `lamsa:` is followed by its node id.",
  "The user's messages mention layers that way, and the chat shows such links in your replies as clickable layers too.",
  "Keep replies short: the panel is narrow.",
].join(" ");

function systemPrompt(context: ContextLayer[]): string {
  if (!context.length) return SYSTEM_PROMPT;
  const layers = context.map((layer) => `- ${layer.name} (id ${layer.id}, ${layer.type}${layer.file ? `, in ${layer.file}` : ""})`);
  return `${SYSTEM_PROMPT}\nThe user had these layers selected when sending this message:\n${layers.join("\n")}`;
}

const nodeName = (node: DesignNode): string => {
  if (node.name) return node.name;
  if (node.type === "text" && typeof node.content === "string") return node.content.slice(0, 40);
  return node.type;
};

const formatValue = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
};

/** A short note on what changed in a node, e.g. `width 100%` or `content`. */
function changeDetail(before: DesignNode, after: DesignNode): string | undefined {
  const parts: string[] = [];
  const beforeStyle = (before.style ?? {}) as Record<string, unknown>;
  const afterStyle = (after.style ?? {}) as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeStyle), ...Object.keys(afterStyle)])) {
    if (JSON.stringify(beforeStyle[key]) === JSON.stringify(afterStyle[key])) continue;
    parts.push(key in afterStyle ? `${key} ${formatValue(afterStyle[key])}` : `${key} removed`);
  }
  const beforeFields = before as unknown as Record<string, unknown>;
  const afterFields = after as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)])) {
    if (key === "style" || JSON.stringify(beforeFields[key]) === JSON.stringify(afterFields[key])) continue;
    parts.push(key === "parentId" || key === "index" ? "moved" : key);
  }
  const unique = [...new Set(parts)];
  if (!unique.length) return undefined;
  return unique.length > 2 ? `${unique.slice(0, 2).join(", ")} +${unique.length - 2}` : unique.join(", ");
}

/** Runs one chat turn at a time and streams its events, plus the design changes made while it runs. */
export class AgentRunner {
  private child?: ChildProcessWithoutNullStreams;
  private turn?: {
    id: string;
    sessionId: string;
    promptIndex: number;
    parser: AgentStreamParser;
    baseline: Map<string, Record<string, DesignNode>>;
    /** Per file: the ids changed during the turn and their latest nodes (null once deleted). */
    touched: Map<string, Map<string, DesignNode | null>>;
    changes: ChangedFile[];
    pending: AgentEvent[];
    timer?: ReturnType<typeof setTimeout>;
    sawError: boolean;
    stopped: boolean;
    ended: boolean;
    stderr: string;
  };
  /** The last turn, while its trailing changes may still arrive. */
  private trailing?: NonNullable<AgentRunner["turn"]>;
  private turnCount = 0;

  constructor(
    private readonly events: {
      emit: (batch: AgentTurnEvents) => void;
      finished: (outcome: TurnOutcome) => void;
      /** Every loaded file's nodes now, for the before/after diff when a turn ends. */
      current: () => Map<string, Record<string, DesignNode>>;
    },
  ) {}

  get running(): boolean {
    return this.turn !== undefined;
  }

  start(request: TurnRequest): { ok: boolean; turnId?: string; error?: string } {
    if (this.turn) return { ok: false, error: "the agent is already working" };
    const resolved = findCommand(request.command);
    if (!resolved) return { ok: false, error: `agent command not found: ${request.command}` };
    const turnId = `turn-${Date.now().toString(36)}-${++this.turnCount}`;
    const args = [
      ...request.args,
      ...request.driver.chatArgs({ sessionId: request.sessionId, resume: request.resume, systemPrompt: systemPrompt(request.context), allow: request.allow }),
    ];
    const child = spawn(resolved, args, { cwd: request.cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const turn = {
      id: turnId,
      sessionId: request.sessionId,
      promptIndex: request.promptIndex,
      parser: request.driver.createParser(),
      baseline: request.baseline,
      touched: new Map<string, Map<string, DesignNode | null>>(),
      changes: [] as ChangedFile[],
      pending: [] as AgentEvent[],
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      sawError: false,
      stopped: false,
      ended: false,
      stderr: "",
    };
    this.turn = turn;

    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        this.handleLine(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      turn.stderr = (turn.stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => {
      if (this.turn !== turn) return;
      turn.sawError = true;
      this.queue(turn, { type: "turn-error", message: `couldn't start ${request.command}: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      if (buffered.trim()) this.handleLine(buffered);
      this.finish({ turn, code, signal, command: request.command });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(request.prompt);
    return { ok: true, turnId };
  }

  stop() {
    const child = this.child;
    if (!child || !this.turn) return;
    this.turn.stopped = true;
    child.kill("SIGINT");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, KILL_GRACE_MS);
    child.once("close", () => clearTimeout(timer));
  }

  /** A design file changed on disk; while a turn runs, that's the agent's doing. */
  /** A turn is running or just finished, so disk changes now are the agent's. */
  get busy(): boolean {
    return Boolean(this.turn ?? this.trailing);
  }

  noteChange(change: ExternalChange) {
    const turn = this.turn ?? this.trailing;
    if (!turn || !change.changedIds.length) return;
    const touched = turn.touched.get(change.path) ?? new Map<string, DesignNode | null>();
    for (const id of change.changedIds) touched.set(id, change.file.nodes[id] ?? null);
    turn.touched.set(change.path, touched);
    turn.changes = this.summarise(turn);
    this.queue(turn, { type: "changes", id: `changes-${turn.id}`, files: turn.changes });
  }

  private reconcile(turn: NonNullable<AgentRunner["turn"]>) {
    const current = this.events.current();
    for (const file of new Set([...turn.baseline.keys(), ...current.keys()])) {
      const before = turn.baseline.get(file) ?? {};
      const after = current.get(file) ?? {};
      if (before === after) continue;
      const touched = turn.touched.get(file) ?? new Map<string, DesignNode | null>();
      for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[id] !== after[id] && !touched.has(id)) touched.set(id, after[id] ?? null);
      }
      if (touched.size) turn.touched.set(file, touched);
    }
    const changes = this.summarise(turn);
    if (JSON.stringify(changes) === JSON.stringify(turn.changes)) return;
    turn.changes = changes;
    this.queue(turn, { type: "changes", id: `changes-${turn.id}`, files: changes });
  }

  private summarise(turn: NonNullable<AgentRunner["turn"]>): ChangedFile[] {
    const files: ChangedFile[] = [];
    for (const [file, touched] of turn.touched) {
      const before = turn.baseline.get(file) ?? {};
      const layers: ChangedLayer[] = [];
      for (const [id, after] of touched) {
        const previous = before[id];
        if (!previous && !after) continue;
        if (previous && after && JSON.stringify(previous) === JSON.stringify(after)) continue;
        const node = (after ?? previous)!;
        const kind = !previous ? "added" : !after ? "removed" : "changed";
        const detail = previous && after ? changeDetail(previous, after) : undefined;
        layers.push({ id, name: nodeName(node), type: node.type, kind, ...(detail ? { detail } : {}) });
      }
      if (layers.length) files.push({ file, layers });
    }
    return files;
  }

  private handleLine(line: string) {
    const turn = this.turn;
    if (!turn) return;
    for (const event of turn.parser.push(line)) {
      // A stopped turn ends with its own "stopped" note, not the error the interrupted agent reports.
      if (turn.stopped && (event.type === "turn-error" || event.type === "turn-end")) continue;
      if (event.type === "turn-error") turn.sawError = true;
      this.queue(turn, event);
    }
  }

  private queue(turn: NonNullable<AgentRunner["turn"]>, event: AgentEvent) {
    // Consecutive deltas to the same text merge, so a batch carries one event per text block.
    const last = turn.pending.at(-1);
    if (event.type === "message-chunk" && last?.type === "message-chunk" && last.id === event.id) {
      turn.pending[turn.pending.length - 1] = { ...last, text: last.text + event.text };
    } else if (event.type === "changes" && last?.type === "changes") {
      turn.pending[turn.pending.length - 1] = event;
    } else {
      turn.pending.push(event);
    }
    turn.timer ??= setTimeout(() => this.flush(turn), FLUSH_MS);
  }

  private flush(turn: NonNullable<AgentRunner["turn"]>) {
    clearTimeout(turn.timer);
    turn.timer = undefined;
    if (!turn.pending.length) return;
    const events = turn.pending;
    turn.pending = [];
    this.events.emit({ turnId: turn.id, sessionId: turn.sessionId, events, ...(turn.ended ? { trailing: true } : {}) });
  }

  private finish({ turn, code, signal, command }: { turn: NonNullable<AgentRunner["turn"]>; code: number | null; signal: NodeJS.Signals | null; command: string }) {
    if (this.turn !== turn) return;
    let stopReason: StopReason = "end_turn";
    if (turn.stopped) stopReason = "cancelled";
    else if (turn.sawError) stopReason = "error";
    else if (code !== 0) {
      const stderr = turn.stderr.trim().split("\n").slice(-3).join("\n");
      const message = stderr || (signal ? `${command} was killed (${signal})` : `${command} exited with code ${code}`);
      turn.pending.push({ type: "turn-error", message });
      stopReason = "error";
    }
    turn.pending.push({ type: "turn-end", stopReason });
    this.flush(turn);
    turn.ended = true;
    this.turn = undefined;
    this.child = undefined;
    this.trailing = turn;
    // Reported now and again once trailing changes are in, so history is right as soon as the turn ends.
    this.events.finished({ sessionId: turn.sessionId, promptIndex: turn.promptIndex, changes: turn.changes });
    setTimeout(() => {
      if (this.trailing === turn) this.trailing = undefined;
      // The card's final word is a before/after diff of every file, so an edit the watcher missed still shows.
      this.reconcile(turn);
      this.flush(turn);
      this.events.finished({ sessionId: turn.sessionId, promptIndex: turn.promptIndex, changes: turn.changes });
    }, TRAILING_CHANGES_MS);
  }
}
