import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AGENT_CURSOR_FADE_MS, AGENT_CURSOR_LINGER_MS } from "../lib/highlights";
import type { AgentCursor as Cursor } from "../lib/store";

/**
 * The agent's labelled cursor, placed in world space so it pans and zooms with the canvas and only glides when the
 * agent moves to another layer. It lingers where the agent last worked, then fades out.
 */
export function AgentCursor({ cursor, target, zoom }: { cursor: Cursor; target: { id: string; x: number; y: number } | null; zoom: number }) {
  const [phase, setPhase] = useState<"shown" | "leaving" | "gone">("shown");

  useEffect(() => {
    setPhase("shown");
    const leave = setTimeout(() => setPhase("leaving"), AGENT_CURSOR_LINGER_MS);
    const gone = setTimeout(() => setPhase("gone"), AGENT_CURSOR_LINGER_MS + AGENT_CURSOR_FADE_MS);
    return () => {
      clearTimeout(leave);
      clearTimeout(gone);
    };
  }, [cursor.at]);

  if (phase === "gone" || !target) return null;
  return (
    <div
      className="agent-cursor"
      data-kind={cursor.kind}
      data-state={phase}
      data-testid="agent-cursor"
      data-target={target.id}
      style={{ transform: `translate(${target.x}px, ${target.y}px)` }}
      aria-hidden
    >
      <div className="agent-cursor-body" style={{ transform: `scale(${1 / zoom})` }}>
        <MousePointer2 size={16} className="agent-cursor-arrow" />
        <span className="agent-cursor-label">
          {cursor.name}
          {cursor.kind === "read" && <span className="agent-cursor-doing"> · reading</span>}
        </span>
      </div>
    </div>
  );
}
