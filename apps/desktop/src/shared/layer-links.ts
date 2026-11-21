/**
 * Layers mentioned in chat messages. The composer shows them as pills; the sent text carries each one as a
 * markdown link, `[Pay button](lamsa:QkpksTeC)`, so the agent sees the layer's id and the thread can draw the
 * pill again.
 */

export type LayerLinkSegment = { kind: "text"; text: string } | { kind: "layer"; id: string; name: string };

/** A pasted layer reference resolves to an id only; the composer looks up its name and type. */
export type PasteSegment = { kind: "text"; text: string } | { kind: "layer"; id: string };

const LAYER_LINK = /\[((?:\\.|[^\]\\\n])*)\]\(lamsa:([^\s()]+)\)/g;

/** The link pattern without its capture groups, for tokenizers that match other inline syntax too. */
export const LAYER_LINK_SOURCE = String.raw`\[(?:\\.|[^\]\\\n])*\]\(lamsa:[^\s()]+\)`;

const escapeName = (name: string) => name.replace(/[\\[\]]/g, (char) => `\\${char}`).replace(/\s+/g, " ");
const unescapeName = (name: string) => name.replace(/\\(.)/g, "$1");

function decodeId(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export function layerLink({ id, name }: { id: string; name: string }): string {
  return `[${escapeName(name)}](lamsa:${encodeURIComponent(id)})`;
}

export function splitLayerLinks(text: string): LayerLinkSegment[] {
  const segments: LayerLinkSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LAYER_LINK)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: text.slice(last, start) });
    segments.push({ kind: "layer", id: decodeId(match[2]!), name: unescapeName(match[1]!) });
    last = start + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** The message with each layer link reduced to the layer's name, for titles and other plain-text places. */
export const stripLayerLinks = (text: string) =>
  text.replace(LAYER_LINK, (_link, name: string) => unescapeName(name));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Top-level node ids from the canvas's copy format (nested layer JSON), or null when the text isn't that. */
function copiedLayerIds(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const nodes = Array.isArray(parsed) ? parsed : [parsed];
  if (!nodes.length || !nodes.every((node) => isRecord(node) && typeof node.id === "string" && typeof node.type === "string")) return null;
  return nodes.map((node) => (node as { id: string }).id);
}

function merge(segments: PasteSegment[]): PasteSegment[] {
  const merged: PasteSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.kind === "text" && previous?.kind === "text") previous.text += segment.text;
    else if (segment.kind === "layer" || segment.text) merged.push({ ...segment });
  }
  return merged;
}

function tokens({ text, exists }: { text: string; exists: (id: string) => boolean }): PasteSegment[] {
  return text.split(/([\s,]+)/).map((token, index): PasteSegment => (index % 2 === 0 && token && exists(token) ? { kind: "layer", id: token } : { kind: "text", text: token }));
}

/**
 * What pasting `text` into the composer inserts: copied layers (the canvas's layer JSON), layer links and bare
 * layer ids become layer references; everything else stays text. Only layers in the open model count.
 */
export function parseLayerPaste({ text, exists }: { text: string; exists: (id: string) => boolean }): PasteSegment[] {
  const copied = copiedLayerIds(text)?.filter(exists);
  if (copied?.length) return merge(copied.flatMap((id, index): PasteSegment[] => (index ? [{ kind: "text", text: " " }, { kind: "layer", id }] : [{ kind: "layer", id }])));
  return merge(
    splitLayerLinks(text).flatMap((segment): PasteSegment[] => {
      if (segment.kind === "text") return tokens({ text: segment.text, exists });
      return exists(segment.id) ? [{ kind: "layer", id: segment.id }] : [{ kind: "text", text: segment.name }];
    }),
  );
}
