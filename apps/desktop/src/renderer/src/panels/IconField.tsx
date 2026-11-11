import { Shapes } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/store";
import { AutocompleteInput, type Suggestion } from "./AutocompleteInput";
import { Popover } from "./Popover";

let namesRequest: Promise<string[]> | undefined;
const svgs = new Map<string, string>();

function useIconNames(): string[] {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    namesRequest ??= api().iconNames();
    let live = true;
    void namesRequest.then((list) => live && setNames(list));
    return () => {
      live = false;
    };
  }, []);
  return names;
}

/** SVG markup for the given icons, fetched in one batch and cached for the session. */
function useIconSvgs(names: string[]): Map<string, string> {
  const [, setVersion] = useState(0);
  const key = names.join(",");
  useEffect(() => {
    const missing = names.filter((name) => !svgs.has(name));
    if (!missing.length) return;
    let live = true;
    void api()
      .icons(missing)
      .then((result) => {
        for (const name of missing) svgs.set(name, result[name] ?? "");
        if (live) setVersion((v) => v + 1);
      });
    return () => {
      live = false;
    };
  }, [key]);
  return svgs;
}

/** Matches by substring, names that start with the query first. */
function searchIcons(names: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return names;
  return names
    .filter((name) => name.includes(q))
    .sort((a, b) => Number(!a.startsWith(q)) - Number(!b.startsWith(q)) || a.length - b.length || a.localeCompare(b));
}

function IconPreview({ svg }: { svg: string | undefined }) {
  return <span className="icon-preview" aria-hidden dangerouslySetInnerHTML={{ __html: svg ?? "" }} />;
}

function NamedIcon({ name }: { name: string }) {
  return <IconPreview svg={useIconSvgs([name]).get(name)} />;
}

export function IconField({ value, onCommit }: { value: string; onCommit: (name: string) => void }) {
  const names = useIconNames();
  const control = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const current = useIconSvgs(value ? [value] : []).get(value);
  const suggest = (draft: string): Suggestion[] =>
    draft.trim() && draft !== value
      ? searchIcons(names, draft)
          .slice(0, 30)
          .map((name) => ({ key: name, label: name, apply: name, leading: <NamedIcon name={name} /> }))
      : [];
  return (
    <div className="field">
      <span className="field-label">icon</span>
      <div ref={control} className={`field-control ${open ? "is-open" : ""}`}>
        <IconPreview svg={current} />
        <AutocompleteInput
          className="input mono"
          value={value}
          anchor={() => control.current}
          suggest={suggest}
          onCommit={onCommit}
          onArrowDownWhenClosed={() => setOpen(true)}
          testId="icon-input"
        />
        <button className="icon-btn tiny" onClick={() => setOpen(!open)} aria-label="Browse icons">
          <Shapes size={12} />
        </button>
      </div>
      {open && (
        <Popover anchor={control.current} width={300} onClose={close} testId="icon-picker">
          <IconPicker
            names={names}
            current={value}
            onPick={(name) => {
              setOpen(false);
              if (name !== value) onCommit(name);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

const SHOWN = 150;

function IconPicker({ names, current, onPick }: { names: string[]; current: string; onPick: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const matches = searchIcons(names, query);
  const shown = matches.slice(0, SHOWN);
  const previews = useIconSvgs(shown);
  return (
    <>
      <input
        className="input"
        autoFocus
        placeholder={`Search ${names.length || ""} icons`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) onPick(shown[0]);
        }}
      />
      <div className="popover-list">
        {shown.map((name) => (
          <button key={name} className={`menu-item ${name === current ? "is-active" : ""}`} onClick={() => onPick(name)}>
            <IconPreview svg={previews.get(name)} />
            <span className="mono">{name}</span>
          </button>
        ))}
        {matches.length === 0 && <p className="muted small pad">No icons match “{query}”.</p>}
      </div>
      <div className="muted small popover-foot">
        {matches.length > SHOWN ? `Showing ${SHOWN} of ${matches.length}; keep typing to narrow down` : query.trim() ? `${matches.length} matching icon${matches.length === 1 ? "" : "s"}` : `${matches.length} lucide icons`}
      </div>
    </>
  );
}
