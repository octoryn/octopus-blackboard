import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { boardDir, openBoard, tempDir } from "./helpers.js";

/** The v0.1 schema, before the attribution feature existed. */
const OLD_SCHEMA = `
CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT UNIQUE, kind TEXT, created_at TEXT, last_seen TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT, label TEXT, started_at TEXT, ended_at TEXT);
CREATE TABLE tasks (id TEXT PRIMARY KEY, key TEXT UNIQUE, title TEXT, status TEXT, created_by TEXT, claimed_by TEXT, claimed_at TEXT, released_at TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, body TEXT, created_at TEXT, read_at TEXT);
CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, rationale TEXT, created_at TEXT);
CREATE TABLE evidence (id TEXT PRIMARY KEY, agent_id TEXT, ref TEXT, note TEXT, target TEXT, created_at TEXT);
CREATE TABLE files_changed (id TEXT PRIMARY KEY, agent_id TEXT, path TEXT, change TEXT, task_key TEXT, created_at TEXT);
CREATE TABLE risks (id TEXT PRIMARY KEY, agent_id TEXT, title TEXT, severity TEXT, status TEXT, created_at TEXT);
CREATE TABLE handoffs (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT, summary TEXT, task_key TEXT, created_at TEXT, accepted_at TEXT);
CREATE TABLE timeline (id TEXT PRIMARY KEY, seq INTEGER UNIQUE, at TEXT, actor TEXT, kind TEXT, ref_table TEXT, ref_id TEXT, summary TEXT, payload TEXT, prev_hash TEXT, hash TEXT);
`;

describe("migration from an old-schema board", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("upgrades in place: preserves old rows, enables new writes, keeps the chain valid", () => {
    const bdir = boardDir(dir.path);
    mkdirSync(bdir, { recursive: true });
    const raw = new Database(join(bdir, "board.db"));
    raw.exec(OLD_SCHEMA);
    raw
      .prepare("INSERT INTO agents VALUES (?,?,?,?,?)")
      .run("a1", "codex", "codex-cli", "2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z");
    raw.close();

    // Opening with the current code runs the additive migration.
    const b = openBoard(dir.path, { agent: "claude", provider: "anthropic", cli: "claude-code" });

    // Old agent preserved (v0.1 stored the label in `kind`; `cli` is a new
    // nullable field old rows legitimately lack).
    const codex = b.getAgent("codex");
    expect(codex?.kind).toBe("codex-cli");
    expect(codex?.cli).toBeNull();

    // New session-aware writes work on the upgraded board.
    b.note("claude", "post-upgrade write");
    const session = b.startSession();
    expect(session.id).toBeTruthy();

    // The hash chain over the newly-written entries is valid.
    expect(b.verifyChain().ok).toBe(true);
    b.close();
  });
});
