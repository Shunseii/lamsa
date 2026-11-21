import { join, relative, sep } from "node:path";
import {
  addComment,
  commentAuthor,
  loadComments,
  reopenComment,
  replyToComment,
  resolveComment,
} from "@lamsa/core";
import type { LamsaConfig } from "@lamsa/schema";
import chokidar, { type FSWatcher } from "chokidar";
import type { CommentRequest, CommentsState } from "../shared/api.js";

const RELOAD_DEBOUNCE_MS = 30;

/**
 * A project's comment threads for one window: it reads them from the comments directory, writes the user's comments,
 * replies and resolves there, and reloads when anything else (usually the agent's CLI) changes a thread file.
 */
export class CommentsService {
  private location?: { root: string; config: Pick<LamsaConfig, "commentsDir"> };
  private watcher?: FSWatcher;
  private state: CommentsState = { threads: [], errors: [] };
  private author?: string;
  private reloadTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly changed: (state: CommentsState) => void) {}

  async open({ root, config }: { root: string; config: LamsaConfig }): Promise<void> {
    await this.close();
    this.location = { root, config };
    this.author = undefined;
    await this.reload({ announce: false });
    this.watch();
  }

  async close(): Promise<void> {
    clearTimeout(this.reloadTimer);
    await this.watcher?.close();
    this.watcher = undefined;
    this.location = undefined;
    this.state = { threads: [], errors: [] };
  }

  current(): CommentsState {
    return this.state;
  }

  /** The editor is the person at the keyboard, so an agent marker in the environment it was started from doesn't count. */
  private authorName(root: string): string {
    this.author ??= commentAuthor({ root, detectAgent: false });
    return this.author;
  }

  async apply(request: CommentRequest): Promise<CommentsState> {
    const location = this.location;
    if (!location) throw new Error("no project open");
    const author = this.authorName(location.root);
    if (request.kind === "add") await addComment({ location, nodeId: request.nodeId, offset: request.offset, text: request.text, author });
    else if (request.kind === "reply") await replyToComment({ location, id: request.id, text: request.text, author });
    else if (request.kind === "resolve") await resolveComment({ location, id: request.id, reply: request.reply, author });
    else await reopenComment({ location, id: request.id });
    // The editor gets the result as the reply to its own request, so it isn't announced as an outside change.
    await this.reload({ announce: false });
    return this.state;
  }

  private async reload({ announce }: { announce: boolean } = { announce: true }) {
    const location = this.location;
    if (!location) return;
    const { threads, issues } = await loadComments(location);
    if (location !== this.location) return;
    const next: CommentsState = { threads, errors: issues.map((issue) => `${issue.file}: ${issue.message}`) };
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    if (announce) this.changed(next);
  }

  /**
   * Watches the comments directory, which may not exist yet: the watch starts at the project root but only descends
   * along the directory's path, so the rest of the repo is never scanned.
   */
  private watch() {
    const location = this.location;
    if (!location) return;
    const dir = join(location.root, location.config.commentsDir);
    const onPath = (path: string) => {
      const rel = relative(dir, path);
      if (rel === "" || (!rel.startsWith("..") && !rel.includes(sep))) return true;
      // An ancestor of the comments directory (a prefix of its path) has to be watched for it to appear.
      return relative(path, dir).split(sep).every((part) => part !== "..");
    };
    this.watcher = chokidar.watch(location.root, {
      ignoreInitial: true,
      ignored: (path) => !onPath(path),
      awaitWriteFinish: { stabilityThreshold: 30, pollInterval: 15 },
    });
    const schedule = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(() => void this.reload().catch(() => {}), RELOAD_DEBOUNCE_MS);
    };
    this.watcher.on("all", schedule);
  }
}
