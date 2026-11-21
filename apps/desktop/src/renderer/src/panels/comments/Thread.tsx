import type { CommentMessage, CommentThread } from "@lamsa/schema";
import { ArrowUp, CircleCheck, Crosshair, RotateCcw, Unlink, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { avatarOf, useComments, type CommentDraft } from "../../lib/comments";
import { cn } from "../../lib/cn";
import { nodeTitle } from "../../lib/model";
import { useEditor } from "../../lib/store";
import { relativeTime } from "../agent/format";
import "./comments.css";

export function Avatar({ author }: { author: string }) {
  const { initial, tone } = avatarOf(author);
  return (
    <span className={cn("comment-avatar", `tone-${tone}`)} aria-hidden>
      {initial}
    </span>
  );
}

export function Message({ message }: { message: CommentMessage }) {
  return (
    <div className="comment-message">
      <Avatar author={message.author} />
      <div className="comment-message-body">
        <div className="comment-meta">
          <span className="comment-author">{message.author}</span>
          <time className="comment-when" dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
            {relativeTime(Date.parse(message.createdAt))}
          </time>
        </div>
        <div className="comment-text">{message.text}</div>
      </div>
    </div>
  );
}

/** The layer a thread is pinned to, as the panel and thread header name it. */
export function useTargetName(nodeId: string): string | null {
  return useEditor((s) => {
    const node = s.model.nodes[nodeId];
    return node ? nodeTitle(nodeId, node) : null;
  });
}

/** Enter sends, Shift+Enter adds a line, Escape cancels. */
function onComposerKey({ event, send, cancel }: { event: KeyboardEvent<HTMLTextAreaElement>; send: () => void; cancel: () => void }) {
  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
    event.preventDefault();
    send();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }
}

function ReplyBox({ thread }: { thread: CommentThread }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await useComments.getState().submit({ kind: "reply", id: thread.id, text });
    setSending(false);
    if (ok) setText("");
  };
  return (
    <div className="comment-reply">
      <textarea
        className="comment-input"
        rows={1}
        placeholder="Reply…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(event) => onComposerKey({ event, send: () => void send(), cancel: () => useComments.getState().setActive(null) })}
        aria-label="Reply"
        data-testid="comment-reply-input"
      />
      <button className={cn("comment-send", { "is-ready": !!text.trim() })} onClick={() => void send()} disabled={!text.trim() || sending} aria-label="Send reply" data-testid="comment-reply-send">
        <ArrowUp size={16} />
      </button>
    </div>
  );
}

/** A whole thread: what it's pinned to, its messages, and a reply box (or who resolved it). */
export function ThreadView({ thread, onClose }: { thread: CommentThread; onClose?: () => void }) {
  const target = useTargetName(thread.nodeId);
  const submit = useComments((s) => s.submit);
  const messages = useRef<HTMLDivElement>(null);
  const count = thread.replies.length;
  useEffect(() => {
    if (count >= 0) messages.current?.scrollTo({ top: messages.current.scrollHeight });
  }, [count]);
  return (
    <div className="comment-thread" data-testid="comment-thread" data-comment-id={thread.id}>
      <div className="comment-thread-header">
        {target ? <Crosshair size={13} className="muted" /> : <Unlink size={13} className="comment-orphan-icon" />}
        <span className="comment-thread-target">{target ?? `Layer deleted · ${thread.nodeId}`}</span>
        {thread.resolved ? (
          <button className="icon-btn tiny" onClick={() => void submit({ kind: "reopen", id: thread.id })} aria-label="Reopen" title="Reopen" data-testid="comment-reopen">
            <RotateCcw size={14} />
          </button>
        ) : (
          <button className="icon-btn tiny" onClick={() => void submit({ kind: "resolve", id: thread.id })} aria-label="Resolve" title="Resolve" data-testid="comment-resolve">
            <CircleCheck size={14} />
          </button>
        )}
        {onClose && (
          <button className="icon-btn tiny" onClick={onClose} aria-label="Close" title="Close">
            <X size={14} />
          </button>
        )}
      </div>
      {thread.resolved && (
        <div className="comment-resolved" data-testid="comment-resolved">
          <CircleCheck size={13} /> Resolved by {thread.resolved.author}
        </div>
      )}
      <div ref={messages} className="comment-messages">
        <Message message={thread} />
        {thread.replies.map((reply) => (
          <Message key={`${reply.createdAt}-${reply.author}`} message={reply} />
        ))}
      </div>
      {!thread.resolved && <ReplyBox thread={thread} />}
    </div>
  );
}

/** Writing a new comment on a layer. */
export function Composer({ draft }: { draft: CommentDraft }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const target = useTargetName(draft.nodeId);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    requestAnimationFrame(() => input.current?.focus());
  }, [draft]);
  const cancel = () => useComments.getState().setDraft(null);
  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    const ok = await useComments.getState().submit({ kind: "add", nodeId: draft.nodeId, offset: draft.offset, text });
    setSending(false);
    if (ok) cancel();
  };
  return (
    <div className="comment-composer" data-testid="comment-composer">
      <textarea
        ref={input}
        className="comment-input"
        rows={3}
        placeholder="Add a comment…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(event) => onComposerKey({ event, send: () => void send(), cancel })}
        aria-label="Comment"
        data-testid="comment-input"
      />
      <div className="comment-composer-footer">
        <span className="comment-composer-target">on {target ?? draft.nodeId}</span>
        <button className="btn small" onClick={cancel}>
          Cancel
        </button>
        <button className="btn small btn-accent" onClick={() => void send()} disabled={!text.trim() || sending} data-testid="comment-submit">
          Comment
        </button>
      </div>
    </div>
  );
}
