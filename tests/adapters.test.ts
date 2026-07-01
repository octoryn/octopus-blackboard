import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getAdapter, genericAdapter } from "../src/adapters.js";
import { openBoard, tempDir } from "./helpers.js";

describe("generic adapter", () => {
  it("parses the {events:[...]} object form", () => {
    const events = genericAdapter.parse(JSON.stringify({ events: [{ type: "note", text: "hi" }] }));
    expect(events).toEqual([{ type: "note", text: "hi" }]);
  });

  it("parses a bare array and JSONL, and drops invalid events", () => {
    expect(genericAdapter.parse('[{"type":"file","path":"a.ts","change":"added"}]').length).toBe(1);
    const jsonl = '{"type":"note","text":"x"}\n{"nope":1}\n{"type":"decision","title":"d"}';
    const parsed = genericAdapter.parse(jsonl);
    expect(parsed.map((e) => e.type).sort()).toEqual(["decision", "note"]);
  });
});

describe("claude-code heuristic adapter", () => {
  const adapter = getAdapter("claude-code")!;

  it("extracts and dedups file edits, deriving change kind from the tool", () => {
    const jsonl = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/new.ts" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "src/auth.ts" } }] } }),
      "not json — skipped"
    ].join("\n");
    const events = adapter.parse(jsonl);
    const byPath = Object.fromEntries(events.map((e) => [(e as any).path, (e as any).change]));
    expect(byPath["src/auth.ts"]).toBe("modified"); // deduped to one, from Edit
    expect(byPath["src/new.ts"]).toBe("added"); // Write → added
    expect(events.length).toBe(2);
  });

  it("handles the codex apply_patch shape via the path+edit-tool rule", () => {
    const events = getAdapter("codex")!.parse('{"tool":"apply_patch","path":"lib/x.py"}');
    expect(events).toEqual([{ type: "file", path: "lib/x.py", change: "modified" }]);
  });
});

describe("Board.ingest", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("records file/decision/note events and stays chain-valid", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    const counts = b.ingest([
      { type: "file", path: "a.ts", change: "modified" },
      { type: "file", path: "b.ts", change: "added" },
      { type: "decision", title: "use X" },
      { type: "note", text: "did stuff" }
    ]);
    expect(counts).toEqual({ files: 2, decisions: 1, notes: 1 });
    expect(b.whoTouched("a.ts").sessions.length).toBe(1);
    expect(b.timeline().some((e) => e.kind === "ingest")).toBe(true);
    expect(b.verifyChain().ok).toBe(true);
    b.close();
  });
});
