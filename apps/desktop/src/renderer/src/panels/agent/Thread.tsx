import { Ban, Check, ChevronRight, CircleAlert, FileJson, LoaderCircle, RotateCcw, ShieldCheck, SquareTerminal, X } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, ChatItem } from "../../../../shared/agent";
import { splitLayerLinks } from "../../../../shared/layer-links";
import { useAgent } from "../../lib/agent";
import { cn } from "../../lib/cn";
import { useEditor } from "../../lib/store";
import { describeTool, plural } from "./format";
import { LayerPill, LayerTypeIcon, revealLayers } from "./LayerPill";
import { Markdown } from "./Markdown";

function UserMessage({ text, queued }: { text: string; queued?: boolean }) {
  const segments = useMemo(() => splitLayerLinks(text), [text]);
  return (
    <div className={cn("agent-user", { "is-queued": queued })} data-testid="agent-user-message">
      <div className="agent-user-text">
        {segments.map((segment, index) =>
          segment.kind === "layer" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: segments are derived from fixed text and never reorder.
            <LayerPill key={index} id={segment.id} name={segment.name} />
          ) : (
            segment.text
          ),
        )}
      </div>
      {queued && <div className="agent-queued">Queued · sends when the agent finishes</div>}
    </div>
  );
}

function BlockedStep({ item, root }: { item: Extract<ChatItem, { kind: "tool" }>; root: string }) {
  const allowAndRetry = useAgent((s) => s.allowAndRetry);
  const busy = useAgent((s) => s.turnId !== null);
  const { verb, detail } = describeTool({ name: item.name, input: item.input, root });
  return (
    <div className="agent-blocked" data-testid="agent-blocked-step">
      <div className="agent-blocked-head">
        <Ban size={12} />
        <span className="agent-step-verb">Blocked:</span>
        <span className="agent-step-detail mono" title={detail || verb}>
          {detail || verb}
        </span>
      </div>
      <div className="agent-blocked-why">Your permission settings don't allow this {item.name === "Bash" ? "command" : "tool"}.</div>
      {item.rule && (
        <div>
          <button className="btn small" onClick={() => allowAndRetry(item.rule!)} disabled={busy} title={`Allow ${item.rule} in this chat`}>
            <ShieldCheck size={14} /> Allow &amp; retry
          </button>
        </div>
      )}
    </div>
  );
}

function ToolStep({ item, root }: { item: Extract<ChatItem, { kind: "tool" }>; root: string }) {
  const [open, setOpen] = useState(false);
  const { verb, detail } = describeTool({ name: item.name, input: item.input, root });
  if (item.status === "blocked") return <BlockedStep item={item} root={root} />;
  return (
    <div className={cn("agent-step", `is-${item.status}`)} data-testid="agent-step">
      <button className="agent-step-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {item.status === "running" ? (
          <LoaderCircle size={14} className="agent-spin accent" />
        ) : item.status === "error" ? (
          <X size={14} className="agent-step-failed" />
        ) : (
          <Check size={14} className="agent-step-ok" />
        )}
        <span className="agent-step-verb">{verb}</span>
        {detail && <span className="agent-step-detail mono">{detail}</span>}
        <ChevronRight size={14} className={cn("agent-step-chevron", { "is-open": open })} />
      </button>
      {open && <pre className="agent-step-output">{item.output || (item.input ? JSON.stringify(item.input, null, 2) : "No output")}</pre>}
    </div>
  );
}

function ChangesCard({ files }: { files: ChangedFile[] }) {
  return (
    <>
      {files.map((file) => (
        <div key={file.file} className="agent-changes" data-testid="agent-changes">
          <button
            className="agent-changes-head"
            onClick={() => void revealLayers({ file: file.file, ids: file.layers.filter((l) => l.kind !== "removed").map((l) => l.id) })}
            title="Select these layers"
          >
            <FileJson size={14} className="muted" />
            <span className="truncate">Edited {file.file.split("/").pop()}</span>
            <span className="push-right muted">{plural(file.layers.length, "layer")}</span>
          </button>
          {file.layers.map((layer) => (
            <button
              key={layer.id}
              className="agent-change-row"
              disabled={layer.kind === "removed"}
              onClick={() => void revealLayers({ file: file.file, ids: [layer.id] })}
              data-testid="agent-change-row"
              data-node-id={layer.id}
            >
              <LayerTypeIcon type={layer.type} />
              <span className={cn("truncate", { "is-removed": layer.kind === "removed" })}>{layer.name}</span>
              <span className="push-right muted mono truncate">{layer.kind === "changed" ? (layer.detail ?? "changed") : layer.kind}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

function FailedTurn({ message, last }: { message: string; last: boolean }) {
  const retry = useAgent((s) => s.retry);
  const openTerminal = useAgent((s) => s.openTerminal);
  const busy = useAgent((s) => s.turnId !== null);
  return (
    <div className="agent-error" data-testid="agent-error">
      <div className="agent-error-title">
        <CircleAlert size={16} /> The agent stopped
      </div>
      <div className="agent-error-message">{message}</div>
      {last && (
        <div className="agent-error-actions">
          <button className="btn small" onClick={retry} disabled={busy}>
            <RotateCcw size={14} /> Retry
          </button>
          <button className="btn small" onClick={() => void openTerminal()}>
            <SquareTerminal size={14} /> Open in terminal
          </button>
        </div>
      )}
    </div>
  );
}

const Item = memo(function Item({ item, root, last }: { item: ChatItem; root: string; last: boolean }) {
  switch (item.kind) {
    case "user":
      return <UserMessage text={item.text} />;
    case "text":
      return <Markdown text={item.text} />;
    case "tool":
      return <ToolStep item={item} root={root} />;
    case "changes":
      return <ChangesCard files={item.files} />;
    case "error":
      return <FailedTurn message={item.message} last={last} />;
    case "stopped":
      return <div className="agent-note muted">Stopped</div>;
  }
});

/** "Working · 12s", ticking only while a turn runs, so the rest of the chat doesn't re-render each second. */
function Working({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="agent-working" data-testid="agent-working">
      <LoaderCircle size={14} className="agent-spin accent" /> Working · {Math.max(0, Math.floor((now - since) / 1000))}s
    </div>
  );
}

export function Thread({ items }: { items: ChatItem[] }) {
  const root = useEditor((s) => s.snapshot?.root ?? "");
  const startedAt = useAgent((s) => s.turnStartedAt);
  const queue = useAgent((s) => s.queue);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Stay at the bottom as the reply streams in, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });

  const lastIndex = items.length - 1;
  return (
    <div
      className="agent-thread"
      ref={scroller}
      onScroll={(e) => {
        const element = e.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      data-testid="agent-thread"
    >
      {items.map((item, index) => (
        <Item key={item.id} item={item} root={root} last={index === lastIndex} />
      ))}
      {queue.map((queued, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: queued messages have no id and only ever leave from the front.
        <UserMessage key={index} text={queued.text} queued />
      ))}
      {startedAt !== null && <Working since={startedAt} />}
    </div>
  );
}
