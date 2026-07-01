import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openBoard, rawTamper, tempDir } from "./helpers.js";

describe("append-only is enforced at the DB layer (audit #1)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("a plain connection cannot UPDATE or DELETE timeline rows", () => {
    const b = openBoard(dir.path);
    b.note("claude", "a");
    b.note("claude", "b");
    const dbPath = b.config.dbPath;
    b.close();

    // A casual second connection (no trigger-dropping) is refused.
    const raw = new Database(dbPath);
    expect(() =>
      raw.prepare("UPDATE timeline SET summary = ? WHERE seq = 1").run("x"),
    ).toThrow(/append-only/);
    expect(() =>
      raw.prepare("DELETE FROM timeline WHERE seq = 1").run(),
    ).toThrow(/append-only/);
    // And the rows are untouched.
    expect(
      (raw.prepare("SELECT COUNT(*) n FROM timeline").get() as { n: number }).n,
    ).toBe(2);
    raw.close();
  });

  it("even a determined attacker (dropping triggers) is caught by the hash chain", () => {
    const b = openBoard(dir.path);
    b.note("claude", "a");
    b.note("claude", "b");
    b.note("claude", "c");
    const dbPath = b.config.dbPath;
    b.close();

    // Drop triggers, delete a MIDDLE row (contiguity break).
    const raw = rawTamper(dbPath);
    raw.prepare("DELETE FROM timeline WHERE seq = 2").run();
    raw.close();

    const b2 = openBoard(dir.path);
    const v = b2.verifyChain();
    expect(v.ok).toBe(false);
    b2.close();
  });

  it("normal board writes still work (triggers only block UPDATE/DELETE, not INSERT)", () => {
    const b = openBoard(dir.path);
    for (let i = 0; i < 5; i++) b.note("claude", `n${i}`);
    expect(b.verifyChain().ok).toBe(true);
    expect(b.timeline().length).toBe(5);
    b.close();
  });
});

describe("evidence content integrity (audit #6)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("hashes a local file on attach and detects later tampering", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const file = join(dir.path, "proof.txt");
    writeFileSync(file, "original content");
    const ev = b.evidence("claude", file, "the proof");
    expect(ev.sha256).not.toBeNull();

    // Unchanged → ok.
    expect(b.verifyEvidence().find((c) => c.ref === file)?.status).toBe("ok");

    // Swap the file content → changed.
    writeFileSync(file, "TAMPERED");
    expect(b.verifyEvidence().find((c) => c.ref === file)?.status).toBe(
      "changed",
    );

    // Remove the file → missing.
    rmSync(file);
    expect(b.verifyEvidence().find((c) => c.ref === file)?.status).toBe(
      "missing",
    );
    b.close();
  });

  it("a URL / non-file reference is recorded as unhashed (not a false positive)", () => {
    const b = openBoard(dir.path, { agent: "claude" });
    const ev = b.evidence("claude", "https://ci.example.com/run/42");
    expect(ev.sha256).toBeNull();
    expect(
      b.verifyEvidence().find((c) => c.ref.startsWith("https"))?.status,
    ).toBe("unhashed");
    b.close();
  });
});

describe("sync/import cannot accrete noise (audit #8)", () => {
  let src: ReturnType<typeof tempDir>;
  let dst: ReturnType<typeof tempDir>;
  beforeEach(() => {
    src = tempDir("bbi-src-");
    dst = tempDir("bbi-dst-");
  });
  afterEach(() => {
    src.dispose();
    dst.dispose();
  });

  it("re-importing the same bundle appends no extra timeline event", () => {
    const a = openBoard(src.path, { agent: "claude" });
    a.attribute("cafe01", { actorType: "ai", actor: "claude" });
    const bundle = a.exportBundle();
    a.close();

    const b = openBoard(dst.path, { agent: "ci" });
    b.importBundle(bundle); // real import → one 'import' event
    const afterFirst = b.timeline().filter((e) => e.kind === "import").length;
    b.importBundle(bundle); // no-op re-import → NO new event
    const afterSecond = b.timeline().filter((e) => e.kind === "import").length;
    expect(afterFirst).toBe(1);
    expect(afterSecond).toBe(1);
    b.close();
  });
});

describe("conflict is contention, not corruption (audit #4)", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => (dir = tempDir()));
  afterEach(() => dir.dispose());

  it("a second claim of the same key is one task, conflict surfaced, chain intact", () => {
    const a = openBoard(dir.path, { agent: "claude" });
    a.claim("claude", "shared");
    a.close();
    const b = openBoard(dir.path, { agent: "codex" });
    const r = b.claim("codex", "shared");
    expect(r.conflict).toBe("claude"); // contention is surfaced
    expect(b.listTasks().filter((t) => t.key === "shared").length).toBe(1); // no dup row
    expect(b.verifyChain().ok).toBe(true); // not corruption
    b.close();
  });
});
