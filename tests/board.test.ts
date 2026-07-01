import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openBoard, tempDir } from "./helpers.js";

describe("timeline hash chain", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("appends entries and verifies the chain", () => {
    const b = openBoard(dir.path);
    b.note("claude", "hello");
    b.note("claude", "world");
    const v = b.verifyChain();
    expect(v.ok).toBe(true);
    expect(v.length).toBe(2);
    expect(v.brokenAtSeq).toBeNull();
    b.close();
  });

  it("detects tampering with an earlier entry", () => {
    const b = openBoard(dir.path);
    b.decision("claude", "use a hash chain");
    b.note("claude", "second");
    const dbPath = b.config.dbPath;
    b.close();

    // Mutate seq 1 directly in SQLite, bypassing the board.
    const raw = new Database(dbPath);
    raw.prepare("UPDATE timeline SET summary = ? WHERE seq = 1").run("something else");
    raw.close();

    const b2 = openBoard(dir.path);
    const v = b2.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(1);
    b2.close();
  });

  it("includes session_id in the hash (re-parenting an event breaks the chain)", () => {
    const b = openBoard(dir.path);
    b.note("claude", "a");
    const dbPath = b.config.dbPath;
    b.close();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE timeline SET session_id = ? WHERE seq = 1").run("forged-session");
    raw.close();
    const b2 = openBoard(dir.path);
    expect(b2.verifyChain().ok).toBe(false);
    b2.close();
  });
});

describe("coordination", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("surfaces claim conflicts without blocking the second claim", () => {
    const codex = openBoard(dir.path, { agent: "codex" });
    const first = codex.claim("codex", "policy-engine");
    expect(first.conflict).toBeNull();
    codex.close();

    const claude = openBoard(dir.path, { agent: "claude" });
    const second = claude.claim("claude", "policy-engine");
    expect(second.conflict).toBe("codex");
    // Both claims recorded; the board records collisions, it does not prevent them.
    expect(second.task.claimedBy).toBe("claude");
    claude.close();
  });

  it("routes messages to a recipient inbox and marks them read", () => {
    const codex = openBoard(dir.path, { agent: "codex" });
    codex.message("codex", "claude", "review edge cases");
    codex.message("codex", null, "broadcast to all");
    codex.close();

    const claude = openBoard(dir.path, { agent: "claude" });
    const inbox = claude.inbox("claude");
    expect(inbox.map((m) => m.body).sort()).toEqual(["broadcast to all", "review edge cases"]);
    claude.markRead(inbox[0].id);
    expect(claude.inbox("claude").length).toBe(1);
    claude.close();
  });

  it("reports files jointly modified by two agents", () => {
    const claude = openBoard(dir.path, { agent: "claude" });
    claude.fileChanged("claude", "shared.ts", "modified");
    claude.fileChanged("claude", "a.ts", "added");
    claude.close();
    const codex = openBoard(dir.path, { agent: "codex" });
    codex.fileChanged("codex", "shared.ts", "modified");
    codex.fileChanged("codex", "b.ts", "added");
    expect(codex.jointFiles("claude", "codex")).toEqual(["shared.ts"]);
    codex.close();
  });
});
