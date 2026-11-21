import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type AgentSessionSummary,
  type AgentStreamParser,
  applyAgentEvents,
  type ChangedFile,
  type ChatItem,
  isSessionId,
} from "../../shared/agent.js";
import { stripLayerLinks } from "../../shared/layer-links.js";

/**
 * Past conversations come from the agent's own session storage (Claude Code keeps one JSONL file per session
 * under `<projects dir>/<mangled cwd>/`), so lamsa keeps no conversation store of its own. The only thing lamsa
 * adds is what it saw change on the canvas per turn, in `.lamsa/agent-sessions.json`.
 */

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const TITLE_LENGTH = 120;
const MAX_SESSIONS = 100;
/** Older messages in a very long conversation are left out of the chat; the full session is still on disk. */
const MAX_ITEMS = 600;

export const defaultProjectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");

/** Claude Code names a project's session folder after its path, with every non-alphanumeric character as `-`. */
export const mangleProjectPath = (root: string) => root.replace(/[^a-zA-Z0-9]/g, "-");

async function sessionFolder({ projectsDir, root }: { projectsDir: string; root: string }): Promise<string | undefined> {
  const exact = join(projectsDir, mangleProjectPath(root));
  if (existsSync(exact)) return exact;
  // Very long paths are cut short and given a hash suffix; match on the kept prefix.
  const prefix = mangleProjectPath(root).slice(0, 200);
  if (prefix.length < 200) return undefined;
  const entries = await readdir(projectsDir).catch(() => [] as string[]);
  const match = entries.find((entry) => entry.startsWith(prefix));
  return match ? join(projectsDir, match) : undefined;
}

export async function sessionFile({ projectsDir, root, sessionId }: { projectsDir: string; root: string; sessionId: string }) {
  if (!isSessionId(sessionId)) return undefined;
  const folder = await sessionFolder({ projectsDir, root });
  const file = folder && join(folder, `${sessionId}.jsonl`);
  return file && existsSync(file) ? file : undefined;
}

type JsonRecord = Record<string, unknown>;

const parseLine = (line: string): JsonRecord | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined;
  } catch {
    return undefined;
  }
};

function promptOf(record: JsonRecord): string {
  if (record.type !== "user" || record.isSidechain === true || record.isMeta === true) return "";
  const message = record.message as JsonRecord | undefined;
  const content = message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((block) => ((block as JsonRecord)?.type === "text" ? String((block as JsonRecord).text ?? "") : "")).join("\n")
        : "";
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("Caveat:") || trimmed.startsWith("[Request interrupted")) return "";
  return trimmed;
}

const shorten = (text: string) => {
  const line = stripLayerLinks(text).replace(/\s+/g, " ").trim();
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1)}…` : line;
};

async function readRange({ file, start, length }: { file: string; start: number; length: number }): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Title from the first thing the user typed, or the name they gave the session. Reads only the file's ends. */
async function readTitle({ file, size }: { file: string; size: number }): Promise<string | undefined> {
  const tail = size > HEAD_BYTES ? await readRange({ file, start: Math.max(0, size - TAIL_BYTES), length: Math.min(size, TAIL_BYTES) }) : "";
  for (const line of tail.split("\n").reverse()) {
    if (!line.includes('"custom-title"')) continue;
    const title = parseLine(line)?.customTitle;
    if (typeof title === "string" && title.trim()) return shorten(title);
  }
  const head = await readRange({ file, start: 0, length: Math.min(size, HEAD_BYTES) });
  let firstPrompt: string | undefined;
  for (const line of head.split("\n")) {
    if (line.includes('"custom-title"')) {
      const title = parseLine(line)?.customTitle;
      if (typeof title === "string" && title.trim()) return shorten(title);
    }
    if (firstPrompt || !line.includes('"type":"user"')) continue;
    const record = parseLine(line);
    const prompt = record && promptOf(record);
    if (prompt) firstPrompt = shorten(prompt);
  }
  return firstPrompt;
}

const titleCache = new Map<string, { mtimeMs: number; size: number; title: string | undefined }>();

export interface SessionMetadata {
  turns: { prompt: number; changes: ChangedFile[] }[];
}

type MetadataFile = { version: 1; sessions: Record<string, SessionMetadata> };

const metadataPath = (root: string) => join(root, ".lamsa", "agent-sessions.json");

export async function readMetadata(root: string): Promise<MetadataFile> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath(root), "utf8")) as MetadataFile;
    if (parsed?.version === 1 && typeof parsed.sessions === "object") return parsed;
  } catch {
    // Missing or unreadable: nothing recorded yet.
  }
  return { version: 1, sessions: {} };
}

let metadataWrites: Promise<unknown> = Promise.resolve();

/** Records the layers a chat turn changed, so history can show them. Writes are serialised and atomic. */
export function recordTurnChanges({ root, sessionId, prompt, changes }: { root: string; sessionId: string; prompt: number; changes: ChangedFile[] }) {
  if (!changes.length || !isSessionId(sessionId)) return metadataWrites;
  metadataWrites = metadataWrites.then(async () => {
    const metadata = await readMetadata(root);
    const session = metadata.sessions[sessionId] ?? { turns: [] };
    session.turns = [...session.turns.filter((turn) => turn.prompt !== prompt), { prompt, changes }];
    metadata.sessions[sessionId] = session;
    await mkdir(join(root, ".lamsa"), { recursive: true });
    const target = metadataPath(root);
    await writeFile(`${target}.tmp`, JSON.stringify(metadata, null, 2));
    await rename(`${target}.tmp`, target);
  }).catch(() => {});
  return metadataWrites;
}

const countLayers = (session: SessionMetadata | undefined) => {
  if (!session) return undefined;
  const ids = new Set<string>();
  for (const turn of session.turns) for (const file of turn.changes) for (const layer of file.layers) ids.add(`${file.file}\u0000${layer.id}`);
  return ids.size;
};

export async function listSessions({ projectsDir, root }: { projectsDir: string; root: string }): Promise<AgentSessionSummary[]> {
  const folder = await sessionFolder({ projectsDir, root });
  if (!folder) return [];
  const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith(".jsonl") && isSessionId(name.slice(0, -6)));
  const stats = await Promise.all(
    names.map(async (name) => {
      const file = join(folder, name);
      const info = await stat(file).catch(() => undefined);
      return info?.isFile() ? { id: name.slice(0, -6), file, mtimeMs: info.mtimeMs, size: info.size } : undefined;
    }),
  );
  const recent = stats
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_SESSIONS * 2);
  const metadata = await readMetadata(root);
  const summaries = await Promise.all(
    recent.map(async (entry) => {
      const cached = titleCache.get(entry.file);
      let title = cached?.title;
      if (!cached || cached.mtimeMs !== entry.mtimeMs || cached.size !== entry.size) {
        title = await readTitle(entry).catch(() => undefined);
        titleCache.set(entry.file, { mtimeMs: entry.mtimeMs, size: entry.size, title });
      }
      if (!title) return undefined;
      const summary: AgentSessionSummary = { id: entry.id, title, updatedAt: entry.mtimeMs };
      const layersChanged = countLayers(metadata.sessions[entry.id]);
      if (layersChanged !== undefined) summary.layersChanged = layersChanged;
      return summary;
    }),
  );
  return summaries.filter((summary): summary is AgentSessionSummary => !!summary).slice(0, MAX_SESSIONS);
}

/** The conversation as chat items, with the change cards lamsa recorded placed after the turns that made them. */
export async function loadTranscript({
  projectsDir,
  root,
  sessionId,
  parser,
}: {
  projectsDir: string;
  root: string;
  sessionId: string;
  parser: AgentStreamParser;
}): Promise<ChatItem[] | null> {
  const file = await sessionFile({ projectsDir, root, sessionId });
  if (!file) return null;
  const turns = new Map((await readMetadata(root)).sessions[sessionId]?.turns.map((turn) => [turn.prompt, turn.changes]) ?? []);
  let items: ChatItem[] = [];
  let prompts = 0;
  const addChanges = (prompt: number) => {
    const changes = turns.get(prompt);
    if (changes?.length) items = [...items, { kind: "changes", id: `changes-history-${prompt}`, files: changes }];
  };
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    // Most lines are bookkeeping; skip them before paying for JSON.parse.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const events = parser.push(line);
    for (const event of events) {
      if (event.type === "user-message") {
        if (prompts > 0) addChanges(prompts - 1);
        prompts++;
      }
    }
    items = applyAgentEvents(items, events);
    if (items.length > MAX_ITEMS * 2) items = items.slice(-MAX_ITEMS);
  }
  if (prompts > 0) addChanges(prompts - 1);
  // A conversation read back from disk has no live steps: anything without a result ended without one.
  items = items.map((item) => (item.kind === "tool" && item.status === "running" ? { ...item, status: "done" } : item));
  return items.slice(-MAX_ITEMS);
}
