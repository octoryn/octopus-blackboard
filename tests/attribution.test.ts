import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, initRepo, openBoard, tempDir } from "./helpers.js";
import { loadConfig } from "../src/config.js";
import { Board } from "../src/board.js";
import { boardDir } from "./helpers.js";

describe("sessions", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("persists the active session across board instances via the pointer file", () => {
    const b1 = openBoard(dir.path, { agent: "claude" });
    const session = b1.startSession("work");
    b1.close();

    // A brand-new config resolves the same active session from the pointer file.
    const cfg = loadConfig({ boardDir: boardDir(dir.path), agent: "claude" });
    expect(cfg.sessionId).toBe(session.id);

    const b2 = new Board(cfg);
    b2.note("claude", "after restart");
    const events = b2.sessionTimeline(session.id);
    expect(events.some((e) => e.summary === "after restart")).toBe(true);
    b2.close();
  });

  it("clears the pointer on stop so later writes have no session", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const s = b.startSession();
    b.stopSession();
    b.close();
    const cfg = loadConfig({ boardDir: boardDir(dir.path), agent: "claude" });
    expect(cfg.sessionId).toBeNull();
    const finished = new Board(cfg).getSession(s.id);
    expect(finished?.finishedAt).not.toBeNull();
  });
});

describe("git attribution", () => {
  let dir: ReturnType<typeof tempDir>;
  let prevCwd: string;
  beforeEach(() => {
    dir = tempDir("bbrepo-");
    initRepo(dir.path);
    writeFileSync(join(dir.path, ".gitignore"), ".octoboard/\n");
    prevCwd = process.cwd();
    process.chdir(dir.path); // git ops resolve against the working directory
  });
  afterEach(() => {
    process.chdir(prevCwd);
    dir.dispose();
  });

  function commit(file: string, content: string): void {
    writeFileSync(join(dir.path, file), content);
    git(["add", "."], dir.path);
    git(["commit", "-m", `add ${file}`], dir.path);
  }

  it("links a commit's files to the active session with denormalized identity", () => {
    const b = openBoard(dir.path, {
      agent: "claude",
      provider: "anthropic",
      model: "claude-opus-4-8",
      cli: "claude-code"
    });
    b.startSession("auth");
    commit("policy.ts", "x\n");
    const linked = b.link("HEAD");

    expect(linked).toBeTruthy();
    expect(linked!.files).toContain("policy.ts");
    // The board must never attribute its own storage.
    expect(linked!.files.some((f) => f.startsWith(".octoboard/"))).toBe(false);

    const attrs = b.attributionsForCommit(linked!.sha);
    const policy = attrs.find((a) => a.file === "policy.ts");
    expect(policy).toBeTruthy();
    expect(policy!.actor).toBe("claude");
    expect(policy!.model).toBe("claude-opus-4-8");
    expect(policy!.actorType).toBe("ai");
    b.close();
  });

  it("resolves revisions to full shas so reviews match attributions", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    commit("policy.ts", "x\n");
    const linked = b.link("HEAD")!;

    // Before review: the commit is unreviewed.
    expect(b.unreviewedCommits().map((c) => c.commit)).toContain(linked.sha);

    // Review by rev name "HEAD" must resolve to the same sha and clear it.
    b.review("HEAD", { reviewerType: "human", reviewer: "Ran", outcome: "approved" });
    expect(b.unreviewedCommits().map((c) => c.commit)).not.toContain(linked.sha);

    const explained = b.explain("HEAD")!;
    expect(explained.reviews.some((r) => r.reviewerType === "human" && r.reviewer === "Ran")).toBe(true);
    expect(explained.attributions.length).toBeGreaterThan(0);
    b.close();
  });

  it("an AI review does not satisfy the human-review requirement", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    commit("x.ts", "1\n");
    const linked = b.link("HEAD")!;
    b.review("HEAD", { reviewerType: "ai", reviewer: "codex", outcome: "approved" });
    expect(b.unreviewedCommits().map((c) => c.commit)).toContain(linked.sha);
    b.close();
  });

  it("answers who-touched and commits-by-actor", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    b.fileChanged("claude", "auth.ts", "modified");
    commit("auth.ts", "y\n");
    b.link("HEAD");

    const who = b.whoTouched("auth.ts");
    expect(who.gitAuthors).toContain("Dev");
    expect(who.sessions.some((s) => s.agent === "claude")).toBe(true);

    const commits = b.commitsByActor("claude-code");
    expect(commits.length).toBe(1);
    b.close();
  });
});
