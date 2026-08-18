export interface OcxTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
  /** MCP namespace (e.g. "mcp__context7") for tools flattened out of a Responses "namespace" tool. */
  namespace?: string;
  /** Freeform/custom tool (e.g. apply_patch): the model's call must be relayed as a custom_tool_call. */
  freeform?: boolean;
  /** Client-executed tool discovery (tool_search): the model's call must be relayed as a tool_search_call. */
  toolSearch?: boolean;
  /** Tool definition restored from a prior tool_search output; transports may prioritize it when catalogs are bounded. */
  loadedFromToolSearch?: boolean;
  /** Cursor-only synthetic exact-match edit tool; never inferred from the wire name. */
  cursorStructuredEdit?: true;
  /** Synthetic web_search tool: the model's call is executed by the gpt-5.4-mini sidecar, not relayed to Codex. */
  webSearch?: boolean;
  /** Synthetic image_gen tool: the model's call is executed by the xAI image bridge sidecar, not relayed to Codex. */
  imageGeneration?: boolean;
  /** Synthetic video_gen tool: executed by the xAI video bridge sidecar. */
  videoGeneration?: boolean;
}

/**
 * Wire name a chat model sees for a tool. Namespaced (MCP) tools are flattened to
 * "<namespace>__<name>" so they survive the chat-completions function-tool format;
 * the proxy maps this back to {namespace, name} on the return trip (Codex routes MCP
 * calls by an explicit `namespace` field, not by parsing the name).
 */
export function namespacedToolName(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

export function toolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const wireName = namespacedToolName(tool.namespace, tool.name);
  return tool.namespace ? [wireName, `${tool.namespace}.${tool.name}`] : [wireName];
}

export function toolAllowedByChoice(tool: Pick<OcxTool, "namespace" | "name">, allowedTools: ReadonlySet<string>): boolean {
  return toolChoiceAliases(tool).some(name => allowedTools.has(name));
}

export function resolveToolChoiceWireName(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined, name: string): string {
  const match = tools?.find(tool => toolChoiceAliases(tool).includes(name));
  return match ? namespacedToolName(match.namespace, match.name) : name;
}

/**
 * Whether `modelId` is in a per-provider classification list (e.g. `noVisionModels`). Matches the full
 * id, OR — for Ollama-style ids — the family before the ":size" tag, so a `gpt-oss` entry covers
 * `gpt-oss:120b`/`gpt-oss:20b`. Colon-less ids (e.g. `grok-build-0.1`) still match exactly only.
 */
export function modelInList(list: string[] | undefined, modelId: string): boolean {
  if (!list || list.length === 0) return false;
  if (list.includes(modelId)) return true;
  const colon = modelId.indexOf(":");
  return colon > 0 && list.includes(modelId.slice(0, colon));
}

export type OcxToolChoice =
  | "auto"
  | "none"
  | "required"
  | { name: string }
  | { allowedTools: string[]; mode: "auto" | "required" };

export function isAllowedToolChoice(value: OcxToolChoice | undefined): value is { allowedTools: string[]; mode: "auto" | "required" } {
  return typeof value === "object" && value !== null && "allowedTools" in value;
}

/** Compile the request's tool-choice policy into a reusable advertisement/restoration predicate. */
export function toolChoiceToolPredicate(
  choice: OcxToolChoice | undefined,
): (tool: Pick<OcxTool, "namespace" | "name">) => boolean {
  if (!choice || choice === "auto" || choice === "required") return () => true;
  if (choice === "none") return () => false;
  if (isAllowedToolChoice(choice)) {
    const allowed = new Set(choice.allowedTools);
    return tool => toolAllowedByChoice(tool, allowed);
  }
  return tool => toolChoiceAliases(tool).includes(choice.name);
}
