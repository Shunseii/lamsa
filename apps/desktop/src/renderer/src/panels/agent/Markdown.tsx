import { Fragment, memo, type ReactNode } from "react";
import { LAYER_LINK_SOURCE, splitLayerLinks } from "../../../../shared/layer-links";
import { LayerPill } from "./LayerPill";

/**
 * The little markdown agents write in chat: paragraphs, lists, headings, fenced code, `code`, **bold** and
 * *italic*, and layer links (`[Name](lamsa:id)`), drawn as layer pills. Built from React elements, never HTML
 * strings, so agent output can't inject markup.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return <div className="agent-md">{blocks(text)}</div>;
});

function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = new RegExp(String.raw`(\x60[^\x60\n]+\x60|${LAYER_LINK_SOURCE}|\*\*[^*\n]+\*\*|\*[^*\n]+\*)`, "g");
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    const [link] = token.startsWith("[") ? splitLayerLinks(token) : [];
    if (link?.kind === "layer") parts.push(<LayerPill key={key} id={link.id} name={link.name} />);
    else if (token.startsWith("`")) parts.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) parts.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

function blocks(text: string): ReactNode[] {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${i}`;
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) code.push(lines[i++]!);
      i++;
      out.push(<pre key={key}>{code.join("\n")}</pre>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push(
        <p key={key} className="agent-md-heading">
          {inline(heading[2]!, key)}
        </p>,
      );
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i]!)) items.push(lines[i++]!.replace(LIST_ITEM, ""));
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key}>
          {items.map((item, n) => (
            <li key={`${key}-${n}`}>{inline(item, `${key}-${n}`)}</li>
          ))}
        </List>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !LIST_ITEM.test(lines[i]!) && !lines[i]!.trimStart().startsWith("```") && !/^#{1,6}\s/.test(lines[i]!)) {
      paragraph.push(lines[i++]!);
    }
    out.push(
      <p key={key}>
        {paragraph.map((part, n) => (
          <Fragment key={`${key}-${n}`}>
            {n > 0 && <br />}
            {inline(part, `${key}-${n}`)}
          </Fragment>
        ))}
      </p>,
    );
  }
  return out;
}
