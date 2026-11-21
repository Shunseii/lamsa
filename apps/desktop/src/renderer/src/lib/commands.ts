import type { DesignNode } from "@lamsa/schema";
import type { NodeChange } from "../../../shared/api";
import { deleteSubtrees, detachInstance, duplicate, fromNested, groupIntoFrame, insertNodes, toNested, topmost } from "./edits";
import { hiddenByDefault, isLocked, rootOf } from "./model";
import { PANEL_IDS } from "./layout";
import { firstOpenFile, isPreviewShown, useEditor } from "./store";
import { fitTo, measuredSize, zoomBy, zoomTo } from "./viewport";

export type CommandName =
  | "copy"
  | "cut"
  | "paste"
  | "duplicate"
  | "group"
  | "delete"
  | "select-parent"
  | "select-all"
  | "copy-id"
  | "zoom-selection"
  | "zoom-fit"
  | "zoom-100"
  | "zoom-in"
  | "zoom-out"
  | "undo"
  | "redo"
  | "go-to-main"
  | "detach"
  | "toggle-hidden"
  | "toggle-locked"
  | "preview-animations"
  | "toggle-preview"
  | "reset-panel-layout";

export async function runCommand(name: CommandName): Promise<void> {
  const state = useEditor.getState();
  const { model, selection, commit, select } = state;
  switch (name) {
    case "reset-panel-layout":
      state.resetLayout();
      return;
    case "preview-animations":
      state.openPreview(topmost(model, selection));
      return;
    case "toggle-preview":
      if (isPreviewShown(state)) state.closePreview();
      else state.openPreview(topmost(model, selection));
      return;
    case "copy":
    case "cut": {
      const ids = topmost(model, selection);
      if (!ids.length) return;
      await navigator.clipboard.writeText(JSON.stringify(ids.map((id) => toNested(model, id)), null, 2));
      if (name === "cut") {
        await commit("Cut", deleteSubtrees(model, ids));
        select([]);
      }
      return;
    }
    case "paste": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await navigator.clipboard.readText());
      } catch {
        return;
      }
      const list = (Array.isArray(parsed) ? parsed : [parsed]).filter((n) => n && typeof n === "object" && "type" in n) as Record<string, unknown>[];
      if (!list.length) return;
      const entries = fromNested(model, list);
      const target = selection[0];
      const targetNode = target ? model.nodes[target] : undefined;
      const parentId = targetNode?.type === "frame" && targetNode.parentId !== undefined ? target : targetNode?.parentId;
      const file = target ? model.fileOf.get(target) : firstOpenFile(state);
      if (!parentId) {
        for (const entry of entries) {
          const x = (entry.root.node.x ?? 0) + 40;
          entry.root.node = { ...entry.root.node, x, y: entry.root.node.y ?? 0 };
        }
      }
      const changes = parentId ? insertNodes({ model, entries, parentId }) : insertNodes({ model, entries, file: file ?? "designs/main.lamsa.json" });
      await commit("Paste", changes);
      select(entries.map((e) => e.root.id));
      return;
    }
    case "duplicate": {
      const result = duplicate(model, selection);
      await commit("Duplicate", result.changes);
      select(result.created);
      return;
    }
    case "group": {
      const result = groupIntoFrame({ model, ids: selection, sizeOf: (id) => measuredSize(id) });
      if (!result.frameId) {
        if (result.error) state.toast({ tone: "warn", title: "Can't group", message: result.error });
        return;
      }
      await commit("Group", result.changes);
      select([result.frameId]);
      return;
    }
    case "delete": {
      if (!selection.length) return;
      await commit("Delete", deleteSubtrees(model, selection));
      select([]);
      return;
    }
    case "select-parent": {
      const parents = [...new Set(selection.map((id) => model.nodes[id]?.parentId).filter((p): p is string => !!p))];
      select(parents);
      return;
    }
    case "select-all": {
      const first = selection[0];
      const parent = first ? model.nodes[first]?.parentId : undefined;
      select(parent ? (model.children.get(parent) ?? []) : model.roots);
      return;
    }
    case "copy-id":
      if (selection.length) await navigator.clipboard.writeText(selection.join(" "));
      return;
    case "zoom-selection":
      fitTo("selection");
      return;
    case "zoom-fit":
      fitTo("all");
      return;
    case "zoom-100":
      zoomTo(1);
      return;
    case "zoom-in":
      zoomBy(1.25);
      return;
    case "zoom-out":
      zoomBy(0.8);
      return;
    case "undo":
      state.undo();
      return;
    case "redo":
      state.redo();
      return;
    case "toggle-hidden":
    case "toggle-locked": {
      const field = name === "toggle-hidden" ? "hidden" : "locked";
      await toggleFlag({ ids: selection, field });
      return;
    }
    case "go-to-main": {
      const node = model.nodes[selection[0] ?? ""];
      if (node?.type !== "instance") return;
      select([node.componentId]);
      requestAnimationFrame(() => fitTo("selection"));
      return;
    }
    case "detach": {
      const ids = selection.filter((id) => model.nodes[id]?.type === "instance");
      if (!ids.length) return;
      await commit("Detach instance", ids.flatMap((id) => detachInstance(model, id)));
      return;
    }
  }
}

/** Sets `hidden` or `locked` on every layer in `ids`, or clears it when they all have it already. */
export async function toggleFlag({ ids, field }: { ids: string[]; field: "hidden" | "locked" }): Promise<void> {
  const { model, commit, previewProps } = useEditor.getState();
  // A layer hidden by a component prop is shown or hidden by changing the prop, not by hand.
  const targets = ids.filter(
    (id) => model.nodes[id] && !(field === "hidden" && !model.nodes[id]!.hidden && hiddenByDefault(model, id, previewProps[rootOf(model, id)])),
  );
  if (!targets.length) return;
  const turnOn = !targets.every((id) => model.nodes[id]![field]);
  const changes = targets.map((id) => {
    const node = { ...model.nodes[id]! } as DesignNode;
    if (turnOn) node[field] = true;
    else delete node[field];
    return { file: model.fileOf.get(id)!, id, node };
  });
  const label = field === "hidden" ? (turnOn ? "Hide" : "Show") : turnOn ? "Lock" : "Unlock";
  await commit(label, changes);
}

/** Arrow keys: top-level frames move on the canvas, absolutely positioned layers move by left/top. */
async function nudge(dx: number, dy: number): Promise<void> {
  const { model, selection, commit } = useEditor.getState();
  const numeric = (value: unknown) => (typeof value === "number" ? value : typeof value === "string" && /^-?\d+(\.\d+)?(px)?$/.test(value) ? Number.parseFloat(value) : 0);
  const changes = topmost(model, selection).flatMap((id): NodeChange[] => {
    const node = model.nodes[id]!;
    if (isLocked(model, id)) return [];
    if (node.parentId === undefined) return [{ file: model.fileOf.get(id)!, id, node: { ...node, x: (node.x ?? 0) + dx, y: (node.y ?? 0) + dy } as DesignNode }];
    if (node.style?.position !== "absolute") return [];
    const style = { ...node.style, left: numeric(node.style.left) + dx, top: numeric(node.style.top) + dy };
    return [{ file: model.fileOf.get(id)!, id, node: { ...node, style } as DesignNode }];
  });
  if (changes.length) await commit("Nudge", changes);
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const state = useEditor.getState();
    if (state.screen !== "editor") return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const run = (name: CommandName) => {
      e.preventDefault();
      void runCommand(name);
    };
    if (mod) {
      if (key === "h" && e.shiftKey) return run("toggle-hidden");
      if (key === "l" && e.shiftKey) return run("toggle-locked");
      if (key === "z" && e.shiftKey) return run("redo");
      if (key === "z") return run("undo");
      if (key === "y") return run("redo");
      if (key === "c") return run("copy");
      if (key === "x") return run("cut");
      if (key === "v") return run("paste");
      if (key === "d") return run("duplicate");
      if (key === "g") return run("group");
      if (key === "a") return run("select-all");
      if (key === "=" || key === "+") return run("zoom-in");
      if (key === "-") return run("zoom-out");
      if (key === "\\") {
        e.preventDefault();
        state.toggleSidebars();
        return;
      }
      if (key === "[") {
        e.preventDefault();
        state.togglePanel("left");
        return;
      }
      if (key === "]") {
        e.preventDefault();
        state.togglePanel("right");
        return;
      }
      if (e.code === "Quote" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        state.togglePanel("centre");
        return;
      }
      if (e.altKey && e.code === "Digit0") return run("reset-panel-layout");
      const panel = /^Digit[1-9]$/.test(e.code) && !e.altKey && !e.shiftKey ? PANEL_IDS[Number(e.code.slice(5)) - 1] : undefined;
      if (panel) {
        e.preventDefault();
        state.showPanel(panel);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-panel-tab="${panel}"]`)?.focus());
        return;
      }
      if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        void import("../panels/ProjectMenu").then((m) => m.openAnotherProject());
        return;
      }
      if (key === "j") {
        e.preventDefault();
        void import("./agent").then((m) => m.useAgent.getState().openTerminal());
        return;
      }
      return;
    }
    if (e.key === "?") {
      e.preventDefault();
      state.setHelp(!state.help);
      return;
    }
    if (state.help) {
      if (key === "escape") {
        e.preventDefault();
        state.setHelp(false);
      }
      return;
    }
    if (e.shiftKey && e.key === "!") return run("zoom-fit");
    if (e.shiftKey && e.key === "@") return run("zoom-selection");
    if (e.shiftKey && (e.key === ")" || e.code === "Digit0")) return run("zoom-100");
    if (e.shiftKey && e.code === "Digit1") return run("zoom-fit");
    if (e.shiftKey && e.code === "Digit2") return run("zoom-selection");
    if (key.startsWith("arrow") && !e.altKey) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
      const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
      void nudge(dx, dy);
      return;
    }
    if (key === "backspace" || key === "delete") return run("delete");
    if (key === "escape") {
      if (state.picker) return state.setPicker(false);
      if (state.tool !== "select") return state.setTool("select");
      return run("select-parent");
    }
    const tools: Record<string, Parameters<typeof state.setTool>[0]> = { v: "select", h: "hand", f: "frame", t: "text", r: "rect", c: "component", m: "comment" };
    if (tools[key] && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      state.setTool(tools[key]!);
      return;
    }
    if (key === "p" && !e.shiftKey && !e.altKey) return run("toggle-preview");
    if (key === "i" && !e.shiftKey) {
      e.preventDefault();
      void import("../panels/Toolbar").then((m) => m.insertImage());
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
