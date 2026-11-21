import { Clapperboard, Component, Files, Layers, MessageCircle, SlidersHorizontal, Sparkles, type LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { PANEL_IDS, type PanelId } from "../lib/layout";
import { shortcut } from "../lib/keys";
import type { EditorState } from "../lib/store";
import { ComponentsPanel, FilesPanel, LayersPanel } from "./LayersPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { AgentPanel } from "./AgentPanel";
import { CommentsPanel } from "./CommentsPanel";
import { PreviewPanel } from "./PreviewPanel";

export interface PanelDefinition {
  id: PanelId;
  title: string;
  icon: LucideIcon;
  Body: ComponentType;
  /** A count shown on the tab's icon (hidden at 0), and how its tooltip and label describe it. */
  badge?: { count: (state: EditorState) => number; describe: (count: number) => string };
}

/** Design files that failed validation, plus errors in the valid ones. */
export const countFileProblems = (state: EditorState) =>
  Object.values(state.files).filter((file) => file.error && file.error !== "deleted").length +
  state.issues.filter((issue) => issue.severity === "error").length;

/** Every editor panel. Each is a tab that can live in any dock; lib/layout.ts holds where. */
export const PANELS: Record<PanelId, PanelDefinition> = {
  agent: { id: "agent", title: "Agent", icon: Sparkles, Body: AgentPanel },
  layers: { id: "layers", title: "Layers", icon: Layers, Body: LayersPanel },
  files: {
    id: "files",
    title: "Files",
    icon: Files,
    Body: FilesPanel,
    badge: { count: countFileProblems, describe: (count) => `${count} problem${count === 1 ? "" : "s"}` },
  },
  components: { id: "components", title: "Components", icon: Component, Body: ComponentsPanel },
  properties: { id: "properties", title: "Properties", icon: SlidersHorizontal, Body: PropertiesPanel },
  preview: { id: "preview", title: "Preview", icon: Clapperboard, Body: PreviewPanel },
  comments: {
    id: "comments",
    title: "Comments",
    icon: MessageCircle,
    Body: CommentsPanel,
    badge: { count: (state) => state.comments.filter((thread) => !thread.resolved).length, describe: (count) => `${count} open` },
  },
};

/** Mod+1 … Mod+7 open the panels in registry order. */
export const panelShortcut = (panel: PanelId) => shortcut(`mod+${PANEL_IDS.indexOf(panel) + 1}`);
