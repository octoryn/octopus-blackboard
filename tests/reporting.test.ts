import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { git, initRepo, openBoard, tempDir } from "./helpers.js";
import { serve } from "../src/serve.js";

describe("report scorecard", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("computes review coverage and AI/human counts", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.attribute("c1", { actorType: "ai", actor: "claude", file: "a.ts" });
    b.attribute("c2", { actorType: "ai", actor: "claude", file: "b.ts" });
    b.review("c1", { reviewerType: "human", reviewer: "Ran", outcome: "approved" });

    const r = b.report();
    expect(r.commits.aiProduced).toBe(2);
    expect(r.commits.humanReviewed).toBe(1);
    expect(r.commits.unreviewed).toBe(1);
    expect(r.reviewCoverage).toBe(0.5);
    expect(r.attributions.ai).toBe(2);
    expect(r.perAgent[0].agent).toBe("claude");
    b.close();
  });

  it("coverage is N/A (null), not 100%, when there is no AI work to review", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    expect(b.report().reviewCoverage).toBeNull();
    b.close();
  });
});

describe("blame → narrative", () => {
  let dir: ReturnType<typeof tempDir>;
  let prevCwd: string;
  beforeEach(() => {
    dir = tempDir("bbnar-");
    initRepo(dir.path);
    writeFileSync(join(dir.path, ".gitignore"), ".octoboard/\n");
    prevCwd = process.cwd();
    process.chdir(dir.path);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    dir.dispose();
  });

  it("traces a line to its session and surfaces that session's decisions/handoffs", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession();
    writeFileSync(join(dir.path, "auth.ts"), "l1\nl2\nl3\n");
    git(["add", "auth.ts", ".gitignore"], dir.path);
    git(["commit", "-m", "auth"], dir.path);
    b.link("HEAD");
    b.decision("claude", "use ed25519", { rationale: "small keys" });
    b.handoff("claude", "codex", "review policy");

    const n = b.blameNarrative("auth.ts", 2);
    expect(n).toBeTruthy();
    expect(n!.session?.agentName).toBe("claude");
    expect(n!.decisions.some((d) => d.title === "use ed25519")).toBe(true);
    expect(n!.handoffs.some((h) => h.toAgent === "codex")).toBe(true);
    b.close();
  });
});

describe("read-only dashboard server", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("serves the report API and refuses non-GET", async () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.attribute("c1", { actorType: "ai", actor: "claude" });
    const server = serve(b, 0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;

    const report = await (await fetch(`http://localhost:${port}/api/report`)).json();
    expect(report.commits.aiProduced).toBe(1);

    const post = await fetch(`http://localhost:${port}/api/status`, { method: "POST" });
    expect(post.status).toBe(405);

    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(html).toContain("Octopus Blackboard");

    server.close();
    b.close();
  });
});
