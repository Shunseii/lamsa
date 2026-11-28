import { applyMotionState, motionLength, motionStatesIn } from "@lamsa/renderer";

/** Pointer states are played by really hovering or pressing in the preview; they're only measured for the crop. */
export const POINTER_STATES = ["hover", "press", "focus"];
const CACHE_LIMIT = 1000;
/**
 * A state takes a few milliseconds to measure. Each slice measures for about this long, even when the
 * page has little idle time (its cells keep animating), so a big preview is done in seconds, not minutes.
 */
const SLICE_MS = 12;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bounds {
  crop: Rect;
  rest: Rect;
  frame: { w: number; h: number };
}

export interface Measured {
  bounds: Bounds;
  states: string[];
  length: number;
}

interface Subject {
  html: string;
  id: string;
  isRoot: boolean;
}

const union = (all: Rect[]): Rect => {
  // A state that hides the layer (`display: none`) measures 0×0 at the frame's corner; it adds nothing.
  const visible = all.filter((r) => r.w > 0 || r.h > 0);
  const rects = visible.length ? visible : all;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

export const rectIn = (frame: HTMLElement, target: HTMLElement): Rect => {
  const base = frame.getBoundingClientRect();
  const r = target.getBoundingClientRect();
  const scale = base.width / (frame.offsetWidth || 1) || 1;
  return { x: (r.left - base.left) / scale, y: (r.top - base.top) / scale, w: r.width / scale, h: r.height / scale };
};

/** Where `target` travels while its animations run, in the frame's own pixels. Restarts them from 0. */
function motionBounds(root: ShadowRoot, frame: HTMLElement, target: HTMLElement): Rect {
  const animations = root.getAnimations();
  const length = motionLength(root);
  const rects = [rectIn(frame, target)];
  if (length > 0) {
    for (let i = 0; i <= 12; i++) {
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = (length * i) / 12;
      }
      rects.push(rectIn(frame, target));
    }
    for (const animation of animations) {
      animation.currentTime = 0;
      animation.play();
    }
  }
  return union(rects);
}

/**
 * Where the layer travels across every state, measured in a hidden copy so the visible cell never
 * resizes or restarts its animations when the state changes. Each state is a full remount, so it
 * yields between states to let a caller spread the work over several tasks.
 */
function* measureSteps({ root, html, id, isRoot }: Subject & { root: ShadowRoot }): Generator<void, Measured | null> {
  const mount = () => {
    root.innerHTML = html;
    const frame = root.querySelector<HTMLElement>(".lamsa-surface > [data-node-id]");
    const target = isRoot ? frame : root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
    return frame && target ? { frame, target } : null;
  };
  const first = mount();
  if (!first) return null;
  const own = (first.target.getAttribute("data-lamsa-states") ?? "").split(" ").filter(Boolean);
  const states = [...new Set([...own, ...motionStatesIn(first.target)])];
  const length = motionLength(root);
  const rest = rectIn(first.frame, first.target);
  const frame = { w: first.frame.offsetWidth, h: first.frame.offsetHeight };
  const rects = [motionBounds(root, first.frame, first.target)];
  for (const state of [...POINTER_STATES, ...states]) {
    yield;
    const found = mount();
    if (!found) continue;
    found.frame.getBoundingClientRect();
    applyMotionState(root, state, isRoot ? null : found.target);
    found.frame.getBoundingClientRect();
    rects.push(motionBounds(root, found.frame, found.target));
  }
  return { bounds: { crop: union(rects), rest, frame }, states, length };
}

function hiddenRoot(): { container: HTMLDivElement; root: ShadowRoot } {
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; left: -100000px; top: 0; visibility: hidden; pointer-events: none;";
  document.body.appendChild(container);
  return { container, root: container.attachShadow({ mode: "open" }) };
}

/** A 53-bit string hash (cyrb53), so the cache keys on the design without holding every frame's HTML. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The HTML holds everything that affects the result (the frame's nodes, tokens, mode, reduced motion), so it doubles as the design version. */
export const measureKey = ({ html, id, isRoot }: Subject) => `${id}|${isRoot ? "root" : "layer"}|${html.length}|${hash(html)}`;

const cache = new Map<string, Measured | null>();

export function cachedMeasure(key: string): Measured | null | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function remember(key: string, value: Measured | null) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

/** Measures right away, blocking: for a handful of cells, so they open at their final size. */
export function measureNow(subject: Subject): Measured | null {
  const { container, root } = hiddenRoot();
  try {
    const steps = measureSteps({ ...subject, root });
    let step = steps.next();
    while (!step.done) step = steps.next();
    remember(measureKey(subject), step.value);
    return step.value;
  } finally {
    container.remove();
  }
}

interface Job extends Subject {
  key: string;
  urgent: boolean;
  listeners: Set<(measured: Measured | null) => void>;
}

const queue = new Map<string, Job>();
let running: { job: Job; steps: Generator<void, Measured | null> } | null = null;
let scheduled = false;
let shared: ReturnType<typeof hiddenRoot> | null = null;

function nextJob(): Job | undefined {
  for (const job of queue.values()) if (job.urgent) return job;
  return queue.values().next().value;
}

/** One state's remount and reads. Returns false once there's nothing left to measure. */
function step(): boolean {
  if (!running) {
    const job = nextJob();
    if (!job) return false;
    queue.delete(job.key);
    shared ??= hiddenRoot();
    running = { job, steps: measureSteps({ ...job, root: shared.root }) };
  }
  const { job, steps } = running;
  const next = steps.next();
  if (next.done) {
    running = null;
    shared!.root.innerHTML = "";
    remember(job.key, next.value);
    for (const listener of job.listeners) listener(next.value);
  }
  return true;
}

/** Steps for a slice (at least one step), so no task holds the thread for much longer than a state takes. */
function work(deadline: IdleDeadline) {
  scheduled = false;
  const end = performance.now() + Math.max(SLICE_MS, deadline.timeRemaining());
  while (step() && performance.now() < end);
  if (!running && queue.size === 0) release();
  schedule();
}

function release() {
  shared?.container.remove();
  shared = null;
}

function schedule() {
  if (scheduled || (!running && queue.size === 0)) return;
  scheduled = true;
  requestIdleCallback(work, { timeout: 50 });
}

function cancel(job: Job, listener: (measured: Measured | null) => void) {
  job.listeners.delete(listener);
  if (job.listeners.size > 0) return;
  queue.delete(job.key);
  if (running?.job === job) {
    running = null;
    if (shared) shared.root.innerHTML = "";
  }
  if (!running && queue.size === 0) release();
}

/**
 * Measures in the background, one state at a time, in a single reused hidden container.
 * Hurried jobs (cells on screen) go first. Returns controls to hurry or drop the request.
 */
export function measureLater(subject: Subject & { key: string; onMeasured: (measured: Measured | null) => void }): { hurry: () => void; cancel: () => void } {
  const { key, onMeasured, ...fields } = subject;
  const job = running?.job.key === key ? running.job : (queue.get(key) ?? { ...fields, key, urgent: false, listeners: new Set() });
  job.listeners.add(onMeasured);
  if (running?.job !== job) queue.set(key, job);
  schedule();
  return {
    hurry: () => {
      job.urgent = true;
    },
    cancel: () => cancel(job, onMeasured),
  };
}
