import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openBoard, tempDir } from "./helpers.js";

describe("redaction covers the source row, not just the timeline (review #integrity-1)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("blanks the message body so inbox/status no longer leak it", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.message("claude", null, "SECRET: AKIA-hunter2");
    const seq = b.timeline().find((e) => e.kind === "message")!.seq;
    b.redact(seq, "PII");

    // The messages table (read by inbox/status/dashboard) no longer has it.
    const inbox = b.inbox("claude", true);
    expect(inbox.every((m) => !m.body.includes("hunter2"))).toBe(true);
    const status = b.status("claude");
    expect(
      status.unreadMessages.every((m) => !m.body.includes("hunter2")),
    ).toBe(true);
    // Timeline overlay also hides it, and the chain is still valid.
    expect(b.timeline().find((e) => e.seq === seq)!.summary).not.toContain(
      "hunter2",
    );
    expect(b.verifyChain().ok).toBe(true);
    b.close();
  });
});

describe("review outcome semantics (review #integrity-2)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("a rejected human review does NOT clear the gate or count as coverage", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.attribute("c1", { actorType: "ai", actor: "claude" });
    b.review("c1", {
      reviewerType: "human",
      reviewer: "Ran",
      outcome: "rejected",
    });

    // Still unreviewed, gate still fails, coverage still 0.
    expect(b.unreviewedCommits().map((c) => c.commit)).toContain("c1");
    expect(b.check({ commits: ["c1"], requireHumanReview: true }).ok).toBe(
      false,
    );
    expect(b.report().reviewCoverage).toBe(0);

    // An approval clears it.
    b.review("c1", {
      reviewerType: "human",
      reviewer: "Ran",
      outcome: "approved",
    });
    expect(b.check({ commits: ["c1"], requireHumanReview: true }).ok).toBe(
      true,
    );
    expect(b.report().reviewCoverage).toBe(1);
    b.close();
  });

  it("perAgent separates a human and an AI actor sharing a name", () => {
    const b = openBoard(dir.path, { agent: "alex" });
    b.attribute("c1", { actorType: "ai", actor: "alex" });
    b.attribute("c2", { actorType: "human", actor: "alex" });
    const rows = b.report().perAgent.filter((p) => p.agent === "alex");
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.actorType).sort()).toEqual(["ai", "human"]);
    b.close();
  });
});

describe("verifyChain reports missing anchor (review #integrity-4)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("links intact but anchored=false when the anchor is deleted", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.note("claude", "a");
    b.note("claude", "b");
    expect(b.verifyChain().anchored).toBe(true);
    const dbPath = b.config.dbPath;
    b.close();

    const raw = new Database(dbPath);
    raw.prepare("DELETE FROM timeline WHERE seq = 2").run();
    raw.prepare("DELETE FROM meta WHERE key IN ('head_seq','head_hash')").run();
    raw.close();

    const b2 = openBoard(dir.path, { agent: "claude" });
    const v = b2.verifyChain();
    // The links that remain are self-consistent, but without the anchor the
    // truncation is undetectable — so it must NOT read as a clean anchored pass.
    expect(v.ok).toBe(true);
    expect(v.anchored).toBe(false);
    b2.close();
  });
});
