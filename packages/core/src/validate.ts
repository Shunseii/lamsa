import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  designFileSchema,
  FORMAT_VERSION,
  tokenRefs,
  type DesignNode,
  type FrameNode,
  type NodePatch,
  type Style,
  type TokenSet,
} from "@lamsa/schema";
import { lucideIconNames } from "./icons.js";
import type { Project } from "./project.js";
import { didYouMean } from "./suggest.js";
import { buildChildIndex, descendants, type NodeMap } from "./tree.js";

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  file?: string;
  nodeId?: string;
  message: string;
  fix?: string;
}

const KEBAB_PROPERTY = /^(--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/;

function kebab(property: string): string {
  return property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function normaliseColor(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

interface Context {
  project: Project;
  tokens: TokenSet;
  nodes: NodeMap;
  fileOf: Map<string, string>;
  issues: Issue[];
}

export function validateProject({
  project,
  tokens,
}: {
  project: Project;
  tokens: TokenSet;
}): Issue[] {
  const issues: Issue[] = [];
  const nodes: NodeMap = {};
  const fileOf = new Map<string, string>();

  for (const file of project.files.values()) {
    if (file.parseError) {
      issues.push({
        severity: "error",
        code: "invalid-json",
        file: file.path,
        message: `not valid JSON: ${file.parseError}`,
        fix: "fix the syntax; the editor keeps showing the last valid version meanwhile",
      });
      continue;
    }
    const version = (file.raw as { version?: unknown } | undefined)?.version;
    if (typeof version === "number" && version > FORMAT_VERSION) {
      issues.push({
        severity: "error",
        code: "newer-version",
        file: file.path,
        message: `file format version ${version} is newer than this lamsa (${FORMAT_VERSION})`,
        fix: "upgrade lamsa",
      });
      continue;
    }
    const parsed = designFileSchema.safeParse(file.raw);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        const [first, second, ...rest] = problem.path.map(String);
        const nodeId = first === "nodes" ? second : undefined;
        const where = nodeId ? rest.join(".") : problem.path.join(".");
        issues.push({
          severity: "error",
          code: "schema",
          file: file.path,
          nodeId,
          message: `${where ? `${where}: ` : ""}${problem.message}`,
          fix: hasNestedChildren(file.raw) ? "run `lamsa fmt` to flatten nested children" : undefined,
        });
      }
      continue;
    }
    for (const [id, node] of Object.entries(parsed.data.nodes)) {
      const existing = fileOf.get(id);
      if (existing) {
        issues.push({
          severity: "error",
          code: "duplicate-id",
          file: file.path,
          nodeId: id,
          message: `node ID ${id} is also used in ${existing}`,
          fix: "IDs are global across the repo; give one of them a new ID",
        });
        continue;
      }
      nodes[id] = node;
      fileOf.set(id, file.path);
    }
  }

  const context: Context = { project, tokens, nodes, fileOf, issues };
  checkStructure(context);
  checkComponents(context);
  checkContent(context);
  return issues;
}

function hasNestedChildren(raw: unknown): boolean {
  const nodes = (raw as { nodes?: unknown } | undefined)?.nodes;
  if (Array.isArray(nodes)) return true;
  if (!nodes || typeof nodes !== "object") return false;
  return Object.values(nodes as Record<string, unknown>).some(
    (node) => !!node && typeof node === "object" && "children" in node,
  );
}

function push(context: Context, issue: Omit<Issue, "file"> & { nodeId: string }) {
  context.issues.push({ file: context.fileOf.get(issue.nodeId), ...issue });
}

function checkStructure(context: Context) {
  const { nodes, fileOf } = context;
  for (const [id, node] of Object.entries(nodes)) {
    if (node.parentId === undefined) continue;
    const parent = nodes[node.parentId];
    if (!parent) {
      push(context, {
        severity: "error",
        code: "missing-parent",
        nodeId: id,
        message: `parentId ${node.parentId} does not exist`,
        fix: "set parentId to an existing frame, or run `lamsa fmt --fix` to remove orphans",
      });
      continue;
    }
    if (fileOf.get(node.parentId) !== fileOf.get(id)) {
      push(context, {
        severity: "error",
        code: "cross-file-parent",
        nodeId: id,
        message: `parent ${node.parentId} is in ${fileOf.get(node.parentId)}; children must live in their parent's file`,
        fix: `use \`lamsa move ${id} --parent ${node.parentId}\` to move it with its subtree`,
      });
    }
    if (parent.type !== "frame") {
      push(context, {
        severity: "error",
        code: "invalid-parent",
        nodeId: id,
        message: `parent ${node.parentId} is a ${parent.type}; only frames have children`,
        fix: "wrap content in a frame, or override instance content via `overrides`",
      });
    }
    if (node.index === undefined) {
      push(context, {
        severity: "warning",
        code: "missing-index",
        nodeId: id,
        message: "child has no order index",
        fix: "run `lamsa fmt`",
      });
    }
    if (isCyclic(nodes, id)) {
      push(context, {
        severity: "error",
        code: "cycle",
        nodeId: id,
        message: "parentId chain forms a cycle",
        fix: "point parentId at a frame that is not inside this node",
      });
    }
  }
}

function isCyclic(nodes: NodeMap, id: string): boolean {
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current !== undefined) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = nodes[current]?.parentId;
  }
  return false;
}

function checkComponents(context: Context) {
  const { nodes } = context;
  const index = buildChildIndex(nodes);
  const insideOf = (componentId: string) => new Set(descendants(index, componentId));

  for (const [id, node] of Object.entries(nodes)) {
    if (node.type === "frame" && node.component) {
      const inner = insideOf(id);
      for (const [propName, prop] of Object.entries(node.component.props ?? {})) {
        if (prop.type === "enum") {
          if (!prop.options.includes(prop.default)) {
            push(context, {
              severity: "error",
              code: "prop-default",
              nodeId: id,
              message: `prop ${propName}: default "${prop.default}" is not one of ${prop.options.join(", ")}`,
            });
          }
          for (const [option, patches] of Object.entries(prop.overrides ?? {})) {
            if (!prop.options.includes(option)) {
              push(context, {
                severity: "error",
                code: "prop-option",
                nodeId: id,
                message: `prop ${propName}: overrides for unknown option "${option}"`,
                fix: didYouMean(option, prop.options) || `add "${option}" to options`,
              });
            }
            checkPatchTargets(context, { ownerId: id, componentId: id, inner, patches, label: `prop ${propName}=${option}` });
          }
        } else if (prop.type === "boolean") {
          for (const [value, patches] of Object.entries(prop.overrides ?? {})) {
            checkPatchTargets(context, { ownerId: id, componentId: id, inner, patches: patches ?? {}, label: `prop ${propName}=${value}` });
          }
        } else if (!inner.has(prop.target) || nodes[prop.target]?.type !== "text") {
          push(context, {
            severity: "error",
            code: "prop-target",
            nodeId: id,
            message: `text prop ${propName} targets ${prop.target}, which is not a text node inside this component`,
          });
        }
      }
    }

    if (node.type !== "instance") continue;
    const component = nodes[node.componentId];
    if (!component || component.type !== "frame" || !component.component) {
      const componentIds = Object.entries(nodes)
        .filter(([, n]) => n.type === "frame" && n.component)
        .map(([cid]) => cid);
      push(context, {
        severity: "error",
        code: "missing-component",
        nodeId: id,
        message: component
          ? `componentId ${node.componentId} is a ${component.type} without a "component" definition`
          : `componentId ${node.componentId} does not exist`,
        fix: didYouMean(node.componentId, componentIds) || "run `lamsa components` to list components",
      });
      continue;
    }
    checkInstanceProps(context, { id, node, component });
    checkPatchTargets(context, {
      ownerId: id,
      componentId: node.componentId,
      inner: insideOf(node.componentId),
      patches: node.overrides ?? {},
      label: "overrides",
    });
    if (instanceCycle(nodes, index, node.componentId, new Set([node.componentId]))) {
      push(context, {
        severity: "error",
        code: "component-cycle",
        nodeId: id,
        message: `component ${node.componentId} contains an instance of itself`,
      });
    }
  }
}

function checkInstanceProps(
  context: Context,
  {
    id,
    node,
    component,
  }: { id: string; node: Extract<DesignNode, { type: "instance" }>; component: FrameNode },
) {
  const defs = component.component?.props ?? {};
  for (const [name, value] of Object.entries(node.props ?? {})) {
    const def = defs[name];
    if (!def) {
      push(context, {
        severity: "error",
        code: "unknown-prop",
        nodeId: id,
        message: `component ${node.componentId} has no prop "${name}"`,
        fix: didYouMean(name, Object.keys(defs)) || `props: ${Object.keys(defs).join(", ") || "(none)"}`,
      });
      continue;
    }
    const ok =
      def.type === "enum"
        ? typeof value === "string" && def.options.includes(value)
        : def.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "string";
    if (!ok) {
      push(context, {
        severity: "error",
        code: "prop-value",
        nodeId: id,
        message: `prop ${name}: ${JSON.stringify(value)} is not valid`,
        fix:
          def.type === "enum"
            ? `use one of ${def.options.join(", ")}`
            : def.type === "boolean"
              ? "use true or false"
              : "use a string",
      });
    }
  }
}

function checkPatchTargets(
  context: Context,
  {
    ownerId,
    componentId,
    inner,
    patches,
    label,
  }: {
    ownerId: string;
    componentId: string;
    inner: Set<string>;
    patches: Record<string, NodePatch>;
    label: string;
  },
) {
  for (const [target, patch] of Object.entries(patches)) {
    if (!inner.has(target) && target !== componentId) {
      push(context, {
        severity: "error",
        code: "override-target",
        nodeId: ownerId,
        message: `${label}: ${target} is not a node inside component ${componentId}`,
        fix: didYouMean(target, inner) || `run \`lamsa tree ${componentId}\` to see its node IDs`,
      });
    }
    if (patch.style) checkStyle(context, { nodeId: ownerId, style: patch.style, label: `${label} ${target}` });
  }
}

function instanceCycle(
  nodes: NodeMap,
  index: ReturnType<typeof buildChildIndex>,
  componentId: string,
  visiting: Set<string>,
): boolean {
  for (const inner of descendants(index, componentId)) {
    const node = nodes[inner];
    if (node?.type !== "instance") continue;
    if (visiting.has(node.componentId)) return true;
    visiting.add(node.componentId);
    if (instanceCycle(nodes, index, node.componentId, visiting)) return true;
    visiting.delete(node.componentId);
  }
  return false;
}

function checkContent(context: Context) {
  const { nodes, project } = context;
  const icons = lucideIconNames();
  for (const [id, node] of Object.entries(nodes)) {
    if (node.style) checkStyle(context, { nodeId: id, style: node.style, label: "style" });
    if (node.type === "icon" && !icons.has(node.icon)) {
      push(context, {
        severity: "error",
        code: "unknown-icon",
        nodeId: id,
        message: `lucide has no icon "${node.icon}"`,
        fix: didYouMean(node.icon, icons) || "see https://lucide.dev/icons",
      });
    }
    if (node.type === "image") {
      if (/^https?:\/\//.test(node.src)) {
        push(context, {
          severity: "warning",
          code: "remote-asset",
          nodeId: id,
          message: `image src is a remote URL (${node.src}); renders depend on the network`,
          fix: `download it into ${project.config.assetsDir} and use the repo-relative path`,
        });
      } else if (!node.src.startsWith("data:") && !existsSync(join(project.root, node.src))) {
        push(context, {
          severity: "error",
          code: "missing-asset",
          nodeId: id,
          message: `image src ${node.src} does not exist`,
          fix: "use a path relative to the repo root",
        });
      }
    }
  }
}

function checkStyle(
  context: Context,
  { nodeId, style, label }: { nodeId: string; style: Style; label: string },
) {
  const { tokens } = context;
  const colorValues = new Map<string, string>();
  for (const token of Object.values(tokens.tokens)) {
    if (token.kind === "color") colorValues.set(normaliseColor(token.values.light), token.path);
  }
  for (const [property, value] of Object.entries(style)) {
    if (!KEBAB_PROPERTY.test(property)) {
      push(context, {
        severity: "warning",
        code: "property-name",
        nodeId,
        message: `${label}: "${property}" is not a CSS property name`,
        fix: `use kebab-case: "${kebab(property)}"`,
      });
    }
    for (const ref of tokenRefs(value)) {
      if (!tokens.tokens[ref]) {
        push(context, {
          severity: "error",
          code: "unknown-token",
          nodeId,
          message: `${label}: ${property} references unknown token {${ref}}`,
          fix: didYouMean(ref, Object.keys(tokens.tokens)) || "run `lamsa tokens` to list tokens",
        });
      }
    }
    if (typeof value === "string" && tokenRefs(value).length === 0) {
      const match = colorValues.get(normaliseColor(value));
      if (match) {
        push(context, {
          severity: "warning",
          code: "raw-token-value",
          nodeId,
          message: `${label}: ${property} uses raw value ${value}, which matches token {${match}}`,
          fix: `use "{${match}}"`,
        });
      }
    }
  }
}

export function summarize(issues: Issue[]): { errors: number; warnings: number } {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
  };
}
