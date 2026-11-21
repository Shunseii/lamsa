import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { COMMENT_FORMAT_VERSION, commentThreadSchema, type CommentThread, type DesignNode, type LamsaConfig } from "@lamsa/schema";
import { newId } from "./ids.js";
import { stableStringify, writeFileAtomic } from "./json.js";
import { EditError } from "./mutate.js";
import { didYouMean } from "./suggest.js";
import type { Issue } from "./validate.js";

export type { CommentThread };

export interface LoadedComments {
  threads: CommentThread[];
  /** Thread files that aren't valid JSON or don't match the schema. */
  issues: Issue[];
}

interface CommentsLocation {
  root: string;
  config: Pick<LamsaConfig, "commentsDir">;
}

const THREAD_FILE = /^([A-Za-z0-9_-]{1,64})\.json$/;

const threadPath = ({ config }: CommentsLocation, id: string) => `${config.commentsDir.replace(/\/+$/, "")}/${id}.json`;

export const isOpen = (thread: Pick<CommentThread, "resolved">) => !thread.resolved;

async function readThread(location: CommentsLocation, id: string): Promise<{ thread?: CommentThread; issue?: Issue }> {
  const path = threadPath(location, id);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(location.root, path), "utf8"));
  } catch (error) {
    return { issue: { severity: "error", code: "comment-invalid", file: path, message: `comment thread is not valid JSON: ${(error as Error).message}`, fix: "fix the JSON or delete the file" } };
  }
  const parsed = commentThreadSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return { issue: { severity: "error", code: "comment-invalid", file: path, message: `comment thread doesn't match the schema: ${where}${first?.message ?? "invalid"}`, fix: "edit comments with `lamsa comments`, not by hand" } };
  }
  return { thread: { ...parsed.data, id, path } };
}

async function threadIds(location: CommentsLocation): Promise<string[]> {
  const dir = join(location.root, location.config.commentsDir);
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .map((name) => THREAD_FILE.exec(name)?.[1])
    .filter((id): id is string => !!id)
    .sort();
}

/** Every comment thread in the project, oldest first. A missing comments directory means no comments. */
export async function loadComments(location: CommentsLocation): Promise<LoadedComments> {
  const threads: CommentThread[] = [];
  const issues: Issue[] = [];
  for (const id of await threadIds(location)) {
    const { thread, issue } = await readThread(location, id);
    if (thread) threads.push(thread);
    if (issue) issues.push(issue);
  }
  threads.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  return { threads, issues };
}

/** Comments pinned to nodes that no longer exist. They are kept (the conversation still matters) but flagged. */
export function validateComments({ threads, nodes }: { threads: CommentThread[]; nodes: Record<string, DesignNode> }): Issue[] {
  return threads
    .filter((thread) => !nodes[thread.nodeId])
    .map((thread) => ({
      severity: "warning" as const,
      code: "comment-orphaned",
      file: thread.path,
      nodeId: thread.nodeId,
      message: `comment ${thread.id} is pinned to ${thread.nodeId}, which no longer exists`,
      fix: isOpen(thread) ? `address it, then \`lamsa comments resolve ${thread.id} --reply "<what you did>"\`` : `delete ${thread.path} if the thread is no longer useful`,
    }));
}

/** The agent's name when the CLI runs under one: `LAMSA_AGENT_NAME`, or Claude Code's own marker. */
function agentAuthor(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.LAMSA_AGENT_NAME?.trim();
  if (named) return named;
  return env.CLAUDECODE === "1" ? "Claude" : undefined;
}

/**
 * Who is writing a comment: `explicit` (the `--author` flag), `LAMSA_AUTHOR`, the agent running the CLI (when
 * `detectAgent`), then git's `user.name`, then the OS user.
 */
export function commentAuthor({
  root,
  explicit,
  env = process.env,
  detectAgent = true,
}: {
  root: string;
  explicit?: string;
  env?: NodeJS.ProcessEnv;
  detectAgent?: boolean;
}): string {
  const chosen = explicit?.trim() || env.LAMSA_AUTHOR?.trim() || (detectAgent ? agentAuthor(env) : undefined);
  if (chosen) return chosen;
  const git = spawnSync("git", ["config", "user.name"], { cwd: root, encoding: "utf8" });
  const name = git.status === 0 ? git.stdout.trim() : "";
  if (name) return name;
  try {
    return userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

async function writeThread(location: CommentsLocation, thread: CommentThread): Promise<CommentThread> {
  const { id: _id, path: _path, ...file } = thread;
  await writeFileAtomic(join(location.root, thread.path), stableStringify(file));
  return thread;
}

function requireText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new EditError("comment text is empty", 'pass the text as an argument, e.g. "make this denser"');
  return trimmed;
}

/** Reads a thread fresh from disk, so concurrent writers (the editor, an agent) don't overwrite each other's replies. */
export async function requireThread(location: CommentsLocation, id: string): Promise<CommentThread> {
  const ids = await threadIds(location);
  if (!ids.includes(id)) {
    throw new EditError(`no comment "${id}"`, didYouMean(id, ids) || "run `lamsa comments --json` to list comment IDs", undefined, true);
  }
  const { thread, issue } = await readThread(location, id);
  if (!thread) throw new EditError(issue!.message, issue!.fix);
  return thread;
}

export async function addComment({
  location,
  nodeId,
  text,
  author,
  offset,
  now = new Date(),
}: {
  location: CommentsLocation;
  nodeId: string;
  text: string;
  author: string;
  offset?: { x: number; y: number };
  now?: Date;
}): Promise<CommentThread> {
  const id = newId(new Set(await threadIds(location)));
  return writeThread(location, {
    id,
    path: threadPath(location, id),
    version: COMMENT_FORMAT_VERSION,
    nodeId,
    ...(offset ? { offset: { x: Math.round(offset.x), y: Math.round(offset.y) } } : {}),
    author,
    createdAt: now.toISOString(),
    text: requireText(text),
    replies: [],
  });
}

export async function replyToComment({
  location,
  id,
  text,
  author,
  now = new Date(),
}: {
  location: CommentsLocation;
  id: string;
  text: string;
  author: string;
  now?: Date;
}): Promise<CommentThread> {
  const thread = await requireThread(location, id);
  return writeThread(location, { ...thread, replies: [...thread.replies, { author, createdAt: now.toISOString(), text: requireText(text) }] });
}

/** Resolves a thread, optionally with a closing reply. Resolving a resolved thread keeps who resolved it first. */
export async function resolveComment({
  location,
  id,
  author,
  reply,
  now = new Date(),
}: {
  location: CommentsLocation;
  id: string;
  author: string;
  reply?: string;
  now?: Date;
}): Promise<CommentThread> {
  const thread = await requireThread(location, id);
  const replies = reply === undefined ? thread.replies : [...thread.replies, { author, createdAt: now.toISOString(), text: requireText(reply) }];
  return writeThread(location, { ...thread, replies, resolved: thread.resolved ?? { author, at: now.toISOString() } });
}

export async function reopenComment({ location, id }: { location: CommentsLocation; id: string }): Promise<CommentThread> {
  const { resolved: _resolved, ...thread } = await requireThread(location, id);
  return writeThread(location, thread);
}
