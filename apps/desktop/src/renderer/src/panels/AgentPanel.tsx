import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, Copy, History, Layers, LogIn, Package, RotateCcw, Sparkle, SquarePen, SquareTerminal } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { chatTitle, useAgent } from "../lib/agent";
import { cn } from "../lib/cn";
import { shortcut } from "../lib/keys";
import { useEditor } from "../lib/store";
import { Composer } from "./agent/Composer";
import { plural, relativeTime } from "./agent/format";
import { Thread } from "./agent/Thread";
import "./agent/agent.css";

const INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

const SUGGESTIONS = ["Add an empty state to this screen", "Make a dark mode copy of this screen", "Check colours against the design tokens"];

function Notice({ glyph, tone, title, children, actions }: { glyph: ReactNode; tone?: "warn"; title: string; children: ReactNode; actions: ReactNode }) {
  return (
    <div className="agent-notice" data-testid="agent-notice">
      <div className={cn("agent-notice-glyph", tone && `is-${tone}`)}>{glyph}</div>
      <div className="agent-notice-title">{title}</div>
      <div className="agent-notice-body">{children}</div>
      {actions}
    </div>
  );
}

function Header({ title, live, children }: { title: string; live?: boolean; children?: ReactNode }) {
  return (
    <div className="agent-header">
      <span className={cn("agent-dot", { "is-live": live })} />
      <span className="agent-title" data-testid="agent-title">
        {title}
      </span>
      {children}
    </div>
  );
}

function Unavailable() {
  const availability = useAgent((s) => s.availability)!;
  const check = useAgent((s) => s.check);
  const checking = useAgent((s) => s.checking);
  const signIn = useAgent((s) => s.signIn);
  const openTerminal = useAgent((s) => s.openTerminal);
  const command = availability.command;
  const checkAgain = (
    <button className="btn small" onClick={() => void check()} disabled={checking}>
      <RotateCcw size={14} /> Check again
    </button>
  );
  if (availability.state === "missing") {
    return (
      <Notice glyph={<Package size={18} />} tone="warn" title="Claude Code isn't installed" actions={<div className="agent-notice-actions">
          <button className="btn small btn-accent" onClick={() => void navigator.clipboard.writeText(INSTALL_COMMAND)}>
            <Copy size={14} /> Copy command
          </button>
          {checkAgain}
        </div>}>
        lamsa chats through the {command} command on this computer. Install it, then sign in once.
        <code className="agent-notice-command">{INSTALL_COMMAND}</code>
      </Notice>
    );
  }
  if (availability.state === "signed-out") {
    return (
      <Notice glyph={<LogIn size={18} />} title="Sign in to Claude Code" actions={<div className="agent-notice-actions">
          <button className="btn small btn-accent" onClick={() => void signIn()}>
            <SquareTerminal size={14} /> Open terminal
          </button>
          {checkAgain}
        </div>}>
        Run {command} once in a terminal and log in. lamsa uses that login and never sees your credentials.
      </Notice>
    );
  }
  return (
    <Notice glyph={<SquareTerminal size={18} />} title={`Chat isn't available for ${command}`} actions={<div className="agent-notice-actions">
        <button className="btn small btn-accent" onClick={() => void openTerminal()}>
          <SquareTerminal size={14} /> Open {command} in terminal
        </button>
      </div>}>
      {command} has no structured output for lamsa to read, so it runs in your terminal instead.
    </Notice>
  );
}

function Welcome() {
  const send = useAgent((s) => s.send);
  const command = useAgent((s) => s.availability?.command ?? "claude");
  return (
    <div className="agent-welcome">
      <div className="agent-welcome-title">Ask your agent</div>
      <div className="muted">Runs your own {command} in this project. Selected layers go along as context.</div>
      <div className="agent-suggestions">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} className="agent-suggestion" onClick={() => void send(suggestion, [])}>
            <Sparkle size={14} className="muted" /> {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function ContinuedInTerminal({ sessionId, command }: { sessionId: string; command: string }) {
  return (
    <div className="agent-composer">
      <div className="agent-continued" data-testid="agent-continued">
        <div className="agent-continued-title">
          <SquareTerminal size={16} className="accent" /> Continued in your terminal
        </div>
        <div className="muted">This chat is open in a terminal. It picks up here, with everything said there, once you close it.</div>
        <div className="mono muted small truncate">
          {command} --resume {sessionId.slice(0, 4)}…
        </div>
      </div>
    </div>
  );
}

function HistoryList() {
  const { history, sessionId, open, newChat } = useAgent(useShallow((s) => ({ history: s.history, sessionId: s.sessionId, open: s.open, newChat: s.newChat })));
  // Relative times are recomputed when the list opens; a minute's drift while it's open doesn't matter.
  const [now] = useState(Date.now);
  if (history === null) return <div className="agent-history" data-testid="agent-history" />;
  if (!history.length) {
    return (
      <Notice glyph={<History size={18} />} title="No conversations yet" actions={<button className="btn small btn-accent" onClick={newChat}>
          <SquarePen size={14} /> New chat
        </button>}>
        Chats with claude in this project show up here, including ones you started in a terminal.
      </Notice>
    );
  }
  return (
    <div className="agent-history" data-testid="agent-history">
      {history.map((session) => (
        <button
          key={session.id}
          className={cn("agent-history-row", { "is-current": session.id === sessionId })}
          onClick={() => void open(session.id)}
          data-testid="agent-history-row"
        >
          <span className="agent-history-title truncate">{session.title}</span>
          <span className="agent-history-meta">
            <span>{relativeTime(session.updatedAt, now)}</span>
            {session.layersChanged ? (
              <>
                <span>·</span>
                <Layers size={12} />
                <span>{plural(session.layersChanged, "layer")} changed</span>
              </>
            ) : null}
            {session.id === sessionId && <span className="push-right accent">Open</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** The Agent tab: chat with the user's own agent CLI, its past conversations, and the states where chat can't run. */
export function AgentPanel() {
  const { availability, view, sessionId, items, external, working } = useAgent(
    useShallow((s) => ({
      availability: s.availability,
      view: s.view,
      sessionId: s.sessionId,
      items: s.items,
      external: s.externalSession !== null && s.externalSession === s.sessionId,
      working: s.turnId !== null,
    })),
  );
  const projectRoot = useEditor((s) => s.snapshot?.root);
  const { check, newChat, showHistory, showChat, openTerminal } = useAgent.getState();

  useEffect(() => {
    if (projectRoot && !availability && !useAgent.getState().checking) void check();
  }, [projectRoot, availability, check]);

  if (!availability) return <div className="agent" data-testid="agent-panel" />;

  if (availability.state !== "ready") {
    return (
      <div className="agent" data-testid="agent-panel">
        <Header title={availability.state === "unsupported" ? availability.command : "Agent"} />
        <Unavailable />
      </div>
    );
  }

  const newChatButton = (
    <button className="icon-btn tiny" onClick={newChat} aria-label="New chat" title="New chat" data-testid="agent-new-chat">
      <SquarePen size={14} />
    </button>
  );

  if (view === "history") {
    return (
      <div className="agent" data-testid="agent-panel">
        <div className="agent-header is-history">
          <button className="icon-btn tiny" onClick={showChat} aria-label="Back to chat" title="Back to chat" data-testid="agent-history-back">
            <ArrowLeft size={14} />
          </button>
          <span className="agent-title">Conversations</span>
          {newChatButton}
        </div>
        <HistoryList />
      </div>
    );
  }

  return (
    <div className="agent" data-testid="agent-panel">
      <Header title={chatTitle(items) ?? "New chat"} live={items.length > 0 && !external}>
        <button className="icon-btn tiny" onClick={() => void showHistory()} aria-label="Conversations" title="Conversations" data-testid="agent-history-button">
          <History size={14} />
        </button>
        {newChatButton}
        <button
          className="icon-btn tiny"
          onClick={() => void openTerminal()}
          aria-label="Continue in terminal"
          title={`Continue in terminal (${shortcut("mod+j")})`}
          data-testid="agent-terminal-button"
        >
          <SquareTerminal size={14} />
        </button>
      </Header>
      {items.length === 0 && !working ? <Welcome /> : <Thread items={items} />}
      {external && sessionId ? <ContinuedInTerminal sessionId={sessionId} command={availability.command} /> : <Composer command={availability.command} />}
    </div>
  );
}
