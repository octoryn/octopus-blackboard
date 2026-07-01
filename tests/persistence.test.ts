import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { openBoard, tempDir } from "./helpers.js";
import { openDb } from "../src/db.js";

describe("session pointer is DB-backed and race-safe (review #persist-1)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("stopping an OLD session does not clear a newer session's pointer", () => {
    const a = openBoard(dir.path, { agent: "agentA" });
    const sa1 = a.startSession();
    const sa2 = a.startSession(); // pointer now → sa2
    a.stopSession(sa1.id); // stopping the superseded session must not clear sa2
    a.close();

    const fresh = openBoard(dir.path, { agent: "agentA" });
    expect(fresh.activeSessionId()).toBe(sa2.id);
    fresh.close();
  });

  it("keeps per-agent pointers independent (no cross-agent clobber)", () => {
    const a = openBoard(dir.path, { agent: "agentA" });
    const sa = a.startSession();
    a.close();
    const b = openBoard(dir.path, { agent: "agentB" });
    b.startSession();
    b.close();
    // agentA stops; agentB must be untouched.
    const a2 = openBoard(dir.path, { agent: "agentA" });
    a2.stopSession(sa.id);
    a2.close();

    const ca = openBoard(dir.path, { agent: "agentA" });
    expect(ca.activeSessionId()).toBeNull();
    ca.close();
    const cb = openBoard(dir.path, { agent: "agentB" });
    expect(cb.activeSessionId()).not.toBeNull();
    cb.close();
  });
});

describe("durability pragma (review #persist-3)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("sets synchronous=FULL under WAL for audit-log durability", () => {
    // synchronous is per-connection, so check the connection openDb configured.
    const db = openDb(join(dir.path, ".octoboard", "board.db"));
    expect(db.pragma("synchronous", { simple: true })).toBe(2); // 2 === FULL
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();
  });
});
