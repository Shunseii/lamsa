import { ArrowUp, Square } from "lucide-react";
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useMemo, useRef, useState } from "react";
import type { ContextLayer } from "../../../../shared/agent";
import { layerLink, parseLayerPaste } from "../../../../shared/layer-links";
import { useAgent } from "../../lib/agent";
import { cn } from "../../lib/cn";
import { nodeTitle } from "../../lib/model";
import { useEditor } from "../../lib/store";
import { LayerTypeIcon } from "./LayerPill";

const FIELD = "\u0001";
const RECORD = "\u0002";
const ICON_TYPES = ["frame", "text", "image", "icon", "instance", "component"];

/**
 * The selected layers as one string, so the composer re-renders only when the selection (or a selected
 * layer's name) changes, not on every edit elsewhere in the model. They go along with each message as context.
 */
function useSelectedLayers(): ContextLayer[] {
  const key = useEditor((s) =>
    s.selection
      .map((id) => {
        const node = s.model.nodes[id];
        return [id, nodeTitle(id, node), node?.type ?? "frame", s.model.fileOf.get(id) ?? ""].join(FIELD);
      })
      .join(RECORD),
  );
  return useMemo(
    () =>
      key
        ? key.split(RECORD).map((record) => {
            const [id, name, type, file] = record.split(FIELD) as [string, string, string, string];
            return { id, name, type, ...(file ? { file } : {}) };
          })
        : [],
    [key],
  );
}

function layerInModel(id: string): ContextLayer | undefined {
  const { model } = useEditor.getState();
  const node = model.nodes[id];
  if (!node) return undefined;
  const file = model.fileOf.get(id);
  return { id, name: nodeTitle(id, node), type: node.type, ...(file ? { file } : {}) };
}

const isPill = (node: Node | null | undefined): node is HTMLElement => node instanceof HTMLElement && node.dataset.layerId !== undefined;

/** The message as sent: text, with each pill as a `[Name](lamsa:id)` link. */
function serialize(root: Node): string {
  let out = "";
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? "";
    else if (isPill(node)) out += layerLink({ id: node.dataset.layerId ?? "", name: node.dataset.layerName ?? "" });
    else if (node.nodeName === "BR") out += "\n";
    else if (node instanceof HTMLElement) {
      // The browser may wrap lines in blocks; each starts a new line.
      if ((node.nodeName === "DIV" || node.nodeName === "P") && out && !out.endsWith("\n")) out += "\n";
      out += serialize(node);
    }
  }
  return out;
}

function pillElement({ layer, icons }: { layer: ContextLayer; icons: HTMLElement | null }): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "agent-pill";
  pill.contentEditable = "false";
  pill.dataset.layerId = layer.id;
  pill.dataset.layerName = layer.name;
  pill.dataset.testid = "agent-input-pill";
  pill.title = layer.file ? `${layer.id} · ${layer.file}` : layer.id;
  const type = ICON_TYPES.includes(layer.type) ? layer.type : "frame";
  const icon = icons?.querySelector(`[data-icon="${type}"] svg`)?.cloneNode(true);
  if (icon) pill.append(icon);
  const name = document.createElement("span");
  name.className = "truncate";
  name.textContent = layer.name;
  pill.append(name);
  return pill;
}

/** The caret's range inside `root`, or one at its end. */
function caretRange(root: HTMLElement): Range {
  const selection = window.getSelection();
  const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
  if (current && root.contains(current.commonAncestorContainer)) return current;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

function placeCaret(range: Range) {
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The pill right before (or after) a collapsed caret, so Backspace and Delete remove it whole. */
function pillNextToCaret({ root, forward }: { root: HTMLElement; forward: boolean }): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const { startContainer, startOffset } = selection.getRangeAt(0);
  if (!root.contains(startContainer)) return null;
  let sibling: Node | null;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const length = startContainer.textContent?.length ?? 0;
    if (forward ? startOffset < length : startOffset > 0) return null;
    sibling = forward ? startContainer.nextSibling : startContainer.previousSibling;
  } else {
    sibling = startContainer.childNodes[forward ? startOffset : startOffset - 1] ?? null;
  }
  while (sibling?.nodeType === Node.TEXT_NODE && !sibling.textContent) sibling = forward ? sibling.nextSibling : sibling.previousSibling;
  return isPill(sibling) ? sibling : null;
}

const FORMATTING_KEYS = new Set(["b", "i", "u"]);

export function Composer({ command, disabled }: { command: string; disabled?: boolean }) {
  const [text, setText] = useState("");
  const selected = useSelectedLayers();
  const working = useAgent((s) => s.turnId !== null);
  const send = useAgent((s) => s.send);
  const stop = useAgent((s) => s.stop);
  const input = useRef<HTMLDivElement>(null);
  const icons = useRef<HTMLDivElement>(null);

  const sync = () => setText(input.current ? serialize(input.current) : "");
  const empty = !text.replace(/\n/g, "");

  const submit = () => {
    const root = input.current;
    if (!root || disabled) return;
    const message = serialize(root);
    if (!message.trim()) return;
    void send(message, selected);
    root.replaceChildren();
    setText("");
  };

  /** Inserts plain text at `range`, turning copied layers and layer ids into pills. */
  const insert = ({ value, range }: { value: string; range: Range }) => {
    const root = input.current;
    if (!root || !value) return;
    const segments = parseLayerPaste({ text: value, exists: (id) => layerInModel(id) !== undefined });
    placeCaret(range);
    if (segments.every((segment) => segment.kind === "text")) {
      // Lets the browser keep its undo history for ordinary text.
      document.execCommand("insertText", false, value);
      sync();
      return;
    }
    const nodes = segments.map((segment) =>
      segment.kind === "text" ? document.createTextNode(segment.text) : pillElement({ layer: layerInModel(segment.id)!, icons: icons.current }),
    );
    // A space after a trailing pill gives the caret somewhere to go.
    if (segments[segments.length - 1]?.kind === "layer") nodes.push(document.createTextNode(" "));
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    fragment.append(...nodes);
    range.insertNode(fragment);
    range.setStartAfter(nodes[nodes.length - 1]!);
    range.collapse(true);
    placeCaret(range);
    sync();
  };

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!input.current || disabled) return;
    insert({ value: e.clipboardData.getData("text/plain"), range: caretRange(input.current) });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!input.current || disabled) return;
    const range = document.caretRangeFromPoint(e.clientX, e.clientY) ?? caretRange(input.current);
    input.current.focus();
    insert({ value: e.dataTransfer.getData("text/plain"), range });
  };

  /** Copying from the message keeps its pills as links, so pasting them back brings the pills back. */
  const onCopy = (e: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    e.preventDefault();
    const range = selection.getRangeAt(0);
    e.clipboardData.setData("text/plain", serialize(range.cloneContents()));
    if (cut) {
      range.deleteContents();
      sync();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const root = input.current;
    if (!root || e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        document.execCommand("insertLineBreak");
        sync();
      } else submit();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && FORMATTING_KEYS.has(e.key.toLowerCase())) {
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      const pill = pillNextToCaret({ root, forward: e.key === "Delete" });
      if (!pill) return;
      e.preventDefault();
      pill.remove();
      sync();
    }
  };

  const focusEnd = () => {
    const root = input.current;
    if (!root || disabled) return;
    root.focus();
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    placeCaret(range);
  };

  const placeholder = working ? "Queue a follow-up…" : selected.length ? "Ask about the selection…" : "Ask the agent…";

  return (
    <div className="agent-composer">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: clicking the box's padding focuses its input, which has the keyboard handling. */}
      <div
        className="agent-composer-box"
        onClick={(e) => {
          if (!input.current?.contains(e.target as Node)) focusEnd();
        }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a textarea can't hold layer pills. */}
        <div
          ref={input}
          className={cn("agent-input", { "is-empty": empty, "is-disabled": disabled })}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          tabIndex={disabled ? -1 : 0}
          aria-multiline
          aria-label="Message the agent"
          aria-disabled={disabled}
          aria-placeholder={placeholder}
          data-placeholder={placeholder}
          spellCheck
          onInput={sync}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragStart={(e) => e.preventDefault()}
          onCopy={(e) => onCopy(e, false)}
          onCut={(e) => onCopy(e, true)}
          data-testid="agent-input"
        />
        <div ref={icons} hidden>
          {ICON_TYPES.map((type) => (
            <span key={type} data-icon={type}>
              <LayerTypeIcon type={type} />
            </span>
          ))}
        </div>
        <div className="agent-composer-foot">
          <span className="mono muted small">{command}</span>
          <span className="grow" />
          {working && !text.trim() ? (
            <button className="agent-send is-stop" onClick={stop} aria-label="Stop" title="Stop" data-testid="agent-stop">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              className="agent-send"
              onClick={submit}
              disabled={!text.trim() || disabled}
              aria-label={working ? "Queue message" : "Send"}
              title={working ? "Queue message" : "Send"}
              data-testid="agent-send"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
