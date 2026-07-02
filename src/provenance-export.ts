/**
 * Provenance Bundle export (open wire format `provenance/0`).
 *
 * Blackboard is an evidence-capture layer. This module lets it *emit* what it has
 * captured as a signed, tamper-evident, portable snapshot — useful on its own for
 * audit trails, compliance archives, analytics, and moving board state between
 * tools. Blackboard does not know or care who consumes the export and depends on
 * no consumer's code.
 *
 * `provenance/0` is an OPEN wire format, not any one product's format. Blackboard
 * implements it as its own infrastructure (see docs/provenance-export.md for the
 * shape and signing rules it emits); the format is a contract of bytes on the
 * wire, never a shared library. Many kinds of system can consume it — audit,
 * analytics, governance, or a project-memory engine — and a project-memory engine
 * is merely one such consumer, not something Blackboard depends on or serves.
 */
import Database from "better-sqlite3";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";

const PROTOCOL_VERSION = "provenance/0" as const;

interface Actor {
  id: string;
  publicKey: string; // base64 DER/SPKI Ed25519
}
interface NodeInput {
  key?: string;
  type: "issue" | "decision" | "task" | "evidence";
  title: string;
  body?: string;
  externalKey?: string;
  evidenceKind?: string;
  ref?: string;
}
interface EdgeInput {
  key?: string;
  from: string;
  to: string;
  relation: "resolves" | "addresses" | "implements" | "supersedes" | "relates";
  intent?: string;
  source?: "observed" | "inferred" | "claimed";
}
interface EvidenceInput {
  evidence: string;
  target: string;
  targetType?: "edge" | "node";
  stance?: "supports" | "contradicts";
}
interface BundlePayload {
  nodes?: NodeInput[];
  edges?: EdgeInput[];
  evidence?: EvidenceInput[];
}
export interface ProvenanceBundle {
  protocol: typeof PROTOCOL_VERSION;
  issuer: Actor;
  issuedAt: number;
  payload: BundlePayload;
  signature?: string;
}

/** Deterministic JSON — MUST match every other implementation of the spec. */
function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

export interface ExportKeypair {
  actorId: string;
  publicKeyB64: string;
  privateKeyPem: string;
}

/** Generate a fresh Ed25519 export identity. */
export function generateExportKey(actorId: string): ExportKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    actorId,
    publicKeyB64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** Load an export identity from a PEM private key. */
export function keyFromPem(actorId: string, privateKeyPem: string): ExportKeypair {
  const priv = createPrivateKey(privateKeyPem);
  // Node derives the public key from a private KeyObject at runtime; the @types
  // overload just doesn't list KeyObject, hence the cast.
  const pub = createPublicKey(priv as never)
    .export({ format: "der", type: "spki" })
    .toString("base64");
  return { actorId, publicKeyB64: pub, privateKeyPem };
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const ms = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};
function parseList(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) return j.map(String).map((x) => x.trim()).filter(Boolean);
  } catch {
    /* not JSON */
  }
  return s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}
function has(db: Database.Database, t: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t));
}
function all(db: Database.Database, t: string): Row[] {
  return has(db, t) ? (db.prepare(`SELECT * FROM ${t}`).all() as Row[]) : [];
}

/**
 * Read the board and build a Provenance Bundle payload. The mapping lives HERE,
 * with the producer that understands its own schema — never in the consumer.
 */
export function buildBundlePayload(db: Database.Database): BundlePayload {
  const nodes: NodeInput[] = [];
  const edges: EdgeInput[] = [];
  const evidence: EvidenceInput[] = [];

  // risks -> issues, remembering the task each risk hangs off.
  const taskKeyToIssueKey = new Map<string, string>();
  for (const r of all(db, "risks")) {
    const ext = `bb:risk:${String(r.id)}`;
    nodes.push({
      key: ext,
      type: "issue",
      title: str(r.title) ?? "(untitled risk)",
      body: `severity: ${str(r.severity) ?? "?"} · status: ${str(r.status) ?? "?"}`,
      externalKey: ext,
    });
    const tk = str(r.task_key);
    if (tk) taskKeyToIssueKey.set(tk, ext);
  }

  // tasks -> task nodes.
  const taskKeyToNodeKey = new Map<string, string>();
  for (const t of all(db, "tasks")) {
    const bkey = str(t.key) ?? String(t.id);
    const ext = `bb:task:${bkey}`;
    nodes.push({ key: ext, type: "task", title: str(t.title) ?? bkey, body: str(t.description) ?? "", externalKey: ext });
    taskKeyToNodeKey.set(bkey, ext);
  }
  const ensureTaskKey = (bkey: string): string => {
    const existing = taskKeyToNodeKey.get(bkey);
    if (existing) return existing;
    const ext = `bb:task:${bkey}`;
    nodes.push({ key: ext, type: "task", title: bkey, externalKey: ext });
    taskKeyToNodeKey.set(bkey, ext);
    return ext;
  };

  // decisions -> decision nodes + inferred causal edges + evidence.
  for (const d of all(db, "decisions")) {
    const dext = `bb:decision:${String(d.id)}`;
    nodes.push({
      key: dext,
      type: "decision",
      title: str(d.title) ?? "(untitled decision)",
      body: str(d.rationale) ?? "",
      externalKey: dext,
    });
    const intent = str(d.rationale);
    const addressEdgeKeys: string[] = [];
    const addressed = new Set<string>();
    for (const tk of parseList(d.related_tasks)) {
      const taskKey = ensureTaskKey(tk);
      const implKey = `e:impl:${dext}:${taskKey}`;
      edges.push({ key: implKey, from: taskKey, to: dext, relation: "implements", source: "observed" });
      const issueKey = taskKeyToIssueKey.get(tk);
      if (issueKey && !addressed.has(issueKey)) {
        addressed.add(issueKey);
        edges.push({ from: taskKey, to: issueKey, relation: "resolves", source: "observed" });
        const addrKey = `e:addr:${dext}:${issueKey}`;
        edges.push({ key: addrKey, from: dext, to: issueKey, relation: "addresses", intent, source: "inferred" });
        addressEdgeKeys.push(addrKey);
      }
    }

    const commits = parseList(d.related_commits);
    for (const sha of commits) {
      const evKey = `ev:commit:${sha}`;
      nodes.push({ key: evKey, type: "evidence", title: sha, evidenceKind: "commit", ref: sha, externalKey: evKey });
      for (const ek of addressEdgeKeys) evidence.push({ evidence: evKey, target: ek, targetType: "edge", stance: "supports" });
    }
    // reviews on those commits -> defending/contradicting evidence.
    for (const sha of commits) {
      for (const rev of all(db, "reviews")) {
        if (str(rev.commit_sha) !== sha) continue;
        const outcome = str(rev.outcome) ?? "commented";
        const stance = outcome === "approved" ? "supports" : outcome === "commented" ? undefined : "contradicts";
        if (!stance) continue;
        const evKey = `ev:review:${String(rev.id)}`;
        nodes.push({
          key: evKey,
          type: "evidence",
          title: `review ${outcome}: ${str(rev.note) ?? sha}`,
          evidenceKind: "review",
          ref: sha,
          externalKey: evKey,
        });
        for (const ek of addressEdgeKeys) evidence.push({ evidence: evKey, target: ek, targetType: "edge", stance });
      }
    }
  }

  return { nodes, edges, evidence };
}

/** Build and sign a bundle from a board database. */
export function exportBundle(
  db: Database.Database,
  key: ExportKeypair,
  issuedAt: number,
): ProvenanceBundle {
  const issuer: Actor = { id: key.actorId, publicKey: key.publicKeyB64 };
  const payload = buildBundlePayload(db);
  const signature = sign(
    null,
    Buffer.from(canonicalize({ issuer, issuedAt, payload })),
    createPrivateKey(key.privateKeyPem),
  ).toString("base64");
  return { protocol: PROTOCOL_VERSION, issuer, issuedAt, payload, signature };
}

/** Convenience for the CLI: open a board db read-only and export a signed bundle. */
export function exportBundleFromPath(
  dbPath: string,
  key: ExportKeypair,
  issuedAt: number,
): ProvenanceBundle {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return exportBundle(db, key, issuedAt);
  } finally {
    db.close();
  }
}
