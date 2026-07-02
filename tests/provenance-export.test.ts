import Database from "better-sqlite3";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildBundlePayload,
  exportBundle,
  generateExportKey,
} from "../src/provenance-export.js";

/** Minimal board-shaped fixture. */
function board(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE risks (id TEXT, agent_id TEXT, title TEXT, severity TEXT, status TEXT, task_key TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT, key TEXT, title TEXT, description TEXT, created_at TEXT);
    CREATE TABLE decisions (id TEXT, agent_id TEXT, title TEXT, rationale TEXT, related_commits TEXT, related_tasks TEXT, created_at TEXT);
    CREATE TABLE reviews (id TEXT, commit_sha TEXT, outcome TEXT, note TEXT, created_at TEXT);
  `);
  const iso = "2026-06-01T00:00:00.000Z";
  db.prepare(`INSERT INTO risks VALUES (?,?,?,?,?,?,?)`).run("R1", "claude", "Metal crash", "high", "open", "T-metal", iso);
  db.prepare(`INSERT INTO tasks VALUES (?,?,?,?,?)`).run("t1", "T-metal", "Fix Metal crash", "pad weights", iso);
  db.prepare(`INSERT INTO decisions VALUES (?,?,?,?,?,?,?)`).run(
    "D1", "claude", "Pad to 64 bytes", "misalignment crashes", JSON.stringify(["sha1"]), JSON.stringify(["T-metal"]), iso,
  );
  db.prepare(`INSERT INTO reviews VALUES (?,?,?,?,?)`).run("rev1", "sha1", "approved", "confirmed", iso);
  return db;
}

// The verifier a consumer would run — matches the shared provenance/0 spec.
function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) o[k] = sort((v as Record<string, unknown>)[k]);
      return o;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

describe("provenance export", () => {
  it("maps risks/tasks/decisions into a bundle payload", () => {
    const payload = buildBundlePayload(board());
    const types = (payload.nodes ?? []).map((n) => `${n.type}:${n.title}`);
    expect(types).toContain("issue:Metal crash");
    expect(types).toContain("decision:Pad to 64 bytes");
    expect(types).toContain("task:Fix Metal crash");
    // an inferred addresses edge from the shared task
    expect((payload.edges ?? []).some((e) => e.relation === "addresses")).toBe(true);
    // the approved review is present as review evidence
    expect((payload.nodes ?? []).some((n) => n.evidenceKind === "review")).toBe(true);
  });

  it("produces a bundle whose signature a spec-compliant consumer verifies", () => {
    const key = generateExportKey("octopus-blackboard");
    const bundle = exportBundle(board(), key, 1_700_000_000_000);
    expect(bundle.protocol).toBe("provenance/0");
    const bytes = Buffer.from(canonicalize({ issuer: bundle.issuer, issuedAt: bundle.issuedAt, payload: bundle.payload }));
    const pub = createPublicKey({ key: Buffer.from(bundle.issuer.publicKey, "base64"), format: "der", type: "spki" });
    expect(cryptoVerify(null, bytes, pub, Buffer.from(bundle.signature!, "base64"))).toBe(true);
  });

  it("tampering with the exported payload breaks the signature", () => {
    const key = generateExportKey("octopus-blackboard");
    const bundle = exportBundle(board(), key, 1_700_000_000_000);
    bundle.payload.nodes![0].title = "tampered";
    const bytes = Buffer.from(canonicalize({ issuer: bundle.issuer, issuedAt: bundle.issuedAt, payload: bundle.payload }));
    const pub = createPublicKey({ key: Buffer.from(bundle.issuer.publicKey, "base64"), format: "der", type: "spki" });
    expect(cryptoVerify(null, bytes, pub, Buffer.from(bundle.signature!, "base64"))).toBe(false);
  });
});
