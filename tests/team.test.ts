import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openBoard, tempDir } from "./helpers.js";
import { createSyncTarget, FileSyncTarget } from "../src/sync.js";

describe("F — team sync (file target)", () => {
  let src: ReturnType<typeof tempDir>;
  let dst: ReturnType<typeof tempDir>;
  let shared: ReturnType<typeof tempDir>;
  beforeEach(() => {
    src = tempDir("bbsrc-");
    dst = tempDir("bbdst-");
    shared = tempDir("bbshared-");
  });
  afterEach(() => {
    src.dispose();
    dst.dispose();
    shared.dispose();
  });

  it("pushes and pulls attribution between boards, idempotently", async () => {
    const targetPath = join(shared.path, "team.json");
    const a = openBoard(src.path, { agent: "claude", cli: "claude-code" });
    a.attribute("deadbeef01", { actorType: "ai", actor: "claude" });

    const t1 = createSyncTarget(targetPath);
    expect(t1).toBeInstanceOf(FileSyncTarget);
    const pushed = await t1.push(a.exportBundle());
    expect(pushed.attributions).toBe(1);
    // Re-push is idempotent.
    expect((await t1.push(a.exportBundle())).attributions).toBe(0);
    await t1.close();
    a.close();

    const b = openBoard(dst.path, { agent: "ci" });
    const t2 = createSyncTarget(targetPath);
    const remote = await t2.pull();
    const counts = b.importBundle(remote);
    expect(counts.attributions).toBe(1);
    expect(b.commitsByActor("claude").length).toBe(1);
    await t2.close();
    b.close();
  });

  it("routes postgres:// specs to the Postgres target", () => {
    // Not connecting — just verifying the factory does not build a file target.
    const t = createSyncTarget("postgres://user@localhost/db");
    expect(t).not.toBeInstanceOf(FileSyncTarget);
  });
});

describe("heartbeat & liveness", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("distinguishes active from stale and finished sessions", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const s = b.startSession();
    expect(b.activeSessions().some((x) => x.id === s.id)).toBe(true);

    // Simulate a stale heartbeat by backdating it directly.
    const dbPath = b.config.dbPath;
    b.close();
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?")
      .run("2000-01-01T00:00:00Z", s.id);
    raw.close();

    const b2 = openBoard(dir.path, { agent: "claude" });
    expect(b2.activeSessions().some((x) => x.id === s.id)).toBe(false);
    // A fresh heartbeat revives it.
    b2.heartbeat(s.id);
    expect(b2.activeSessions().some((x) => x.id === s.id)).toBe(true);
    b2.close();
  });

  it("reports other active sessions editing the same file", () => {
    const a = openBoard(dir.path, { agent: "claude" });
    const sa = a.startSession();
    a.fileChanged("claude", "shared.ts", "modified");
    a.close();

    const b = openBoard(dir.path, { agent: "codex" });
    b.startSession();
    const editors = b.activeEditorsOfFile("shared.ts", null);
    expect(
      editors.some((e) => e.agent === "claude" && e.sessionId === sa.id),
    ).toBe(true);
    b.close();
  });
});

describe("retention & redaction", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("redacting a message truly erases its body from ALL storage, chain still valid", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.message("claude", null, "sensitive: hunter2");
    const seq = b.timeline().find((e) => e.kind === "message")!.seq;
    b.redact(seq, "PII");

    // Read-layer overlay is blanked, chain still verifies.
    expect(b.timeline().find((e) => e.seq === seq)!.summary).toContain(
      "[redacted",
    );
    expect(b.verifyChain().ok).toBe(true);

    // The message body was never written into the hashed timeline (metadata-only
    // summary), and redact blanked messages.body — so the secret is in NO raw
    // storage location. This is true erasure, not just a read overlay.
    const dbPath = b.config.dbPath;
    b.close();
    const db = new Database(dbPath);
    const tl = db
      .prepare("SELECT summary, payload FROM timeline WHERE seq = ?")
      .get(seq) as { summary: string; payload: string | null };
    expect(tl.summary).not.toContain("hunter2");
    expect(tl.payload ?? "").not.toContain("hunter2");
    const msgs = db.prepare("SELECT body FROM messages").all() as {
      body: string;
    }[];
    expect(msgs.every((m) => !m.body.includes("hunter2"))).toBe(true);
    db.close();
  });

  it("prune deletes old sensitive rows but preserves the timeline", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.message("claude", null, "old message");
    const before = b.timeline().length;
    const counts = b.prune("2030-01-01T00:00:00Z");
    expect(counts.messages).toBe(1);
    expect(b.inbox("claude", true).length).toBe(0); // message row gone
    expect(b.timeline().length).toBe(before + 1); // timeline preserved + prune event
    expect(b.verifyChain().ok).toBe(true);
    b.close();
  });
});
