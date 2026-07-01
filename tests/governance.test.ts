import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBoard, rawTamper, tempDir } from "./helpers.js";

describe("B — CI gate (check)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("fails on an AI commit with no human review, passes once reviewed", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.attribute("c0ffee00", { actorType: "ai", actor: "claude" });

    const before = b.check({ commits: ["c0ffee00"], requireHumanReview: true });
    expect(before.ok).toBe(false);
    expect(before.violations[0].kind).toBe("unreviewed");

    b.review("c0ffee00", {
      reviewerType: "human",
      reviewer: "Ran",
      outcome: "approved",
    });
    const after = b.check({ commits: ["c0ffee00"], requireHumanReview: true });
    expect(after.ok).toBe(true);
    b.close();
  });

  it("an AI review alone does not satisfy the human-review gate", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.attribute("beef0001", { actorType: "ai", actor: "claude" });
    b.review("beef0001", {
      reviewerType: "ai",
      reviewer: "codex",
      outcome: "approved",
    });
    expect(
      b.check({ commits: ["beef0001"], requireHumanReview: true }).ok,
    ).toBe(false);
    b.close();
  });

  it("requireAttribution flags a scoped commit with no attribution", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const r = b.check({ commits: ["never-seen"], requireAttribution: true });
    expect(r.ok).toBe(false);
    expect(r.violations[0].kind).toBe("unattributed");
    b.close();
  });

  it("verifyChain gate fails when the chain is broken", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.note("claude", "x");
    // Tamper via a second connection-independent path: mutate then re-open.
    const dbPath = b.config.dbPath;
    b.close();
    const raw = rawTamper(dbPath);
    raw.prepare("UPDATE timeline SET summary = ? WHERE seq = 1").run("forged");
    raw.close();
    const b2 = openBoard(dir.path, { agent: "claude" });
    expect(b2.check({ verifyChain: true }).ok).toBe(false);
    b2.close();
  });
});

describe("C — export / import portability", () => {
  let dir: ReturnType<typeof tempDir>;
  let dir2: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir("bbsrc-");
    dir2 = tempDir("bbdst-");
  });
  afterEach(() => {
    dir.dispose();
    dir2.dispose();
  });

  it("round-trips attribution to another board and is idempotent", () => {
    const src = openBoard(dir.path, {
      agent: "claude",
      provider: "anthropic",
      model: "claude-opus-4-8",
      cli: "claude-code",
    });
    src.startSession();
    src.attribute("dead0001", {
      actorType: "ai",
      actor: "claude",
      file: "auth.ts",
    });
    src.review("dead0001", {
      reviewerType: "human",
      reviewer: "Ran",
      outcome: "approved",
    });
    const bundle = src.exportBundle(["dead0001"]);
    src.close();

    expect(bundle.attributions.length).toBe(1);
    expect(bundle.reviews.length).toBe(1);

    const dst = openBoard(dir2.path, { agent: "ci" });
    const first = dst.importBundle(bundle);
    expect(first.attributions).toBe(1);
    expect(first.reviews).toBe(1);

    // Idempotent: re-importing changes nothing.
    const second = dst.importBundle(bundle);
    expect(second.attributions).toBe(0);
    expect(second.reviews).toBe(0);

    // The destination now answers attribution queries and the gate.
    expect(dst.commitsByActor("claude-code").length).toBe(1);
    expect(
      dst.check({ commits: ["dead0001"], requireHumanReview: true }).ok,
    ).toBe(true);
    dst.close();
  });

  it("rejects a bundle with an unknown version", () => {
    const dst = openBoard(dir2.path, { agent: "ci" });
    expect(() => dst.importBundle({ version: "bogus@9" } as any)).toThrow();
    dst.close();
  });
});

describe("A — watch / subscribe relevance", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("notable() filters to an agent's messages, broadcasts, handoffs, and conflicts", () => {
    const b = openBoard(dir.path, { agent: "codex" });
    b.message("codex", "claude", "for you");
    b.message("codex", null, "for everyone");
    b.handoff("codex", "claude", "take it");
    b.note("codex", "codex-only");
    const events = b.since(0);
    const forClaude = b.notable(events, "claude");
    const kinds = forClaude.map((e) => e.kind).sort();
    expect(kinds).toEqual(["handoff", "message", "message"]);
    // codex's own note is excluded.
    expect(forClaude.some((e) => e.summary.includes("codex-only"))).toBe(false);
    b.close();
  });

  it("since() returns only events after the given seq", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.note("claude", "one");
    const mark = b.headSeq();
    b.note("claude", "two");
    b.note("claude", "three");
    const fresh = b.since(mark);
    expect(fresh.map((e) => e.summary)).toEqual(["two", "three"]);
    b.close();
  });
});

describe("E — session signing v0", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("signs the head on session stop and verifies as trusted", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.startSession();
    b.note("claude", "work");
    b.stopSession(); // auto-signs
    const sigs = b.verifySignatures();
    expect(sigs.length).toBe(1);
    expect(sigs[0].valid).toBe(true);
    expect(sigs[0].current).toBe(true);
    expect(b.signedThrough()).toBeGreaterThan(0);
    b.close();
  });

  it("a signature goes stale when history below it is tampered", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.startSession();
    b.note("claude", "work");
    b.stopSession();
    const dbPath = b.config.dbPath;
    b.close();
    const raw = rawTamper(dbPath);
    raw.prepare("UPDATE timeline SET summary = ? WHERE seq = 2").run("forged");
    raw.close();

    const b2 = openBoard(dir.path, { agent: "claude" });
    const sigs = b2.verifySignatures();
    expect(sigs[0].valid).toBe(true); // signature itself is still cryptographically valid
    expect(sigs[0].current).toBe(false); // but no longer covers the (now-broken) chain
    expect(b2.signedThrough()).toBe(0);
    b2.close();
  });
});
