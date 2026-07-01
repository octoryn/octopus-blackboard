import type { FileChangeKind } from "./types.js";

/**
 * Transcript ingestion adapters. An adapter turns a CLI's session transcript
 * into normalized ingest events the board can record under the active session —
 * so file edits, decisions, and notes flow onto the board with minimal
 * integration, without each CLI having to call the API directly.
 *
 * Two reliable paths ship:
 *   - `generic`: our own normalized schema (JSON `{events:[...]}` or JSONL of
 *     events). This is the stable integration path for ANY CLI — normalize the
 *     transcript to this shape and it just works.
 *   - a permissive tool-use JSONL heuristic used by `claude-code`, `codex`,
 *     `gemini`, and `grok`: it scans JSONL for file-editing tool calls
 *     (file_path / notebook_path, or a `path` beside an edit/write/patch tool).
 *
 * The heuristic is deliberately conservative and best-effort; as each CLI's
 * format stabilizes, promote it to a dedicated parser. Provider-independent by
 * design — no assumptions beyond "a transcript mentions files it edited".
 */

export type IngestEvent =
  | { type: "file"; path: string; change: FileChangeKind }
  | { type: "decision"; title: string; rationale?: string }
  | { type: "note"; text: string };

export interface Adapter {
  name: string;
  parse(content: string): IngestEvent[];
}

function changeFromToolName(name: string): FileChangeKind {
  const n = name.toLowerCase();
  if (/delete|remove|rm\b/.test(n)) return "deleted";
  if (/write|create|add/.test(n)) return "added";
  return "modified";
}

const EDIT_TOOL_RE = /edit|write|patch|create|apply|delete|remove/i;

/**
 * Recursively collect file-edit events from an arbitrary parsed JSON value.
 * `file_path` and `notebook_path` are treated as unambiguous edit targets; a
 * bare `path` only counts under an edit/write/patch tool. The enclosing tool
 * name is threaded down (`ctxTool`) because a transcript typically nests the
 * path inside an `input`/`args` object one level below the tool name — so the
 * change kind must be derived from the ancestor, not the leaf.
 */
const MAX_DEPTH = 200;

function collectFileEdits(
  value: unknown,
  out: Map<string, FileChangeKind>,
  ctxTool = "",
  depth = 0,
): void {
  // Bound recursion so a pathologically-nested (attacker-influenced) transcript
  // cannot overflow the stack.
  if (depth > MAX_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectFileEdits(v, out, ctxTool, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  const obj = value as Record<string, unknown>;
  const localTool = [obj.name, obj.tool, obj.type, obj.function]
    .filter((v) => typeof v === "string")
    .join(" ");
  // Prefer a tool-shaped local name; otherwise keep the ancestor's.
  const toolName = EDIT_TOOL_RE.test(localTool) ? localTool : ctxTool;
  const change = changeFromToolName(toolName);

  for (const key of ["file_path", "notebook_path"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
      out.set(obj[key] as string, change);
    }
  }
  if (
    EDIT_TOOL_RE.test(toolName) &&
    typeof obj.path === "string" &&
    (obj.path as string).length > 0
  ) {
    out.set(obj.path as string, change);
  }
  for (const v of Object.values(obj)) {
    collectFileEdits(v, out, toolName, depth + 1);
  }
}

/** Parse JSONL lines tolerantly, skipping blank/malformed lines. */
function parseJsonl(content: string): unknown[] {
  const out: unknown[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/** The tool-use JSONL heuristic shared by real-CLI adapters. */
function heuristicAdapter(name: string): Adapter {
  return {
    name,
    parse(content: string): IngestEvent[] {
      const edits = new Map<string, FileChangeKind>();
      for (const entry of parseJsonl(content)) {
        collectFileEdits(entry, edits);
      }
      return [...edits.entries()].map(([path, change]) => ({
        type: "file",
        path,
        change,
      }));
    },
  };
}

/** Our normalized schema: JSON `{events:[...]}`, a bare array, or JSONL. */
export const genericAdapter: Adapter = {
  name: "generic",
  parse(content: string): IngestEvent[] {
    const isEvent = (e: unknown): e is IngestEvent =>
      typeof e === "object" &&
      e !== null &&
      ((e as any).type === "file" ||
        (e as any).type === "decision" ||
        (e as any).type === "note");

    const trimmed = content.trim();
    let raw: unknown[];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) raw = parsed;
      else if (parsed && Array.isArray((parsed as any).events))
        raw = (parsed as any).events;
      else raw = [parsed];
    } catch {
      raw = parseJsonl(trimmed); // fall back to JSONL of events
    }
    return raw.filter(isEvent);
  },
};

const REGISTRY: Record<string, Adapter> = {
  generic: genericAdapter,
  "claude-code": heuristicAdapter("claude-code"),
  codex: heuristicAdapter("codex"),
  gemini: heuristicAdapter("gemini"),
  grok: heuristicAdapter("grok"),
};

export const ADAPTERS: string[] = Object.keys(REGISTRY);

export function getAdapter(name: string): Adapter | undefined {
  return REGISTRY[name];
}
