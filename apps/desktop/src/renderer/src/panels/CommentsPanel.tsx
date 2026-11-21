import type { CommentThread } from "@lamsa/schema";
import { CircleCheck, Crosshair, MessageCircle, Unlink } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isOpen, matchesFilter, revealComment, useComments, type CommentFilter } from "../lib/comments";
import { cn } from "../lib/cn";
import { useEditor } from "../lib/store";
import { relativeTime } from "./agent/format";
import { Avatar, ThreadView, useTargetName } from "./comments/Thread";

const FILTERS: { filter: CommentFilter; label: string }[] = [
  { filter: "open", label: "Open" },
  { filter: "resolved", label: "Resolved" },
  { filter: "all", label: "All" },
];

const EMPTY: Record<CommentFilter, { title: string; body: string }> = {
  open: {
    title: "No open comments",
    body: "Pick the comment tool (M) and click a layer to leave a note for your agent or team. Agents read them with lamsa comments.",
  },
  resolved: { title: "Nothing resolved yet", body: "Resolved threads collect here, with the reply that closed them." },
  all: { title: "No comments yet", body: "Pick the comment tool (M) and click a layer to start a thread." },
};

const replyCount = (count: number) => `${count} ${count === 1 ? "reply" : "replies"}`;

function Row({ thread, active }: { thread: CommentThread; active: boolean }) {
  const target = useTargetName(thread.nodeId);
  const orphaned = target === null;
  return (
    <>
      <button
        className={cn("comment-row", { "is-active": active, "is-resolved": !isOpen(thread) })}
        onClick={() => (orphaned && active ? useComments.getState().setActive(null) : void revealComment(thread.id))}
        data-comment-row
        data-testid="comment-row"
        data-comment-id={thread.id}
        data-orphaned={orphaned || undefined}
      >
        <Avatar author={thread.author} />
        <span className="comment-row-body">
          <span className="comment-meta">
            <span className="comment-author">{thread.author}</span>
            <span className="comment-when grow">{relativeTime(Date.parse(thread.createdAt))}</span>
            {!isOpen(thread) && <CircleCheck size={13} className="comment-resolved-mark" aria-label="Resolved" />}
          </span>
          <span className="comment-row-text">{thread.text}</span>
          <span className={cn("comment-row-target", { "is-orphaned": orphaned })}>
            {orphaned ? <Unlink size={12} /> : <Crosshair size={12} />}
            <span>{orphaned ? `Layer deleted · ${thread.nodeId}` : target}</span>
            {thread.replies.length > 0 && <span>· {replyCount(thread.replies.length)}</span>}
          </span>
        </span>
      </button>
      {orphaned && active && (
        <div className="comment-expanded" data-comment-row>
          <ThreadView thread={thread} />
        </div>
      )}
    </>
  );
}

/** Every comment thread in the project, filtered to open, resolved or all; a click shows the thread on its layer. */
export function CommentsPanel() {
  const threads = useEditor((s) => s.comments);
  const { filter, active, errors, setFilter } = useComments(useShallow((s) => ({ filter: s.filter, active: s.active, errors: s.errors, setFilter: s.setFilter })));
  const shown = threads.filter((thread) => matchesFilter(thread, filter));
  const counts: Record<CommentFilter, number | undefined> = {
    open: threads.filter(isOpen).length,
    resolved: threads.filter((thread) => !isOpen(thread)).length,
    all: undefined,
  };
  return (
    <div className="dock-body comments" data-testid="comments-panel">
      <div className="comments-filter-bar">
        <div className="segmented small" role="group" aria-label="Show comments">
          {FILTERS.map(({ filter: option, label }) => (
            <button
              key={option}
              aria-pressed={filter === option}
              className={cn({ "is-on": filter === option })}
              onClick={() => setFilter(option)}
              data-testid={`comments-filter-${option}`}
            >
              {label}
              {counts[option] !== undefined && <span className="comments-count">{counts[option]}</span>}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="comments-empty" data-testid="comments-empty">
          <span className="comments-empty-glyph">
            <MessageCircle size={20} />
          </span>
          <span className="comments-empty-title">{EMPTY[filter].title}</span>
          <span className="comments-empty-body">{EMPTY[filter].body}</span>
        </div>
      ) : (
        <div className="comments-list">
          {[...shown].reverse().map((thread) => (
            <Row key={thread.id} thread={thread} active={thread.id === active} />
          ))}
        </div>
      )}
      {errors.length > 0 && (
        <div className="comments-errors" data-testid="comments-errors">
          {errors.length === 1 ? errors[0] : `${errors.length} comment files can't be read; run lamsa validate`}
        </div>
      )}
    </div>
  );
}
