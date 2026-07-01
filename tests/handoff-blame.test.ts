import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, initRepo, openBoard, tempDir } from "./helpers.js";

describe("handoff visibility (surfaced by the two-agent demo)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("a handoff to an agent is retrievable by that agent", () => {
    const claude = openBoard(dir.path, { agent: "claude" });
    claude.handoff("claude", "codex", "auth done, rate limiter next", {
      openQuestions: ["cap at 5/min?"]
    });
    claude.close();

    const codex = openBoard(dir.path, { agent: "codex" });
    const mine = codex.handoffsFor("codex");
    expect(mine.length).toBe(1);
    expect(mine[0].fromAgent).toBe("claude");
    expect(mine[0].openQuestions).toContain("cap at 5/min?");
    // and it is not shown to an unrelated agent
    expect(codex.handoffsFor("someone-else").length).toBe(0);
    codex.close();
  });
});

describe("blame is file-scoped (surfaced by the demo's double attribution)", () => {
  let dir: ReturnType<typeof tempDir>;
  let prevCwd: string;
  beforeEach(() => {
    dir = tempDir("bbblame-");
    initRepo(dir.path);
    writeFileSync(join(dir.path, ".gitignore"), ".octoboard/\n");
    prevCwd = process.cwd();
    process.chdir(dir.path);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    dir.dispose();
  });

  it("blame surfaces the attribution for the blamed file, not the commit's other files", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    writeFileSync(join(dir.path, "auth.ts"), "l1\nl2\n");
    writeFileSync(join(dir.path, "db.ts"), "x\n");
    git(["add", "auth.ts", "db.ts", ".gitignore"], dir.path);
    git(["commit", "-m", "two files"], dir.path);
    b.link("HEAD"); // one commit → attributions for BOTH auth.ts and db.ts

    const blamed = b.blame("auth.ts", 2)!;
    // Only the auth.ts attribution, not the sibling db.ts one.
    expect(blamed.attributions.every((a) => a.file === "auth.ts" || a.file === null)).toBe(true);
    expect(blamed.attributions.some((a) => a.file === "db.ts")).toBe(false);

    const narrative = b.blameNarrative("auth.ts", 2)!;
    expect(narrative.attributions.some((a) => a.file === "db.ts")).toBe(false);
    b.close();
  });
});
