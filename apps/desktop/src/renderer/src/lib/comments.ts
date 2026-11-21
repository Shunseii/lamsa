import type { CommentThread } from "@lamsa/schema";
import { create } from "zustand";
import type { CommentRequest, CommentsState } from "../../../shared/api";
import { findElement } from "../canvas/FrameView";
import { rootOf } from "./model";
import { api, useEditor } from "./store";

export type CommentFilter = "open" | "resolved" | "all";

/** A comment being written: the layer it pins to and the point inside it, in the layer's own pixels. */
export interface CommentDraft {
  nodeId: string;
  offset: { x: number; y: number };
}

interface CommentsUi {
  /** Which threads the panel lists and the canvas pins. */
  filter: CommentFilter;
  /** The thread open in a popover on the canvas, or expanded in the panel when its layer is gone. */
  active: string | null;
  draft: CommentDraft | null;
  /** Thread files that couldn't be read. */
  errors: string[];
  setFilter(filter: CommentFilter): void;
  setActive(id: string | null): void;
  setDraft(draft: CommentDraft | null): void;
  /** Writes a comment change; false (with a toast) when it couldn't be saved. */
  submit(request: CommentRequest): Promise<boolean>;
}

export const isOpen = (thread: CommentThread) => !thread.resolved;

export const matchesFilter = (thread: CommentThread, filter: CommentFilter) =>
  filter === "all" || (filter === "open") === isOpen(thread);

export const useComments = create<CommentsUi>((set, get) => ({
  filter: "open",
  active: null,
  draft: null,
  errors: [],
  setFilter: (filter) => {
    const active = useEditor.getState().comments.find((thread) => thread.id === get().active);
    set({ filter, active: active && matchesFilter(active, filter) ? active.id : null });
  },
  setActive: (active) => set({ active, draft: null }),
  setDraft: (draft) => set({ draft, active: null }),
  async submit(request) {
    try {
      receive(await api().updateComments(request), { quiet: true });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(error);
      useEditor.getState().toast({ tone: "danger", title: "Couldn't save the comment", message });
      return false;
    }
  },
}));

/** Who changed what since `previous`, for a toast when the change came from outside the editor (usually the agent). */
function describeOutsideChange(previous: CommentThread[], next: CommentThread[]): { title: string; message: string; id: string } | null {
  const before = new Map(previous.map((thread) => [thread.id, thread]));
  for (const thread of next) {
    const old = before.get(thread.id);
    if (!old) return { title: `${thread.author} commented`, message: thread.text, id: thread.id };
    if (thread.resolved && !old.resolved) {
      const closing = thread.replies.length > old.replies.length ? thread.replies.at(-1)!.text : thread.text;
      return { title: `${thread.resolved.author} resolved a comment`, message: closing, id: thread.id };
    }
    if (thread.replies.length > old.replies.length) {
      const reply = thread.replies.at(-1)!;
      return { title: `${reply.author} replied`, message: reply.text, id: thread.id };
    }
  }
  return null;
}

function receive(state: CommentsState, { quiet }: { quiet: boolean }) {
  const editor = useEditor.getState();
  const previous = editor.comments;
  useEditor.setState({ comments: state.threads });
  const ui = useComments.getState();
  const ids = new Set(state.threads.map((thread) => thread.id));
  useComments.setState({ errors: state.errors, active: ui.active && ids.has(ui.active) ? ui.active : null });
  if (quiet) return;
  const change = describeOutsideChange(previous, state.threads);
  // The open thread already shows the change, so a toast would only repeat it.
  if (change && change.id !== ui.active) editor.toast({ tone: "neutral", title: change.title, message: change.message, action: { label: "Show", run: () => void revealComment(change.id) } });
}

/** Loads comments when a project opens and follows changes on disk. Returns the unsubscribe. */
export function installComments(): () => void {
  let root: string | undefined;
  const load = () => {
    const next = useEditor.getState().snapshot?.root;
    if (next === root) return;
    root = next;
    useComments.setState({ active: null, draft: null });
    if (!next) {
      useEditor.setState({ comments: [] });
      return;
    }
    useEditor.setState({ comments: [] });
    void api()
      .comments()
      .then((state) => {
        if (useEditor.getState().snapshot?.root === next) receive(state, { quiet: true });
      });
  };
  load();
  const offs = [
    useEditor.subscribe((state, previous) => {
      if (state.snapshot !== previous.snapshot) load();
      // Leaving the comment tool drops a comment that was never posted.
      if (state.tool !== previous.tool && previous.tool === "comment" && useComments.getState().draft) useComments.getState().setDraft(null);
    }),
    api().onCommentsChanged((state) => receive(state, { quiet: false })),
  ];
  return () => {
    for (const off of offs) off();
  };
}

/** The canvas's current scale and the world origin on screen, read from the DOM so they match what is drawn. */
export function worldTransform(): { origin: DOMRect; zoom: number } | null {
  const world = document.querySelector<HTMLElement>(".canvas > .world");
  if (!world) return null;
  let zoom = useEditor.getState().viewport.zoom;
  try {
    zoom = new DOMMatrixReadOnly(getComputedStyle(world).transform).a || zoom;
  } catch {
    // An unparseable transform: the store's zoom is what React last drew, which is close enough.
  }
  return { origin: world.getBoundingClientRect(), zoom };
}

/** Starts a comment on `nodeId` at the pointer: the offset is where it was clicked inside the layer. */
export function startCommentAt({ nodeId, clientX, clientY }: { nodeId: string; clientX: number; clientY: number }) {
  const { model } = useEditor.getState();
  const rect = findElement(rootOf(model, nodeId), nodeId)?.getBoundingClientRect();
  const transform = worldTransform();
  if (!rect || !transform) return;
  const offset = { x: Math.round((clientX - rect.left) / transform.zoom), y: Math.round((clientY - rect.top) / transform.zoom) };
  useComments.getState().setDraft({ nodeId, offset });
}

/** Centers the view on a layer at the current zoom. */
function panTo(nodeId: string) {
  const { model, viewport, setViewport } = useEditor.getState();
  const rect = findElement(rootOf(model, nodeId), nodeId)?.getBoundingClientRect();
  const canvas = document.querySelector(".canvas")?.getBoundingClientRect();
  if (!rect || !canvas) return;
  const dx = canvas.left + canvas.width / 2 - (rect.left + rect.width / 2);
  const dy = canvas.top + canvas.height / 2 - (rect.top + rect.height / 2);
  setViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });
}

/**
 * Shows a thread: its layer is selected and brought into view (its file opens if it isn't), and the thread opens there.
 * A thread whose layer was deleted opens in the panel instead.
 */
export async function revealComment(id: string): Promise<void> {
  const editor = useEditor.getState();
  const thread = editor.comments.find((candidate) => candidate.id === id);
  if (!thread) return;
  const ui = useComments.getState();
  if (!matchesFilter(thread, ui.filter)) ui.setFilter(isOpen(thread) ? "open" : "resolved");
  const file = editor.model.fileOf.get(thread.nodeId);
  if (file && !(editor.openFiles ?? []).includes(file)) await editor.addFiles([file]);
  if (useEditor.getState().model.nodes[thread.nodeId]) {
    useEditor.getState().select([thread.nodeId]);
    requestAnimationFrame(() => panTo(thread.nodeId));
  }
  useComments.getState().setActive(id);
}

/** Author initials and a colour per author, so the same person always looks the same. */
const AVATAR_TONES = ["accent", "ok", "warn", "danger", "ink-2"] as const;

export function avatarOf(author: string): { initial: string; tone: (typeof AVATAR_TONES)[number] } {
  let hash = 0;
  for (const char of author) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { initial: (author.trim()[0] ?? "?").toUpperCase(), tone: AVATAR_TONES[hash % AVATAR_TONES.length]! };
}
