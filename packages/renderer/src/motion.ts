/**
 * Browser-side helpers shared by the desktop preview and `lamsa render`. Each function is
 * self-contained (no outside references) so it can also run in a page via `fn.toString()`.
 */

/** `rest`, `hover`, `press`, `focus`, or a `data-state` value the CSS styles (e.g. `loading`). */
export type MotionState = string;

/**
 * Puts nodes into a state without a pointer. With `target`, hover/press/focus apply to it and its
 * ancestors (as a real pointer would) and `data-state` values to it and its descendants; without,
 * to every node under `scope`.
 */
export function applyMotionState(scope: ParentNode, state: MotionState, target?: Element | null): void {
  const forced: Record<string, string> = { hover: "data-force-hover", press: "data-force-active", focus: "data-force-focus" };
  const all = Array.from(scope.querySelectorAll("[data-node-id]"));
  for (const element of all) {
    for (const attr of Object.values(forced)) element.removeAttribute(attr);
    if (element.hasAttribute("data-lamsa-states")) element.removeAttribute("data-state");
  }
  if (state === "rest") return;
  const attr = forced[state];
  let elements = all;
  if (target) {
    if (attr) {
      elements = [];
      for (let current: Element | null = target; current; current = current.parentElement) {
        if (current.hasAttribute("data-node-id")) elements.push(current);
      }
    } else {
      elements = [target, ...Array.from(target.querySelectorAll("[data-node-id]"))];
    }
  }
  for (const element of elements) {
    if (attr) element.setAttribute(attr, "");
    else if ((element.getAttribute("data-lamsa-states") ?? "").split(" ").includes(state)) element.setAttribute("data-state", state);
  }
}

/** The `data-state` values styled anywhere under `scope`. */
export function motionStatesIn(scope: ParentNode): string[] {
  const states = new Set<string>();
  for (const element of Array.from(scope.querySelectorAll("[data-lamsa-states]"))) {
    for (const state of (element.getAttribute("data-lamsa-states") ?? "").split(" ")) if (state) states.add(state);
  }
  return [...states];
}

/** Jumps finite animations and transitions to their end; parks infinite ones at their start. */
export function settleAnimations(scope: Document | ShadowRoot): void {
  for (const animation of scope.getAnimations()) {
    const timing = animation.effect?.getComputedTiming();
    if (timing && timing.endTime === Infinity) {
      animation.pause();
      animation.currentTime = 0;
    } else {
      try {
        animation.finish();
      } catch {
        animation.pause();
      }
    }
  }
}

/**
 * Like settleAnimations, but leaves nothing running: each animation's resting value is written onto its element's
 * style and the animation is cancelled. A paused animation still gets its own compositing layer (and so does
 * everything drawn over it), which makes every pan and zoom of a large canvas slow; a plain style costs nothing.
 * An animation whose value can't be written (one on a pseudo-element) stays parked instead.
 */
export function freezeAnimations(scope: Document | ShadowRoot): void {
  settleAnimations(scope);
  for (const animation of scope.getAnimations()) {
    try {
      if (animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement) continue;
      animation.commitStyles();
      animation.cancel();
    } catch {
      // Not rendered or not committable: it stays parked, which looks the same.
    }
  }
}

/** Milliseconds until every animation under `scope` ends; an infinite one counts one iteration. */
export function motionLength(scope: Document | ShadowRoot): number {
  let end = 0;
  for (const animation of scope.getAnimations()) {
    const timing = animation.effect?.getComputedTiming();
    if (!timing) continue;
    const delay = Number(timing.delay ?? 0);
    const duration = typeof timing.duration === "number" ? timing.duration : 0;
    const finite = timing.endTime === Infinity ? delay + duration : Number(timing.endTime ?? 0);
    end = Math.max(end, finite);
  }
  return end;
}

/** Pauses every animation under `scope` at `time` ms. */
export function seekAnimations(scope: Document | ShadowRoot, time: number): void {
  for (const animation of scope.getAnimations()) {
    animation.pause();
    animation.currentTime = time;
  }
}
