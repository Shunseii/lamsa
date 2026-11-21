import { create } from "zustand";
import {
  type AgentAvailability,
  type AgentSessionSummary,
  type AgentTerminalState,
  type AgentTurnEvents,
  applyAgentEvents,
  type ChatItem,
  type ContextLayer,
} from "../../../shared/agent";
import { stripLayerLinks } from "../../../shared/layer-links";
import { api, useEditor } from "./store";

/**
 * The agent chat's state, kept apart from the editor store so a streaming reply only re-renders the chat.
 * One conversation is shown at a time; past ones are read back from the agent's own session storage.
 */
export interface AgentState {
  /** Null until checked. */
  availability: AgentAvailability | null;
  checking: boolean;
  /** The conversation on screen; null for a new chat that hasn't sent anything yet. */
  sessionId: string | null;
  /** True once the session exists in the agent's storage, so the next turn resumes it. */
  resume: boolean;
  items: ChatItem[];
  /** The turn in progress, if any. */
  turnId: string | null;
  turnStartedAt: number | null;
  /** Messages sent while the agent was working; they go out one by one after it finishes, and show below the thread until then. */
  queue: { text: string; context: ContextLayer[] }[];
  view: "chat" | "history";
  history: AgentSessionSummary[] | null;
  /** The session open in the user's terminal; the chat waits for it to close. */
  externalSession: string | null;
  /** Permissions the user granted in this conversation with "Allow & retry". */
  allow: string[];
}

interface AgentActions {
  check(): Promise<void>;
  send(text: string, context: ContextLayer[]): Promise<void>;
  stop(): void;
  retry(): void;
  /** Allows a refused tool call for the rest of this conversation and runs the last message again. */
  allowAndRetry(rule: string): void;
  newChat(): void;
  showHistory(): Promise<void>;
  showChat(): void;
  open(sessionId: string): Promise<void>;
  openTerminal(): Promise<void>;
  signIn(): Promise<void>;
}

const initial: AgentState = {
  availability: null,
  checking: false,
  sessionId: null,
  resume: false,
  items: [],
  turnId: null,
  turnStartedAt: null,
  queue: [],
  view: "chat",
  history: null,
  externalSession: null,
  allow: [],
};

export const useAgent = create<AgentState & AgentActions>((set, get) => {
  const failTurn = (message: string) => set((s) => ({ items: [...s.items, { kind: "error", id: `error-${Date.now()}`, message }] }));

  const userCount = (items: ChatItem[]) => items.reduce((count, item) => count + (item.kind === "user" ? 1 : 0), 0);

  async function startTurn({ text, context }: { text: string; context: ContextLayer[] }) {
    const state = get();
    const sessionId = state.sessionId ?? crypto.randomUUID();
    const promptIndex = userCount(state.items);
    set((s) => ({
      sessionId,
      turnId: "starting",
      turnStartedAt: Date.now(),
      items: [...s.items, { kind: "user", id: `local-${Date.now()}`, text, ...(context.length ? { context } : {}) }],
    }));
    const result = await api().agentSend({ sessionId, resume: state.resume, prompt: text, context, promptIndex, allow: state.allow });
    if (!result.ok || !result.turnId) {
      set({ turnId: null, turnStartedAt: null });
      failTurn(result.error ?? "The agent couldn't start");
      return;
    }
    // Events may already have arrived for this turn; they carry its id, so adopt it either way.
    if (get().turnId === "starting") set({ turnId: result.turnId });
  }

  function handleEvents(batch: AgentTurnEvents) {
    const state = get();
    if (batch.sessionId !== state.sessionId) return;
    let ended = false;
    let authFailed = false;
    let started = false;
    for (const event of batch.events) {
      if (event.type === "session") started = true;
      if (event.type === "turn-end") ended = true;
      if (event.type === "turn-error" && event.reason === "auth") authFailed = true;
    }
    set((s) => ({
      items: applyAgentEvents(s.items, batch.events),
      turnId: ended ? null : batch.trailing ? s.turnId : batch.turnId,
      turnStartedAt: ended ? null : s.turnStartedAt,
      // The session exists once the agent has started it, even if the turn then failed.
      resume: s.resume || started,
      ...(authFailed ? { availability: { state: "signed-out" as const, command: s.availability?.command ?? "claude" } } : {}),
    }));
    if (ended) {
      const [next, ...rest] = get().queue;
      if (next && !authFailed) {
        set({ queue: rest });
        void startTurn(next);
      }
    }
  }

  function handleTerminal(terminal: AgentTerminalState) {
    if (terminal.open) {
      set({ externalSession: terminal.sessionId });
      return;
    }
    if (get().externalSession !== terminal.sessionId) return;
    set({ externalSession: null });
    // Pick up whatever was said in the terminal.
    if (terminal.sessionId && terminal.sessionId === get().sessionId) void get().open(terminal.sessionId);
  }

  let listening = false;
  function listen() {
    if (listening) return;
    listening = true;
    api().onAgentEvents(handleEvents);
    api().onAgentTerminal(handleTerminal);
    // A different project means different conversations and maybe a different agent.
    useEditor.subscribe((state, previous) => {
      if (state.snapshot === previous.snapshot) return;
      if (state.snapshot?.root !== previous.snapshot?.root) set({ ...initial });
      // A changed agent command in lamsa.config.json gets checked again; the conversation stays.
      else if (JSON.stringify(state.snapshot?.config.agent) !== JSON.stringify(previous.snapshot?.config.agent)) set({ availability: null });
    });
  }

  return {
    ...initial,

    async check() {
      listen();
      set({ checking: true });
      try {
        set({ availability: await api().agentStatus() });
      } finally {
        set({ checking: false });
      }
    },

    async send(text, context) {
      listen();
      const trimmed = text.trim();
      const state = get();
      if (!trimmed || state.externalSession !== null && state.externalSession === state.sessionId) return;
      if (state.turnId) {
        set((s) => ({ queue: [...s.queue, { text: trimmed, context }] }));
        return;
      }
      await startTurn({ text: trimmed, context });
    },

    stop() {
      set({ queue: [] });
      void api().agentStop();
    },

    retry() {
      const lastPrompt = [...get().items].reverse().find((item) => item.kind === "user");
      if (lastPrompt?.kind === "user") void get().send(lastPrompt.text, lastPrompt.context ?? []);
    },

    allowAndRetry(rule) {
      set((s) => ({ allow: s.allow.includes(rule) ? s.allow : [...s.allow, rule] }));
      get().retry();
    },

    newChat() {
      if (get().turnId) void api().agentStop();
      set({ sessionId: null, resume: false, items: [], turnId: null, turnStartedAt: null, queue: [], view: "chat", allow: [] });
    },

    async showHistory() {
      listen();
      set({ view: "history" });
      const history = await api().agentSessions();
      set({ history });
    },

    showChat: () => set({ view: "chat" }),

    async open(sessionId) {
      listen();
      if (get().turnId && get().sessionId !== sessionId) void api().agentStop();
      const transcript = await api().agentTranscript(sessionId);
      set({
        sessionId,
        resume: transcript !== null,
        items: transcript ?? [],
        view: "chat",
        ...(get().sessionId !== sessionId ? { turnId: null, turnStartedAt: null, queue: [], allow: [] } : {}),
      });
    },

    async openTerminal() {
      listen();
      const { sessionId, resume } = get();
      const result = await api().agentTerminal({ sessionId, resume });
      if (!result.ok) {
        useEditor.getState().toast({ tone: "warn", title: "Couldn't open a terminal", message: result.error });
        return;
      }
      if (result.sessionId && !sessionId) set({ sessionId: result.sessionId });
    },

    async signIn() {
      const result = await api().agentSignIn();
      if (!result.ok) useEditor.getState().toast({ tone: "warn", title: "Couldn't open a terminal", message: result.error });
    },
  };
});

/** The chat's title: the conversation's first message. */
export function chatTitle(items: ChatItem[]): string | undefined {
  const first = items.find((item) => item.kind === "user");
  return first?.kind === "user" ? stripLayerLinks(first.text).replace(/\s+/g, " ") : undefined;
}
