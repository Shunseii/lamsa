import { z } from "zod";

export const FORMAT_VERSION = 1;
export const SCHEMA_URL = "https://lamsa.dev/schema/v1.json";

export const nodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "node IDs use letters, digits, '_' and '-'");

export const styleValueSchema = z.union([z.string(), z.number()]);

/**
 * CSS declarations keyed by kebab-case property name. Unitless numbers mean px
 * for length properties. Values may contain token references like `{color.primary}`.
 */
export const styleSchema = z.record(z.string(), styleValueSchema);

/**
 * Plain CSS for one node: declarations plus nested rules where `&` is the node,
 * e.g. `transition: scale 150ms; &:hover { scale: 1.02 }`. Token references like
 * `{color.primary}` work here too.
 */
export const nodeCssSchema = z.string();

export const nodePatchSchema = z
  .object({
    style: styleSchema.optional(),
    css: nodeCssSchema.optional(),
    content: z.string().optional(),
    src: z.string().optional(),
    icon: z.string().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

const patchMapSchema = z.record(nodeIdSchema, nodePatchSchema);

export const propDefSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("enum"),
      options: z.array(z.string()).min(1),
      default: z.string(),
      overrides: z.record(z.string(), patchMapSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("boolean"),
      default: z.boolean(),
      overrides: z
        .object({ true: patchMapSchema.optional(), false: patchMapSchema.optional() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      default: z.string(),
      target: nodeIdSchema,
    })
    .strict(),
]);

export const componentDefSchema = z
  .object({
    internal: z.boolean().optional(),
    description: z.string().optional(),
    props: z.record(z.string(), propDefSchema).optional(),
  })
  .strict();

export const tokenModeSchema = z.enum(["light", "dark"]);

const baseNodeShape = {
  name: z.string().optional(),
  parentId: nodeIdSchema.optional(),
  index: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  hidden: z.boolean().optional(),
  /** Locked in the editor: not selectable or movable on the canvas. Agents leave locked nodes alone unless asked. */
  locked: z.boolean().optional(),
  style: styleSchema.optional(),
  css: nodeCssSchema.optional(),
};

export const frameNodeSchema = z
  .object({
    ...baseNodeShape,
    type: z.literal("frame"),
    mode: tokenModeSchema.optional(),
    component: componentDefSchema.optional(),
  })
  .strict();

export const textNodeSchema = z
  .object({ ...baseNodeShape, type: z.literal("text"), content: z.string() })
  .strict();

export const imageNodeSchema = z
  .object({
    ...baseNodeShape,
    type: z.literal("image"),
    src: z.string(),
    alt: z.string().optional(),
  })
  .strict();

export const iconNodeSchema = z
  .object({
    ...baseNodeShape,
    type: z.literal("icon"),
    set: z.literal("lucide"),
    icon: z.string(),
  })
  .strict();

export const instanceNodeSchema = z
  .object({
    ...baseNodeShape,
    type: z.literal("instance"),
    componentId: nodeIdSchema,
    props: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(),
    overrides: patchMapSchema.optional(),
  })
  .strict();

export const nodeSchema = z.discriminatedUnion("type", [
  frameNodeSchema,
  textNodeSchema,
  imageNodeSchema,
  iconNodeSchema,
  instanceNodeSchema,
]);

export const designFileSchema = z
  .object({
    $schema: z.string().optional(),
    version: z.number().int().positive(),
    /** File-level CSS shared by every node in the file: `@keyframes` (and other at-rules) only. */
    css: z.string().optional(),
    nodes: z.record(nodeIdSchema, nodeSchema),
  })
  .strict();

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    designs: z.array(z.string()).default(["designs/**/*.lamsa.json"]),
    tokens: z
      .object({
        adapter: z.enum(["shadcn-tailwind4", "none"]),
        path: z.string().optional(),
      })
      .strict()
      .default({ adapter: "none" }),
    fonts: z
      .record(
        z.string(),
        z.union([
          z.object({ google: z.string() }).strict(),
          z.object({ files: z.array(z.string()).min(1) }).strict(),
        ]),
      )
      .default({}),
    assetsDir: z.string().default("designs/assets"),
    /** Where comment threads live, one JSON file per thread. Committed with the designs. */
    commentsDir: z.string().default("designs/comments"),
    agent: z
      .object({ command: z.string().default("claude"), args: z.array(z.string()).default([]) })
      .strict()
      .default({ command: "claude", args: [] }),
  })
  .strict();

export const COMMENT_FORMAT_VERSION = 1;

export const commentMessageSchema = z
  .object({
    author: z.string().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    text: z.string().min(1),
  })
  .strict();

/**
 * One comment thread, stored as `<commentsDir>/<id>.json`. It pins to a node by ID; `offset` is a point inside the
 * node's box in its own unscaled pixels (the top-right corner when missing).
 */
export const commentThreadSchema = z
  .object({
    version: z.number().int().positive(),
    nodeId: nodeIdSchema,
    offset: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    ...commentMessageSchema.shape,
    replies: z.array(commentMessageSchema).default([]),
    resolved: z.object({ author: z.string().min(1), at: z.iso.datetime({ offset: true }) }).strict().optional(),
  })
  .strict();

export type CommentMessage = z.infer<typeof commentMessageSchema>;
export type CommentThreadFile = z.infer<typeof commentThreadSchema>;

/** A thread as loaded: its file's contents plus its ID (the file name) and repo-relative path. */
export interface CommentThread extends CommentThreadFile {
  id: string;
  path: string;
}

export type NodeId = z.infer<typeof nodeIdSchema>;
export type Style = z.infer<typeof styleSchema>;
export type NodePatch = z.infer<typeof nodePatchSchema>;
export type PropDef = z.infer<typeof propDefSchema>;
export type ComponentDef = z.infer<typeof componentDefSchema>;
export type TokenMode = z.infer<typeof tokenModeSchema>;
export type FrameNode = z.infer<typeof frameNodeSchema>;
export type TextNode = z.infer<typeof textNodeSchema>;
export type ImageNode = z.infer<typeof imageNodeSchema>;
export type IconNode = z.infer<typeof iconNodeSchema>;
export type InstanceNode = z.infer<typeof instanceNodeSchema>;
export type DesignNode = z.infer<typeof nodeSchema>;
export type NodeType = DesignNode["type"];
export type DesignFile = z.infer<typeof designFileSchema>;
export type LamsaConfig = z.infer<typeof configSchema>;
export type LamsaConfigInput = z.input<typeof configSchema>;

export type TokenKind = "color" | "radius" | "font" | "spacing" | "shadow" | "text" | "other";

export interface Token {
  /** Reference path used in designs, e.g. `color.primary` for `{color.primary}`. */
  path: string;
  /** CSS expression substituted where the token is used, e.g. `var(--primary)`. */
  css: string;
  kind: TokenKind;
  /** Resolved values for display and lint matching. */
  values: { light: string; dark?: string };
  /** From the framework's built-in theme (e.g. Tailwind's palette) rather than the project's own CSS. */
  builtin?: boolean;
}

export interface TokenSet {
  adapter: string;
  source?: string;
  tokens: Record<string, Token>;
  /** Variable definitions (a `:root` block and a `.dark` block), then the app's `@keyframes`. */
  css: string;
  /** Names of the `@keyframes` in `css`, usable in `animation` without defining them in a design file. */
  keyframes?: string[];
}

export const emptyTokenSet: TokenSet = { adapter: "none", tokens: {}, css: "" };

const TOKEN_REF = /\{([A-Za-z0-9_][A-Za-z0-9_.\-]*)\}/g;

export function tokenRefs(value: string | number): string[] {
  if (typeof value !== "string") return [];
  return [...value.matchAll(TOKEN_REF)].map((match) => match[1]!);
}

export function resolveTokenRefs(
  value: string,
  tokens: Record<string, Token>,
): { css: string; missing: string[] } {
  const missing: string[] = [];
  const css = value.replace(TOKEN_REF, (whole, path: string) => {
    const token = tokens[path];
    if (!token) {
      missing.push(path);
      return whole;
    }
    return token.css;
  });
  return { css, missing };
}

export function designFileJsonSchema(): Record<string, unknown> {
  return {
    ...(z.toJSONSchema(designFileSchema) as Record<string, unknown>),
    $id: SCHEMA_URL,
    title: "lamsa design file",
  };
}
