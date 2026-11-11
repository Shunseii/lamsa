import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ExternalLink, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, useEditor } from "../lib/store";

export function TerminalPanel() {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const [status, setStatus] = useState<{ state: "starting" | "running" | "exited" | "missing"; command: string; error?: string }>({
    state: "starting",
    command: "",
  });
  const togglePanel = useEditor((s) => s.togglePanel);
  const root = useEditor((s) => s.snapshot?.root ?? "");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const term = new Terminal({
      fontFamily: '"Geist Mono", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      cursorBlink: true,
      theme: { background: "#fbfaf8", foreground: "#1f1d1b", cursor: "#1f5fa8", selectionBackground: "#d3e1f2", black: "#1f1d1b", brightBlack: "#8c8a85", green: "#1e7f4a", red: "#be3329", yellow: "#9a6412", blue: "#2f5fa7", magenta: "#8e3fa0", cyan: "#1d7a80", white: "#e9e6df" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    fit.fit();
    terminal.current = term;
    const offData = api().onTerminalData((data) => term.write(data));
    const offExit = api().onTerminalExit((code) => {
      term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
      setStatus((s) => ({ ...s, state: "exited" }));
    });
    const input = term.onData((data) => api().terminalWrite(data));
    void api()
      .terminalStart(term.cols, term.rows)
      .then((result) => setStatus({ state: result.ok ? "running" : "missing", command: result.command, error: result.error }));
    const observer = new ResizeObserver(() => {
      fit.fit();
      api().terminalResize(term.cols, term.rows);
    });
    observer.observe(element);
    term.focus();
    return () => {
      observer.disconnect();
      offData();
      offExit();
      input.dispose();
      term.dispose();
    };
  }, [generation]);

  const external = async () => {
    const result = await api().terminalExternal();
    if (!result.ok) useEditor.getState().toast({ tone: "warn", title: "No external terminal", message: result.error });
  };

  return (
    <div className="panel panel-terminal" data-testid="terminal-panel">
      <div className="terminal-head">
        <span className={`term-tab ${status.state === "running" ? "is-live" : ""}`}>
          <span className="dot" />
          {status.command || "agent"} <span className="muted mono">{root.split("/").slice(-1)[0] ? `~/${root.split("/").slice(-1)[0]}` : ""}</span>
        </span>
        <button className="icon-btn tiny" aria-label="Restart agent" onClick={() => setGeneration((g) => g + 1)}>
          <Plus size={14} />
        </button>
        <span className="grow" />
        <button className="ghost-btn" onClick={() => void external()}>
          <ExternalLink size={14} /> Open in external terminal
        </button>
        <button className="icon-btn tiny" aria-label="Hide terminal" onClick={() => togglePanel("terminal", false)}>
          <ChevronDown size={16} />
        </button>
      </div>
      {status.state === "missing" && (
        <div className="alert alert-danger term-alert">
          <TriangleAlert size={16} />
          <div>
            <div className="strong">Agent command not found</div>
            <div className="small">
              lamsa starts <code>{status.command}</code> from <code>agent.command</code> in lamsa.config.json. Install it or point the config at your agent CLI, then restart. Everything else works without it.
            </div>
          </div>
        </div>
      )}
      <div className="terminal-host" ref={host} />
    </div>
  );
}
