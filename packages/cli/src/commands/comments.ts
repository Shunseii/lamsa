import {
  addComment,
  commentAuthor,
  didYouMean,
  indexNodes,
  isOpen,
  loadComments,
  loadConfig,
  reopenComment,
  replyToComment,
  resolveComment,
  type CommentThread,
  type NodeLocation,
} from "@lamsa/core";
import type { CommentMessage } from "@lamsa/schema";
import { openWorkspace, resolveRoot } from "../context.js";
import { CliError, ExitCode, type Output } from "../output.js";

/** A thread as the CLI reports it: the file's contents plus whether it's open and what it's pinned to. */
interface CommentView extends CommentThread {
  open: boolean;
  /** The pinned node no longer exists in any design file. */
  orphaned: boolean;
  node: { name?: string; type: string; file: string } | null;
}

function viewOf(thread: CommentThread, locations: Map<string, NodeLocation>): CommentView {
  const location = locations.get(thread.nodeId);
  return {
    ...thread,
    open: isOpen(thread),
    orphaned: !location,
    node: location ? { name: location.node.name, type: location.node.type, file: location.file } : null,
  };
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");
const line = (message: CommentMessage, prefix: string) => `${prefix}${message.author} · ${when(message.createdAt)}: ${message.text}`;

const targetOf = (view: CommentView) =>
  view.node ? `on ${view.nodeId}${view.node.name ? ` ${JSON.stringify(view.node.name)}` : ""} (${view.node.file})` : `on ${view.nodeId} (deleted node)`;

function describe(view: CommentView): string {
  const state = view.resolved ? `resolved by ${view.resolved.author}` : "open";
  return [`${view.id} · ${state} · ${targetOf(view)}`, line(view, "  "), ...view.replies.map((reply) => line(reply, "  ↳ "))].join("\n");
}

async function commentsContext() {
  const root = resolveRoot();
  const config = await loadConfig(root);
  return { root, location: { root, config } };
}

function requireNode({ locations, nodeId }: { locations: Map<string, NodeLocation>; nodeId: string }) {
  if (locations.has(nodeId)) return;
  throw new CliError(`no node "${nodeId}"`, ExitCode.notFound, didYouMean(nodeId, locations.keys()) || "run `lamsa tree` to list node IDs", nodeId);
}

export async function commentsCommand({
  out,
  open,
  resolved,
  node,
}: {
  out: Output;
  open: boolean;
  resolved: boolean;
  node?: string;
}): Promise<number> {
  if (open && resolved) throw new CliError("--open and --resolved can't be combined", ExitCode.usage, "pass one of them, or neither for every comment");
  const { project } = await openWorkspace();
  const { threads, issues } = await loadComments({ root: project.root, config: project.config });
  const locations = indexNodes(project);
  if (node && !threads.some((thread) => thread.nodeId === node)) requireNode({ locations, nodeId: node });
  const views = threads
    .filter((thread) => (!node || thread.nodeId === node) && (!open || isOpen(thread)) && (!resolved || !isOpen(thread)))
    .map((thread) => viewOf(thread, locations));
  const counts = { open: threads.filter(isOpen).length, resolved: threads.filter((thread) => !isOpen(thread)).length };
  out.result({ ok: true, counts, comments: views, issues }, () => {
    const which = open ? "open " : resolved ? "resolved " : "";
    const header = views.length === 0 ? `no ${which}comments${node ? ` on ${node}` : ""}` : `${views.length} ${which}comment(s) · ${counts.open} open, ${counts.resolved} resolved in total`;
    return [header, ...views.map(describe), ...issues.map((issue) => `error ${issue.file}: ${issue.message}`)].join("\n\n");
  });
  return ExitCode.ok;
}

function parseOffset(value: string | undefined): { x: number; y: number } | undefined {
  if (value === undefined) return undefined;
  const [x, y, ...rest] = value.split(",").map((part) => Number(part.trim()));
  if (rest.length || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CliError(`--offset "${value}" isn't a point`, ExitCode.usage, "pass x,y in the node's own pixels, e.g. --offset 24,8");
  }
  return { x, y };
}

export async function commentAddCommand({
  out,
  node,
  text,
  offset,
  author,
}: {
  out: Output;
  node: string;
  text: string;
  offset?: string;
  author?: string;
}): Promise<number> {
  const point = parseOffset(offset);
  const { project } = await openWorkspace();
  const locations = indexNodes(project);
  requireNode({ locations, nodeId: node });
  const thread = await addComment({
    location: { root: project.root, config: project.config },
    nodeId: node,
    text,
    offset: point,
    author: commentAuthor({ root: project.root, explicit: author }),
  });
  const view = viewOf(thread, locations);
  out.result({ ok: true, comment: view }, () => `added comment ${thread.id} ${targetOf(view)}`);
  return ExitCode.ok;
}

async function finish({ out, thread, verb }: { out: Output; thread: CommentThread; verb: string }): Promise<number> {
  const { project } = await openWorkspace();
  const view = viewOf(thread, indexNodes(project));
  out.result({ ok: true, comment: view }, () => `${verb} ${thread.id}\n${describe(view)}`);
  return ExitCode.ok;
}

export async function commentReplyCommand({ out, id, text, author }: { out: Output; id: string; text: string; author?: string }): Promise<number> {
  const { root, location } = await commentsContext();
  const thread = await replyToComment({ location, id, text, author: commentAuthor({ root, explicit: author }) });
  return finish({ out, thread, verb: "replied to" });
}

export async function commentResolveCommand({ out, id, reply, author }: { out: Output; id: string; reply?: string; author?: string }): Promise<number> {
  const { root, location } = await commentsContext();
  const thread = await resolveComment({ location, id, reply, author: commentAuthor({ root, explicit: author }) });
  return finish({ out, thread, verb: "resolved" });
}

export async function commentReopenCommand({ out, id }: { out: Output; id: string }): Promise<number> {
  const { location } = await commentsContext();
  const thread = await reopenComment({ location, id });
  return finish({ out, thread, verb: "reopened" });
}
