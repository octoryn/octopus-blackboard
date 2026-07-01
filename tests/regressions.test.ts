import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as gitmod from "../src/git.js";
import { git, initRepo, openBoard, rawTamper, tempDir } from "./helpers.js";

/**
 * Regression tests for defects found in the adversarial review. Each test
 * pins a specific bug so it cannot silently return.
 */

describe("chain: tail-truncation detection (adversarial #core-1)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("catches deletion of the newest row via the head anchor", () => {
    const b = openBoard(dir.path);
    b.note("claude", "a");
    b.note("claude", "b");
    b.note("claude", "c");
    const dbPath = b.config.dbPath;
    expect(b.verifyChain().ok).toBe(true);
    b.close();

    const raw = rawTamper(dbPath);
    raw.prepare("DELETE FROM timeline WHERE seq = 3").run(); // truncate the tail
    raw.close();

    const b2 = openBoard(dir.path);
    const v = b2.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(3);
    b2.close();
  });
});

describe("query: commitsByActor reports the matching actor (adversarial #data-1)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("does not mislabel a commit with the wrong sibling attribution's actor", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    // Two AI attributions on ONE commit, different actors/times.
    b.attribute("deadbeefcafe0001", { actor: "agentA", actorType: "ai" });
    b.attribute("deadbeefcafe0001", { actor: "agentB", actorType: "ai" });

    const rows = b.commitsByActor("agentB");
    expect(rows.length).toBe(1);
    expect(rows[0].actor).toBe("agentB"); // must not be "agentA"
    b.close();
  });
});

describe("query: decisionsForCommit prefix guard (adversarial #data-3)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  const fullSha = "abcdef0123456789abcdef0123456789abcdef01";

  it("an empty related-commit does NOT match every commit", () => {
    const b = openBoard(dir.path);
    b.decision("claude", "loose decision", { relatedCommits: [""] });
    expect(b.decisionsForCommit(fullSha).length).toBe(0);
    b.close();
  });

  it("a sub-short-sha value does not false-match", () => {
    const b = openBoard(dir.path);
    b.decision("claude", "typo", { relatedCommits: ["ab"] });
    expect(b.decisionsForCommit(fullSha).length).toBe(0);
    b.close();
  });

  it("a >=7-char prefix of the sha matches", () => {
    const b = openBoard(dir.path);
    b.decision("claude", "real", { relatedCommits: [fullSha.slice(0, 8)] });
    expect(b.decisionsForCommit(fullSha).length).toBe(1);
    b.close();
  });
});

describe("git: argument-injection is neutralized (adversarial #git-1/#git-2)", () => {
  let dir: ReturnType<typeof tempDir>;
  let prevCwd: string;
  beforeEach(() => {
    dir = tempDir("bbsec-");
    initRepo(dir.path);
    writeFileSync(join(dir.path, "f.ts"), "x\n");
    git(["add", "."], dir.path);
    git(["commit", "-m", "init"], dir.path);
    prevCwd = process.cwd();
    process.chdir(dir.path);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    dir.dispose();
  });

  it("a dashed rev cannot make `git show --output` write a file", () => {
    gitmod.commitInfo("--output=EVIL_A");
    gitmod.filesInCommit("--output=EVIL_B");
    expect(existsSync(join(dir.path, "EVIL_A"))).toBe(false);
    expect(existsSync(join(dir.path, "EVIL_B"))).toBe(false);
  });

  it("board.explain with a dashed rev is safe and returns undefined", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const result = b.explain("--output=EVIL_C");
    expect(result).toBeUndefined();
    expect(existsSync(join(dir.path, "EVIL_C"))).toBe(false);
    b.close();
  });

  it("non-ASCII filenames round-trip through filesInCommit (no C-quoting)", () => {
    writeFileSync(join(dir.path, "café.txt"), "y\n");
    git(["add", "."], dir.path);
    git(["commit", "-m", "unicode"], dir.path);
    expect(gitmod.filesInCommit("HEAD")).toContain("café.txt");
  });
});
