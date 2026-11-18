import { useCallback, useEffect, useRef, useState } from "react";
import { Popover } from "./Popover";
import { cn } from "../lib/cn";

export interface Suggestion {
  key: string;
  label: string;
  detail?: string;
  swatch?: string;
  /** Shown before the label, e.g. an icon preview. */
  leading?: React.ReactNode;
  /** The full input value after accepting this suggestion. */
  apply: string;
  /** Accepting keeps editing (e.g. a property name before its value) instead of committing. */
  keepEditing?: boolean;
}

/**
 * A text input that suggests completions while the user types.
 * ↑/↓ move, Enter/Tab accept, Escape closes the list (or reverts when it's closed).
 */
export function AutocompleteInput({
  value,
  onCommit,
  suggest,
  anchor,
  className,
  placeholder,
  onArrowDownWhenClosed,
  commitOnBlur = true,
  clearOnCommit = false,
  openOnFocus = false,
  testId,
}: {
  value: string;
  onCommit: (value: string) => void;
  suggest: (draft: string) => Suggestion[];
  anchor: () => HTMLElement | null;
  className?: string;
  placeholder?: string;
  onArrowDownWhenClosed?: () => void;
  commitOnBlur?: boolean;
  clearOnCommit?: boolean;
  /** Shows the suggestions as soon as the input is focused, for a short fixed list. */
  openOnFocus?: boolean;
  testId?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const focused = useRef(false);
  const committed = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);

  const suggestions = open ? suggest(draft).slice(0, 50) : [];
  const showing = open && suggestions.length > 0;

  useEffect(() => {
    list.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [active, showing]);

  const commit = (next: string) => {
    committed.current = true;
    setOpen(false);
    if (next !== value) onCommit(next);
    if (clearOnCommit) setDraft("");
  };

  const accept = (suggestion: Suggestion) => {
    setDraft(suggestion.apply);
    setActive(0);
    if (suggestion.keepEditing) {
      setOpen(true);
      return;
    }
    commit(suggestion.apply);
    if (!clearOnCommit) input.current?.blur();
  };

  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <input
        ref={input}
        className={className}
        value={draft}
        placeholder={placeholder}
        data-testid={testId}
        spellCheck={false}
        onFocus={() => {
          focused.current = true;
          committed.current = false;
          if (openOnFocus) {
            setActive(0);
            setOpen(true);
          }
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          committed.current = false;
          setActive(0);
          setOpen(true);
        }}
        onBlur={(e) => {
          focused.current = false;
          setOpen(false);
          const typed = e.currentTarget.value;
          if (commitOnBlur && !committed.current && typed !== value) commit(typed);
        }}
        onKeyDown={(e) => {
          if (showing && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
            return;
          }
          if (showing && (e.key === "Enter" || e.key === "Tab")) {
            e.preventDefault();
            accept(suggestions[active] ?? suggestions[0]!);
            return;
          }
          if (e.key === "ArrowDown" && onArrowDownWhenClosed) {
            e.preventDefault();
            onArrowDownWhenClosed();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commit(e.currentTarget.value);
            if (!clearOnCommit) input.current?.blur();
          }
          if (e.key === "Escape") {
            committed.current = true;
            setDraft(value);
            focused.current = false;
            input.current?.blur();
          }
        }}
      />
      {showing && (
        <Popover anchor={anchor()} width={Math.max(220, anchor()?.offsetWidth ?? 0)} onClose={close} testId="autocomplete">
          <div ref={list} className="popover-list" role="listbox">
            {suggestions.map((suggestion, i) => (
              <button
                key={suggestion.key}
                role="option"
                aria-selected={i === active}
                className={cn("menu-item", { "is-active": i === active })}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => accept(suggestion)}
              >
                {suggestion.swatch && <span className="swatch" style={{ background: suggestion.swatch }} />}
                {suggestion.leading}
                <span className="mono">{suggestion.label}</span>
                {suggestion.detail && <span className="muted small grow-right">{suggestion.detail}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
