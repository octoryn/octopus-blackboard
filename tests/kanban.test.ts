import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBoard, tempDir } from "./helpers.js";

describe("kanban tasks", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("assigns stable numbers and resolves by key or #number", () => {
    const b = openBoard(dir.path, { agent: "ran" });
    const t1 = b.defineTask("ran", "auth-mw", { title: "Auth" });
    const t2 = b.defineTask("ran", "rate-limit", { title: "Rate limit" });
    expect(t1.number).toBe(1);
    expect(t2.number).toBe(2);
    expect(b.resolveTask("2")?.key).toBe("rate-limit");
    expect(b.resolveTask("#2")?.key).toBe("rate-limit");
    expect(b.resolveTask("auth-mw")?.number).toBe(1);
    // Re-defining updates fields, keeps the number.
    const again = b.defineTask("ran", "auth-mw", { riskLevel: "high" });
    expect(again.number).toBe(1);
    expect(again.riskLevel).toBe("high");
    b.close();
  });

  it("claim also numbers a freshly-created task", () => {
    const b = openBoard(dir.path, { agent: "codex" });
    const r = b.claim("codex", "adhoc");
    expect(r.task.number).toBe(1);
    b.close();
  });

  it("assign records an assignee AND notifies via the recipient's inbox", () => {
    const b = openBoard(dir.path, { agent: "ran" });
    b.defineTask("ran", "auth-mw", {
      title: "Auth middleware",
      project: "api",
      riskLevel: "high",
    });
    b.assign("ran", "auth-mw", "claude");

    expect(b.assigneesFor("auth-mw")).toContain("claude");
    const inbox = b.inbox("claude");
    expect(inbox.length).toBe(1);
    expect(inbox[0].body).toContain("task #1");
    expect(inbox[0].body).toContain("risk high");
    b.close();
  });

  it("progress moves status to in-progress then done, clamped 0–100", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    b.defineTask("claude", "t", {});
    expect(b.setProgress("claude", "t", 40)?.status).toBe("in-progress");
    expect(b.setProgress("claude", "t", 150)?.progress).toBe(100);
    expect(b.getTask("t")?.status).toBe("done");
    b.close();
  });

  it("taskCard aggregates assignees, active agents, files, and risks", () => {
    const b = openBoard(dir.path, { agent: "claude", cli: "claude-code" });
    b.startSession(); // makes "claude" an active agent
    b.defineTask("claude", "auth-mw", { title: "Auth" });
    b.assign("claude", "auth-mw", "claude");
    b.fileChanged("claude", "src/auth.ts", "modified", "auth-mw");
    b.risk("claude", "migration may break replay", "high", "auth-mw");

    const card = b.taskCard("auth-mw")!;
    expect(card.assignees).toContain("claude");
    expect(card.activeAgents).toBe(1);
    expect(card.impactFiles).toContain("src/auth.ts");
    expect(card.risks.some((r) => r.severity === "high")).toBe(true);
    b.close();
  });

  it("listTaskCards returns every task with its derived card", () => {
    const b = openBoard(dir.path, { agent: "ran" });
    b.defineTask("ran", "a", {});
    b.defineTask("ran", "b", {});
    const cards = b.listTaskCards();
    expect(cards.length).toBe(2);
    expect(cards.every((c) => typeof c.activeAgents === "number")).toBe(true);
    b.close();
  });
});
