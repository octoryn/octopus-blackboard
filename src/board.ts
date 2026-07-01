import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import {
  loadConfig,
  type AgentIdentity,
  type BoardConfig,
  type ConfigOverrides,
} from "./config.js";
import * as git from "./git.js";
import { generateSessionKeypair, signHash, verifyHash } from "./signing.js";
import type { IngestEvent } from "./adapters.js";
import type {
  Agent,
  ActorType,
  Attribution,
  BoardStatus,
  Decision,
  Evidence,
  EvidenceCheck,
  EvidenceStatus,
  FileChange,
  FileChangeKind,
  Handoff,
  Message,
  Review,
  ReviewerType,
  ReviewOutcome,
  Risk,
  RiskSeverity,
  RiskLevel,
  Session,
  Task,
  TaskCard,
  TaskStatus,
  TimelineEvent,
} from "./types.js";

const GENESIS_HASH = "0".repeat(64);

function now(): string {
  return new Date().toISOString();
}

function id(): string {
  return randomUUID();
}

/** Result of claiming a task — `conflict` is set if another agent holds it. */
export interface ClaimResult {
  task: Task;
  /** The agent currently holding the key, if it was already claimed. */
  conflict: string | null;
}

/** Result of verifying the timeline hash chain. */
export interface ChainVerification {
  ok: boolean;
  length: number;
  /** Seq of the first entry whose hash does not validate, if any. */
  brokenAtSeq: number | null;
  /**
   * Whether a head anchor was present. When false on a non-empty timeline, tail
   * truncation is undetectable from the DB alone (the anchor may be absent
   * because the board predates anchoring, or because it was deleted) — callers
   * should present this as "links intact but unanchored", not a clean pass.
   */
  anchored: boolean;
}

export type PolicyViolationKind =
  "unreviewed" | "unattributed" | "chain-broken";

export interface PolicyViolation {
  kind: PolicyViolationKind;
  commit: string | null;
  detail: string;
}

/** Outcome of a governance check — the basis for a CI gate. */
export interface PolicyResult {
  ok: boolean;
  violations: PolicyViolation[];
  chain: ChainVerification | null;
  /** How many commits were in scope for review checks. */
  checked: number;
}

export interface PolicyOptions {
  /** Explicit commit scope (e.g. a PR's `main..HEAD` shas). */
  commits?: string[];
  /** Fail if any AI-produced commit in scope lacks a human review. */
  requireHumanReview?: boolean;
  /** Fail if any explicitly-scoped commit has no attribution at all. */
  requireAttribution?: boolean;
  /** Fail if the timeline hash chain does not verify. */
  verifyChain?: boolean;
}

/** Schema tag for the portable attribution bundle. Bump on breaking changes. */
export const BUNDLE_VERSION = "octopus-blackboard/attribution-bundle@1";

/** A portable bundle of attribution that travels with (but outside) Git. */
export interface AttributionBundle {
  version: string;
  exportedAt: string;
  attributions: Attribution[];
  reviews: Review[];
  sessions: Session[];
  decisions: Decision[];
  /** Ed25519 signature (base64) over the bundle's records, if signed on export. */
  signature?: string | null;
  /** PEM public key that produced `signature`. */
  signedBy?: string | null;
  /** Session id that signed the bundle. */
  signedSession?: string | null;
}

/** Aggregate scorecard for a board — the `report` view. */
export interface Report {
  attributions: { total: number; ai: number; human: number };
  commits: {
    total: number;
    aiProduced: number;
    humanReviewed: number;
    unreviewed: number;
  };
  /**
   * Fraction (0..1) of AI-produced commits with an approved human review, or
   * `null` when there is no AI work to review (N/A — not 100%).
   */
  reviewCoverage: number | null;
  aiHumanRatio: { ai: number; human: number };
  perAgent: {
    agent: string;
    actorType: string;
    attributions: number;
    commits: number;
    files: number;
  }[];
  sessions: { total: number; open: number };
  risks: { open: number };
}

/**
 * The blackboard. A thin, synchronous wrapper over a SQLite database. Every
 * mutation also appends one tamper-evident entry to the timeline within the
 * same transaction, so the board and its audit log can never diverge.
 *
 * The board is deliberately passive: it records and reports. It never triggers
 * an agent, schedules work, or decides anything on an agent's behalf.
 */
export class Board {
  readonly config: BoardConfig;
  private readonly db: Database.Database;
  /** Active session id for the acting agent; stamped onto every write. */
  private activeSession: string | null;

  constructor(config: BoardConfig) {
    this.config = config;
    this.db = openDb(config.dbPath);
    // An explicit env/flag session wins; otherwise resolve the agent's active
    // session from the DB (set transactionally by session start/stop).
    this.activeSession =
      config.sessionId ?? this.currentSessionFromDb(config.agent);
  }

  private currentSessionFromDb(agent: string): string | null {
    const row = this.db
      .prepare("SELECT session_id FROM current_sessions WHERE agent = ?")
      .get(agent) as { session_id: string } | undefined;
    return row?.session_id ?? null;
  }

  /** The active session id for this board's agent (null if none). */
  activeSessionId(): string | null {
    return this.activeSession;
  }

  static open(overrides: ConfigOverrides = {}): Board {
    return new Board(loadConfig(overrides));
  }

  close(): void {
    this.db.close();
  }

  // --- timeline (hash chain) -------------------------------------------------

  private headHash(): { seq: number; hash: string } {
    const row = this.db
      .prepare("SELECT seq, hash FROM timeline ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;
    return row
      ? { seq: row.seq, hash: row.hash }
      : { seq: 0, hash: GENESIS_HASH };
  }

  private static computeHash(e: {
    seq: number;
    at: string;
    actor: string;
    sessionId: string | null;
    kind: string;
    refTable: string | null;
    refId: string | null;
    summary: string;
    payload: unknown;
    prevHash: string;
  }): string {
    const canonical = JSON.stringify([
      e.seq,
      e.at,
      e.actor,
      e.sessionId,
      e.kind,
      e.refTable,
      e.refId,
      e.summary,
      e.payload ?? null,
      e.prevHash,
    ]);
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** Append one entry to the timeline. Must run inside a transaction. */
  private append(
    actor: string,
    kind: string,
    summary: string,
    refTable: string | null,
    refId: string | null,
    payload: unknown,
  ): TimelineEvent {
    const head = this.headHash();
    const seq = head.seq + 1;
    const at = now();
    const event = {
      id: id(),
      seq,
      at,
      actor,
      sessionId: this.activeSession,
      kind,
      refTable,
      refId,
      summary,
      payload: payload ?? null,
      prevHash: head.hash,
      hash: "",
    };
    event.hash = Board.computeHash(event);
    this.db
      .prepare(
        `INSERT INTO timeline (id, seq, at, actor, session_id, kind, ref_table, ref_id, summary, payload, prev_hash, hash)
         VALUES (@id, @seq, @at, @actor, @sessionId, @kind, @refTable, @refId, @summary, @payload, @prevHash, @hash)`,
      )
      .run({
        ...event,
        payload: event.payload === null ? null : JSON.stringify(event.payload),
      });
    // Anchor the head (seq + hash) so tail truncation is detectable: deleting
    // the newest rows leaves an internally-consistent chain, but no longer
    // matches the recorded head. Same transaction as the insert.
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('head_seq', @seq), ('head_hash', @hash) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run({ seq: String(event.seq), hash: event.hash });
    return event;
  }

  /** The current timeline head (seq + hash). Record this OUTSIDE the DB — in a
   *  commit, a log, a second machine — to anchor against tail truncation. */
  head(): { seq: number; hash: string } {
    return this.headHash();
  }

  /**
   * Check the chain against an anchor recorded earlier (e.g. committed to git).
   * `ok` = the anchored row still exists with that hash and history through it
   * is intact; `truncated` = rows at/below the anchor were deleted; `altered` =
   * history at/below the anchor was edited. This is what closes the "attacker
   * drops the trigger and truncates" gap — an external anchor makes truncation
   * provable.
   */
  verifyAnchor(
    seq: number,
    hash: string,
  ): { status: "ok" | "truncated" | "altered"; headSeq: number } {
    const chain = this.verifyChain();
    const headSeq = this.headHash().seq;
    if (headSeq < seq) {
      return { status: "truncated", headSeq };
    }
    const row = this.db
      .prepare("SELECT hash FROM timeline WHERE seq = ?")
      .get(seq) as { hash: string } | undefined;
    if (!row) {
      return { status: "truncated", headSeq };
    }
    if (row.hash !== hash) {
      return { status: "altered", headSeq };
    }
    if (!chain.ok && chain.brokenAtSeq !== null && chain.brokenAtSeq <= seq) {
      return { status: "altered", headSeq };
    }
    return { status: "ok", headSeq };
  }

  private headAnchor(): { seq: number; hash: string } | null {
    const rows = this.db
      .prepare(
        "SELECT key, value FROM meta WHERE key IN ('head_seq','head_hash')",
      )
      .all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const seq = map.get("head_seq");
    const hash = map.get("head_hash");
    return seq !== undefined && hash !== undefined
      ? { seq: Number(seq), hash }
      : null;
  }

  /** Re-walk the chain and confirm every hash links to its predecessor. */
  verifyChain(): ChainVerification {
    const rows = this.db
      .prepare("SELECT * FROM timeline ORDER BY seq ASC")
      .all() as any[];
    const anchor = this.headAnchor();
    const anchored = anchor !== null;
    let prevHash = GENESIS_HASH;
    let prevSeq = 0;
    for (const row of rows) {
      // Contiguity: seq must increment by exactly 1 (catches a missing middle
      // row even before the hash check).
      if (row.seq !== prevSeq + 1) {
        return {
          ok: false,
          length: rows.length,
          brokenAtSeq: row.seq,
          anchored,
        };
      }
      const recomputed = Board.computeHash({
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        sessionId: row.session_id,
        kind: row.kind,
        refTable: row.ref_table,
        refId: row.ref_id,
        summary: row.summary,
        payload: row.payload === null ? null : JSON.parse(row.payload),
        prevHash,
      });
      if (row.prev_hash !== prevHash || row.hash !== recomputed) {
        return {
          ok: false,
          length: rows.length,
          brokenAtSeq: row.seq,
          anchored,
        };
      }
      prevHash = row.hash;
      prevSeq = row.seq;
    }
    // Tail-truncation check against the recorded head anchor. When no anchor is
    // present on a non-empty timeline (legacy board, OR a deleted anchor), tail
    // truncation cannot be detected from the DB alone — reported via `anchored`
    // so callers don't present it as a clean pass.
    if (anchor) {
      const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0;
      const lastHash =
        rows.length > 0 ? rows[rows.length - 1].hash : GENESIS_HASH;
      if (lastSeq !== anchor.seq || lastHash !== anchor.hash) {
        return {
          ok: false,
          length: rows.length,
          brokenAtSeq: anchor.seq,
          anchored,
        };
      }
    }
    return { ok: true, length: rows.length, brokenAtSeq: null, anchored };
  }

  timeline(limit = 50): TimelineEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM timeline ORDER BY seq DESC LIMIT ?")
      .all(limit) as any[];
    return this.applyRedactions(rows.map(rowToTimeline).reverse());
  }

  /** The current head sequence number (0 if the board is empty). */
  headSeq(): number {
    return this.headHash().seq;
  }

  /** Timeline events after `afterSeq`, oldest first — the polling primitive
   *  behind `watch`/`subscribe`. Passive: callers poll; the board never pushes. */
  since(afterSeq: number): TimelineEvent[] {
    return this.applyRedactions(
      (
        this.db
          .prepare("SELECT * FROM timeline WHERE seq > ? ORDER BY seq ASC")
          .all(afterSeq) as any[]
      ).map(rowToTimeline),
    );
  }

  /**
   * Filter events down to those an agent should be notified about: messages to
   * it (or broadcast), handoffs to it, and claim conflicts on keys it holds. An
   * agent's own actions are excluded. This is what makes `watch --for <agent>`
   * a useful inbox rather than a firehose.
   */
  notable(events: TimelineEvent[], agent: string): TimelineEvent[] {
    return events.filter((e) => {
      if (e.actor === agent) {
        return false;
      }
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      switch (e.kind) {
        case "message":
          return payload.to === agent || payload.to === null;
        case "claim":
          return payload.conflict === agent;
        case "handoff": {
          if (!e.refId) {
            return false;
          }
          const row = this.db
            .prepare("SELECT to_agent FROM handoffs WHERE id = ?")
            .get(e.refId) as { to_agent: string } | undefined;
          return row?.to_agent === agent;
        }
        default:
          return false;
      }
    });
  }

  // --- agents ----------------------------------------------------------------

  /**
   * Register the agent if new and stamp `last_seen`. Idempotent by name. When
   * registering the acting agent, its full provider-independent identity
   * (provider/model/cli/version) is merged in; non-null fields never overwrite
   * with null, so a later bare touch cannot erase identity.
   */
  ensureAgent(name: string, identity?: Partial<AgentIdentity>): Agent {
    const id0 =
      identity ??
      (name === this.config.agent ? this.config.identity : undefined);
    const existing = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name) as any | undefined;
    const at = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET last_seen = ?,
             kind = COALESCE(?, kind), provider = COALESCE(?, provider),
             model = COALESCE(?, model), cli = COALESCE(?, cli), version = COALESCE(?, version)
           WHERE id = ?`,
        )
        .run(
          at,
          id0?.kind ?? null,
          id0?.provider ?? null,
          id0?.model ?? null,
          id0?.cli ?? null,
          id0?.version ?? null,
          existing.id,
        );
      return rowToAgent(
        this.db.prepare("SELECT * FROM agents WHERE id = ?").get(existing.id),
      );
    }
    const agent: Agent = {
      id: id(),
      name,
      kind: id0?.kind ?? null,
      provider: id0?.provider ?? null,
      model: id0?.model ?? null,
      cli: id0?.cli ?? null,
      version: id0?.version ?? null,
      createdAt: at,
      lastSeen: at,
    };
    this.db
      .prepare(
        "INSERT INTO agents (id, name, kind, provider, model, cli, version, created_at, last_seen) VALUES (@id, @name, @kind, @provider, @model, @cli, @version, @createdAt, @lastSeen)",
      )
      .run(agent);
    return agent;
  }

  getAgent(name: string): Agent | undefined {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ?")
      .get(name);
    return row ? rowToAgent(row) : undefined;
  }

  // --- sessions --------------------------------------------------------------

  /**
   * Open a new session for the acting agent and make it current (persisted in
   * the DB, so later CLI invocations attribute to it). Captures the machine and
   * repository context the session runs in.
   */
  startSession(label: string | null = null): Session {
    const sessionId = id();
    // Generate the session keypair up front; the private key stays local (in
    // the board's keys/ dir), only the public key is recorded on the session.
    const keypair = generateSessionKeypair();
    this.saveSessionKey(sessionId, keypair.privateKeyPem);
    const tx = this.db.transaction((): Session => {
      this.ensureAgent(this.config.agent);
      const at = now();
      const session: Session = {
        id: sessionId,
        agentName: this.config.agent,
        label,
        machine: hostname(),
        workingDirectory: process.cwd(),
        gitBranch: git.currentBranch() ?? null,
        repository: git.remoteUrl() ?? git.repoRoot() ?? null,
        publicKey: keypair.publicKeyPem,
        lastHeartbeat: at,
        startedAt: at,
        finishedAt: null,
      };
      this.db
        .prepare(
          `INSERT INTO sessions (id, agent_name, label, machine, working_directory, git_branch, repository, public_key, last_heartbeat, started_at, finished_at)
           VALUES (@id, @agentName, @label, @machine, @workingDirectory, @gitBranch, @repository, @publicKey, @lastHeartbeat, @startedAt, @finishedAt)`,
        )
        .run(session);
      // Stamp subsequent events (including this one) with the new session, and
      // record the pointer transactionally so concurrent CLIs can't race it.
      this.activeSession = session.id;
      this.db
        .prepare(
          "INSERT OR REPLACE INTO current_sessions (agent, session_id) VALUES (?, ?)",
        )
        .run(this.config.agent, session.id);
      this.append(
        this.config.agent,
        "session-start",
        `session started${label ? ` (${label})` : ""}`,
        "sessions",
        session.id,
        { machine: session.machine, gitBranch: session.gitBranch },
      );
      return session;
    });
    return tx.immediate();
  }

  // --- session signing (v0) --------------------------------------------------

  private keyPath(sessionId: string): string {
    return join(this.config.boardDir, "keys", `${sessionId}.key`);
  }

  private saveSessionKey(sessionId: string, privateKeyPem: string): void {
    const path = this.keyPath(sessionId);
    // 0700 dir + 0600 file: private keys are not listable/readable by other
    // local users.
    mkdirSync(join(this.config.boardDir, "keys"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(path, privateKeyPem, { mode: 0o600 });
  }

  private loadSessionKey(sessionId: string): string | undefined {
    const path = this.keyPath(sessionId);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  }

  /**
   * Sign the current timeline head hash with a session's private key. The
   * signature attests "this session vouches for board state through seq N".
   * Recorded in the `signatures` table (not the chain, so the head stays put).
   */
  signHead(
    sessionId?: string,
  ): { headSeq: number; headHash: string } | undefined {
    const sid = sessionId ?? this.activeSession;
    if (!sid) {
      return undefined;
    }
    const priv = this.loadSessionKey(sid);
    const session = this.getSession(sid);
    if (!priv || !session?.publicKey) {
      return undefined;
    }
    const head = this.headHash();
    if (head.seq === 0) {
      return undefined;
    }
    const signature = signHash(priv, head.hash);
    this.db
      .prepare(
        `INSERT INTO signatures (id, session_id, head_seq, head_hash, signature, public_key, created_at)
         VALUES (@id, @sessionId, @headSeq, @headHash, @signature, @publicKey, @createdAt)`,
      )
      .run({
        id: id(),
        sessionId: sid,
        headSeq: head.seq,
        headHash: head.hash,
        signature,
        publicKey: session.publicKey,
        createdAt: now(),
      });
    return { headSeq: head.seq, headHash: head.hash };
  }

  /**
   * Verify every recorded signature. `valid` = the signature checks out against
   * its public key. `current` = the signed head hash still matches the timeline
   * row at that seq (i.e. history below it was not altered/truncated since).
   */
  verifySignatures(chain?: ChainVerification): {
    sessionId: string;
    agent: string | null;
    headSeq: number;
    valid: boolean;
    current: boolean;
    at: string;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM signatures ORDER BY head_seq ASC")
      .all() as any[];
    if (rows.length === 0) {
      return [];
    }
    // A signature only "covers" its head if the chain is actually intact up to
    // that seq — otherwise a tamper below the signed head (that leaves the head
    // row's stored hash untouched) would still read as trusted. Accept a
    // precomputed chain to avoid re-verifying the whole timeline repeatedly.
    const verified = chain ?? this.verifyChain();
    return rows.map((r) => {
      const valid = verifyHash(r.public_key, r.head_hash, r.signature);
      const row = this.db
        .prepare("SELECT hash FROM timeline WHERE seq = ?")
        .get(r.head_seq) as { hash: string } | undefined;
      const chainOkThroughHead =
        verified.ok ||
        (verified.brokenAtSeq !== null && r.head_seq < verified.brokenAtSeq);
      const session = this.getSession(r.session_id);
      return {
        sessionId: r.session_id,
        agent: session?.agentName ?? null,
        headSeq: r.head_seq,
        valid,
        current: row?.hash === r.head_hash && chainOkThroughHead,
        at: r.created_at,
      };
    });
  }

  /** Highest seq that a valid, still-current signature vouches for (0 = none). */
  signedThrough(chain?: ChainVerification): number {
    return this.verifySignatures(chain)
      .filter((s) => s.valid && s.current)
      .reduce((max, s) => Math.max(max, s.headSeq), 0);
  }

  /** Close a session (the active one by default) and clear the pointer. */
  stopSession(sessionId?: string): Session | undefined {
    const target = sessionId ?? this.activeSession;
    if (!target) {
      return undefined;
    }
    const tx = this.db.transaction((): Session | undefined => {
      const existing = this.getSession(target);
      if (!existing) {
        return undefined;
      }
      const at = now();
      this.db
        .prepare("UPDATE sessions SET finished_at = ? WHERE id = ?")
        .run(at, target);
      this.activeSession = target;
      // Clear the pointer transactionally (only if it still points here, so a
      // concurrent new session for the same agent is not clobbered).
      this.db
        .prepare(
          "DELETE FROM current_sessions WHERE agent = ? AND session_id = ?",
        )
        .run(existing.agentName ?? this.config.agent, target);
      this.append(
        existing.agentName ?? this.config.agent,
        "session-stop",
        "session stopped",
        "sessions",
        target,
        null,
      );
      return this.getSession(target);
    });
    const session = tx.immediate();
    if (session) {
      // Sign the head (now including the session-stop event) so the session's
      // final state is vouched for. Best-effort: never fails a stop.
      try {
        this.signHead(target);
      } catch {
        /* signing is advisory in v0 */
      }
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    return row ? rowToSession(row) : undefined;
  }

  listSessions(limit = 30): Session[] {
    return (
      this.db
        .prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?")
        .all(limit) as any[]
    ).map(rowToSession);
  }

  /** All timeline events belonging to a session, oldest first. */
  sessionTimeline(sessionId: string): TimelineEvent[] {
    return this.applyRedactions(
      (
        this.db
          .prepare(
            "SELECT * FROM timeline WHERE session_id = ? ORDER BY seq ASC",
          )
          .all(sessionId) as any[]
      ).map(rowToTimeline),
    );
  }

  listAgents(): Agent[] {
    return (
      this.db
        .prepare("SELECT * FROM agents ORDER BY last_seen DESC")
        .all() as any[]
    ).map(rowToAgent);
  }

  // --- writes (each is one transaction: entity + timeline entry) -------------

  /** A free-form status note broadcast to the board. */
  note(actor: string, text: string): TimelineEvent {
    const tx = this.db.transaction(() => {
      this.ensureAgent(actor);
      return this.append(actor, "note", text, null, null, null);
    });
    return tx.immediate();
  }

  /**
   * Claim a task by key, creating it if absent. If another agent already holds
   * an unreleased claim, the claim still records but `conflict` names the
   * holder — the board surfaces the collision rather than blocking it.
   */
  claim(actor: string, key: string, title: string | null = null): ClaimResult {
    const tx = this.db.transaction((): ClaimResult => {
      this.ensureAgent(actor);
      const at = now();
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE key = ?")
        .get(key) as any | undefined;
      let conflict: string | null = null;
      let task: Task;
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO tasks (id, key, number, title, status, created_by, claimed_by, claimed_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)`,
          )
          .run(
            id(),
            key,
            this.nextTaskNumber(),
            title,
            actor,
            actor,
            at,
            at,
            at,
          );
        task = rowToTask(
          this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key),
        );
      } else {
        if (
          existing.claimed_by &&
          existing.claimed_by !== actor &&
          !existing.released_at
        ) {
          conflict = existing.claimed_by;
        }
        this.db
          .prepare(
            "UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, released_at = NULL, title = COALESCE(?, title), updated_at = ? WHERE key = ?",
          )
          .run(actor, at, title, at, key);
        task = rowToTask(
          this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key),
        );
      }
      const summary = conflict
        ? `claimed "${key}" (CONFLICT: also held by ${conflict})`
        : `claimed "${key}"`;
      this.append(actor, "claim", summary, "tasks", task.id, { key, conflict });
      return { task, conflict };
    });
    return tx.immediate();
  }

  /** Release a claim the actor holds. */
  release(actor: string, key: string): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      const at = now();
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE key = ?")
        .get(key) as any | undefined;
      if (!existing) {
        return undefined;
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'open', released_at = ?, claimed_by = NULL, updated_at = ? WHERE key = ?",
        )
        .run(at, at, key);
      const task = rowToTask(
        this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key),
      );
      this.append(actor, "release", `released "${key}"`, "tasks", task.id, {
        key,
      });
      return task;
    });
    return tx.immediate();
  }

  /** Mark a task done. */
  complete(actor: string, key: string): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      const at = now();
      const existing = this.db
        .prepare("SELECT * FROM tasks WHERE key = ?")
        .get(key) as any | undefined;
      if (!existing) {
        return undefined;
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'done', updated_at = ? WHERE key = ?",
        )
        .run(at, key);
      const task = rowToTask(
        this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key),
      );
      this.append(actor, "complete", `completed "${key}"`, "tasks", task.id, {
        key,
      });
      return task;
    });
    return tx.immediate();
  }

  listTasks(status?: string): Task[] {
    const rows = status
      ? (this.db
          .prepare(
            "SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC",
          )
          .all(status) as any[])
      : (this.db
          .prepare("SELECT * FROM tasks ORDER BY updated_at DESC")
          .all() as any[]);
    return rows.map(rowToTask);
  }

  // --- tasks (kanban) --------------------------------------------------------

  private nextTaskNumber(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks")
      .get() as { n: number };
    return row.n;
  }

  getTask(key: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key);
    return row ? rowToTask(row) : undefined;
  }

  /** Resolve a task by key OR by its human number (`"145"` / `"#145"`). */
  resolveTask(ref: string): Task | undefined {
    const m = /^#?(\d+)$/.exec(ref.trim());
    if (m) {
      const row = this.db
        .prepare("SELECT * FROM tasks WHERE number = ?")
        .get(Number(m[1]));
      if (row) return rowToTask(row);
    }
    return this.getTask(ref);
  }

  /**
   * Create or update a task's kanban fields (title, description, project,
   * impact/blast-radius, risk level). Creates the task (with a fresh number) if
   * the key is new; otherwise updates only the provided fields.
   */
  defineTask(
    actor: string,
    key: string,
    opts: {
      title?: string | null;
      description?: string | null;
      project?: string | null;
      impact?: string | null;
      riskLevel?: RiskLevel | null;
    } = {},
  ): Task {
    const tx = this.db.transaction((): Task => {
      this.ensureAgent(actor);
      const at = now();
      const existing = this.getTask(key);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO tasks (id, key, number, title, description, status, project, impact, risk_level, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id(),
            key,
            this.nextTaskNumber(),
            opts.title ?? null,
            opts.description ?? null,
            opts.project ?? null,
            opts.impact ?? null,
            opts.riskLevel ?? null,
            actor,
            at,
            at,
          );
      } else {
        this.db
          .prepare(
            `UPDATE tasks SET title = COALESCE(?, title), description = COALESCE(?, description),
               project = COALESCE(?, project), impact = COALESCE(?, impact),
               risk_level = COALESCE(?, risk_level), updated_at = ? WHERE key = ?`,
          )
          .run(
            opts.title ?? null,
            opts.description ?? null,
            opts.project ?? null,
            opts.impact ?? null,
            opts.riskLevel ?? null,
            at,
            key,
          );
      }
      const task = this.getTask(key)!;
      this.append(
        actor,
        "task",
        `defined task #${task.number} "${key}"`,
        "tasks",
        task.id,
        { key },
      );
      return task;
    });
    return tx.immediate();
  }

  /**
   * Assign a task to an agent and notify them — records the assignee AND drops a
   * message in that agent's inbox ("please look at task #145 …"). This is the
   * passive form of "notify Claude to look at 145": the board records the ask;
   * the agent reads its inbox and decides to act. The board never launches it.
   */
  assign(actor: string, key: string, toAgent: string): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      this.ensureAgent(toAgent);
      const task = this.getTask(key);
      if (!task) {
        return undefined;
      }
      const at = now();
      this.db
        .prepare(
          "INSERT OR IGNORE INTO task_assignees (task_key, agent, assigned_by, assigned_at) VALUES (?, ?, ?, ?)",
        )
        .run(key, toAgent, actor, at);
      // The notification: a message in the assignee's inbox.
      const label = `task #${task.number}${task.title ? ` "${task.title}"` : ` (${key})`}`;
      const where = task.project ? ` · project ${task.project}` : "";
      const risk = task.riskLevel ? ` · risk ${task.riskLevel}` : "";
      this.message(actor, toAgent, `please look at ${label}${where}${risk}`);
      this.append(
        actor,
        "assign",
        `assigned ${label} → ${toAgent}`,
        "tasks",
        task.id,
        {
          key,
          to: toAgent,
        },
      );
      return this.getTask(key);
    });
    return tx.immediate();
  }

  /** Report progress (0–100). Moves status to in-progress, or done at 100. */
  setProgress(actor: string, key: string, progress: number): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      const task = this.getTask(key);
      if (!task) {
        return undefined;
      }
      const p = Math.max(0, Math.min(100, Math.round(progress)));
      const status =
        p >= 100
          ? "done"
          : p > 0 && (task.status === "open" || task.status === "claimed")
            ? "in-progress"
            : task.status;
      this.db
        .prepare(
          "UPDATE tasks SET progress = ?, status = ?, updated_at = ? WHERE key = ?",
        )
        .run(p, status, now(), key);
      this.append(
        actor,
        "progress",
        `task #${task.number} "${key}" → ${p}%`,
        "tasks",
        task.id,
        { key, progress: p },
      );
      return this.getTask(key);
    });
    return tx.immediate();
  }

  /** Set a task's status directly (e.g. blocked). */
  setTaskStatus(
    actor: string,
    key: string,
    status: TaskStatus,
  ): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      const task = this.getTask(key);
      if (!task) {
        return undefined;
      }
      this.db
        .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE key = ?")
        .run(status, now(), key);
      this.append(
        actor,
        "task-status",
        `task #${task.number} "${key}" → ${status}`,
        "tasks",
        task.id,
        { key, status },
      );
      return this.getTask(key);
    });
    return tx.immediate();
  }

  assigneesFor(key: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT agent FROM task_assignees WHERE task_key = ? ORDER BY assigned_at ASC",
        )
        .all(key) as { agent: string }[]
    ).map((r) => r.agent);
  }

  private risksForTask(key: string): Risk[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM risks WHERE task_key = ? ORDER BY created_at DESC",
        )
        .all(key) as any[]
    ).map(rowToRisk);
  }

  /**
   * How many agents are actively working the task right now: assignees (or the
   * claimer) that have an active (heartbeating) session.
   */
  private activeAgentsOnTask(key: string): number {
    const active = new Set(this.activeSessions().map((s) => s.agentName));
    const involved = new Set(this.assigneesFor(key));
    const claimer = this.getTask(key)?.claimedBy;
    if (claimer) involved.add(claimer);
    return [...involved].filter((a) => active.has(a)).length;
  }

  /** Full kanban card for one task. */
  taskCard(key: string): TaskCard | undefined {
    const task = this.getTask(key);
    if (!task) {
      return undefined;
    }
    return {
      task,
      assignees: this.assigneesFor(key),
      activeAgents: this.activeAgentsOnTask(key),
      impactFiles: [...new Set(this.filesForTask(key).map((f) => f.path))],
      risks: this.risksForTask(key),
    };
  }

  /** Every task as a kanban card, newest-updated first. */
  listTaskCards(): TaskCard[] {
    return this.readSnapshot(() =>
      this.listTasks()
        .map((t) => this.taskCard(t.key))
        .filter((c): c is TaskCard => c !== undefined),
    );
  }

  /** Leave a message for another agent, or broadcast (to = null). */
  message(actor: string, to: string | null, body: string): Message {
    const tx = this.db.transaction((): Message => {
      this.ensureAgent(actor);
      if (to) {
        this.ensureAgent(to);
      }
      const at = now();
      const msg: Message = {
        id: id(),
        fromAgent: actor,
        toAgent: to,
        body,
        createdAt: at,
        readAt: null,
      };
      this.db
        .prepare(
          "INSERT INTO messages (id, from_agent, to_agent, body, created_at, read_at) VALUES (@id, @fromAgent, @toAgent, @body, @createdAt, @readAt)",
        )
        .run(msg);
      // Metadata-only summary: the message BODY lives only in messages.body
      // (which redact() blanks), never in the hashed, append-only timeline — so
      // redacting a message truly erases its content from all storage. The
      // timeline still records who messaged whom, and when.
      const dest = to ? `→ ${to}` : "(broadcast)";
      this.append(actor, "message", `message ${dest}`, "messages", msg.id, {
        to,
      });
      return msg;
    });
    return tx.immediate();
  }

  /** Messages addressed to `agent` (or broadcast) that are still unread. */
  inbox(agent: string, includeRead = false): Message[] {
    // UNION ALL of two disjoint branches (direct vs broadcast) so each can use
    // idx_messages_to; a single `to_agent = ? OR to_agent IS NULL` predicate
    // would force a full table scan.
    const sql = includeRead
      ? `SELECT * FROM messages WHERE to_agent = ?
         UNION ALL SELECT * FROM messages WHERE to_agent IS NULL
         ORDER BY created_at DESC`
      : `SELECT * FROM messages WHERE to_agent = ? AND read_at IS NULL
         UNION ALL SELECT * FROM messages WHERE to_agent IS NULL AND read_at IS NULL
         ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(agent) as any[]).map(rowToMessage);
  }

  markRead(messageId: string): void {
    this.db
      .prepare("UPDATE messages SET read_at = ? WHERE id = ?")
      .run(now(), messageId);
  }

  decision(
    actor: string,
    title: string,
    opts: {
      rationale?: string | null;
      evidence?: string | null;
      relatedCommits?: string[];
      relatedTasks?: string[];
    } = {},
  ): Decision {
    const tx = this.db.transaction((): Decision => {
      this.ensureAgent(actor);
      const dec: Decision = {
        id: id(),
        agentId: actor,
        sessionId: this.activeSession,
        title,
        rationale: opts.rationale ?? null,
        evidence: opts.evidence ?? null,
        relatedCommits: opts.relatedCommits ?? [],
        relatedTasks: opts.relatedTasks ?? [],
        createdAt: now(),
      };
      this.db
        .prepare(
          `INSERT INTO decisions (id, agent_id, session_id, title, rationale, evidence, related_commits, related_tasks, created_at)
           VALUES (@id, @agentId, @sessionId, @title, @rationale, @evidence, @relatedCommits, @relatedTasks, @createdAt)`,
        )
        .run({
          ...dec,
          relatedCommits: JSON.stringify(dec.relatedCommits),
          relatedTasks: JSON.stringify(dec.relatedTasks),
        });
      // The free-text rationale lives only in decisions.rationale (redactable);
      // the timeline keeps the (short) title + related commits, not the rationale.
      this.append(actor, "decision", `decided: ${title}`, "decisions", dec.id, {
        relatedCommits: dec.relatedCommits,
      });
      return dec;
    });
    return tx.immediate();
  }

  decisionsForCommit(commitSha: string): Decision[] {
    // A stored related-commit `c` matches when it is a prefix of the query sha
    // (or vice-versa), but only if it is at least a git short-sha (7 chars) —
    // this rejects false positives from empty strings (which prefix-match every
    // commit) and 1–2 char typos. Non-string elements are coerced defensively.
    const matches = (c: unknown, sha: string): boolean => {
      const s = String(c);
      if (s.length < 7) {
        return s.length === sha.length && s === sha; // only an exact full match
      }
      return s.startsWith(sha) || sha.startsWith(s);
    };
    return (
      this.db
        .prepare("SELECT * FROM decisions ORDER BY created_at DESC")
        .all() as any[]
    )
      .map(rowToDecision)
      .filter((d) => d.relatedCommits.some((c) => matches(c, commitSha)));
  }

  evidence(
    actor: string,
    ref: string,
    note: string | null = null,
    target: string | null = null,
  ): Evidence {
    // Content-address the evidence when it is a readable local file, so the
    // referenced content is integrity-protected: a later swap/edit of the file
    // is detectable via verifyEvidence(). URLs / non-files store sha256 = null.
    const sha256 = Board.hashFileIfLocal(ref);
    const tx = this.db.transaction((): Evidence => {
      this.ensureAgent(actor);
      const ev: Evidence = {
        id: id(),
        agentId: actor,
        ref,
        note,
        target,
        sha256,
        createdAt: now(),
      };
      this.db
        .prepare(
          "INSERT INTO evidence (id, agent_id, ref, note, target, sha256, created_at) VALUES (@id, @agentId, @ref, @note, @target, @sha256, @createdAt)",
        )
        .run(ev);
      this.append(
        actor,
        "evidence",
        `evidence: ${ref}${sha256 ? ` (sha256 ${sha256.slice(0, 12)})` : ""}`,
        "evidence",
        ev.id,
        { target, sha256 },
      );
      return ev;
    });
    return tx.immediate();
  }

  /** SHA-256 of a local file's content, or null if `ref` is not a readable file. */
  private static hashFileIfLocal(ref: string): string | null {
    try {
      if (!existsSync(ref) || !statSync(ref).isFile()) {
        return null;
      }
      return createHash("sha256").update(readFileSync(ref)).digest("hex");
    } catch {
      return null;
    }
  }

  /**
   * Re-check every content-hashed evidence file against its attach-time hash.
   * `ok` = unchanged, `changed` = content differs (tampered/edited), `missing`
   * = the file is gone, `unhashed` = a URL / non-file (never hashed).
   */
  verifyEvidence(): EvidenceCheck[] {
    const rows = this.db
      .prepare("SELECT id, ref, sha256 FROM evidence ORDER BY created_at ASC")
      .all() as { id: string; ref: string; sha256: string | null }[];
    return rows.map(({ id, ref, sha256 }) => {
      let status: EvidenceStatus;
      if (sha256 === null) {
        status = "unhashed";
      } else if (!existsSync(ref) || !statSync(ref).isFile()) {
        status = "missing";
      } else {
        const now256 = createHash("sha256")
          .update(readFileSync(ref))
          .digest("hex");
        status = now256 === sha256 ? "ok" : "changed";
      }
      return { id, ref, status };
    });
  }

  fileChanged(
    actor: string,
    path: string,
    change: FileChangeKind,
    taskKey: string | null = null,
  ): FileChange {
    const tx = this.db.transaction((): FileChange => {
      this.ensureAgent(actor);
      const fc: FileChange = {
        id: id(),
        agentId: actor,
        sessionId: this.activeSession,
        path,
        change,
        taskKey,
        createdAt: now(),
      };
      this.db
        .prepare(
          "INSERT INTO files_changed (id, agent_id, session_id, path, change, task_key, created_at) VALUES (@id, @agentId, @sessionId, @path, @change, @taskKey, @createdAt)",
        )
        .run(fc);
      this.append(actor, "file", `${change}: ${path}`, "files_changed", fc.id, {
        taskKey,
      });
      return fc;
    });
    return tx.immediate();
  }

  /** Files another agent reports touching for a task — conflict awareness. */
  filesForTask(taskKey: string): FileChange[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM files_changed WHERE task_key = ? ORDER BY created_at DESC",
        )
        .all(taskKey) as any[]
    ).map(rowToFileChange);
  }

  risk(
    actor: string,
    title: string,
    severity: RiskSeverity = "medium",
    taskKey: string | null = null,
  ): Risk {
    const tx = this.db.transaction((): Risk => {
      this.ensureAgent(actor);
      const r: Risk = {
        id: id(),
        agentId: actor,
        title,
        severity,
        status: "open",
        taskKey,
        createdAt: now(),
      };
      this.db
        .prepare(
          "INSERT INTO risks (id, agent_id, title, severity, status, task_key, created_at) VALUES (@id, @agentId, @title, @severity, @status, @taskKey, @createdAt)",
        )
        .run(r);
      const on = taskKey ? ` (task ${taskKey})` : "";
      this.append(
        actor,
        "risk",
        `risk [${severity}]: ${title}${on}`,
        "risks",
        r.id,
        null,
      );
      return r;
    });
    return tx.immediate();
  }

  listRisks(status: string | null = "open"): Risk[] {
    const rows = status
      ? (this.db
          .prepare(
            "SELECT * FROM risks WHERE status = ? ORDER BY created_at DESC",
          )
          .all(status) as any[])
      : (this.db
          .prepare("SELECT * FROM risks ORDER BY created_at DESC")
          .all() as any[]);
    return rows.map(rowToRisk);
  }

  handoff(
    actor: string,
    to: string,
    summary: string,
    opts: {
      context?: string | null;
      relatedFiles?: string[];
      openQuestions?: string[];
      taskKey?: string | null;
    } = {},
  ): Handoff {
    const tx = this.db.transaction((): Handoff => {
      this.ensureAgent(actor);
      this.ensureAgent(to);
      const h: Handoff = {
        id: id(),
        fromAgent: actor,
        toAgent: to,
        fromSession: this.activeSession,
        toSession: null,
        summary,
        context: opts.context ?? null,
        relatedFiles: opts.relatedFiles ?? [],
        openQuestions: opts.openQuestions ?? [],
        taskKey: opts.taskKey ?? null,
        createdAt: now(),
        acceptedAt: null,
      };
      this.db
        .prepare(
          `INSERT INTO handoffs (id, from_agent, to_agent, from_session, to_session, summary, context, related_files, open_questions, task_key, created_at, accepted_at)
           VALUES (@id, @fromAgent, @toAgent, @fromSession, @toSession, @summary, @context, @relatedFiles, @openQuestions, @taskKey, @createdAt, @acceptedAt)`,
        )
        .run({
          ...h,
          relatedFiles: JSON.stringify(h.relatedFiles),
          openQuestions: JSON.stringify(h.openQuestions),
        });
      this.append(
        actor,
        "handoff",
        `handoff → ${to}: ${summary}`,
        "handoffs",
        h.id,
        {
          taskKey: h.taskKey,
          openQuestions: h.openQuestions,
        },
      );
      return h;
    });
    return tx.immediate();
  }

  // --- attribution -----------------------------------------------------------

  /** Resolve the AI identity (agent + provider/model/cli) for a session. */
  private identityForSession(sessionId: string | null): {
    actor: string;
    provider: string | null;
    model: string | null;
    cli: string | null;
    sessionId: string | null;
  } {
    if (sessionId) {
      const s = this.getSession(sessionId);
      if (s) {
        const a = this.getAgent(s.agentName);
        return {
          actor: s.agentName,
          provider: a?.provider ?? null,
          model: a?.model ?? null,
          cli: a?.cli ?? null,
          sessionId,
        };
      }
    }
    return {
      actor: this.config.agent,
      provider: this.config.identity.provider,
      model: this.config.identity.model,
      cli: this.config.identity.cli,
      sessionId: this.activeSession,
    };
  }

  /** Record a single attribution — who actually produced a change. */
  attribute(
    commit: string,
    opts: {
      file?: string | null;
      hunk?: string | null;
      actorType?: ActorType;
      actor?: string;
      provider?: string | null;
      model?: string | null;
      cli?: string | null;
      sessionId?: string | null;
    } = {},
  ): Attribution {
    const sha = git.resolveRev(commit) ?? commit;
    const actorType = opts.actorType ?? "ai";
    const ident =
      actorType === "ai"
        ? this.identityForSession(opts.sessionId ?? this.activeSession)
        : {
            actor: this.config.agent,
            provider: null,
            model: null,
            cli: null,
            sessionId: opts.sessionId ?? null,
          };
    const attr: Attribution = {
      id: id(),
      commit: sha,
      file: opts.file ?? null,
      hunk: opts.hunk ?? null,
      actorType,
      actor: opts.actor ?? ident.actor,
      provider: opts.provider ?? ident.provider,
      model: opts.model ?? ident.model,
      cli: opts.cli ?? ident.cli,
      sessionId: opts.sessionId ?? ident.sessionId,
      createdAt: now(),
    };
    const tx = this.db.transaction(() => {
      this.insertAttribution(attr);
      const where = attr.file ? ` ${attr.file}` : "";
      this.append(
        attr.actor,
        "attribution",
        `${attr.actorType} produced ${sha.slice(0, 8)}${where}`,
        "attributions",
        attr.id,
        {
          commit: sha,
          file: attr.file,
        },
      );
    });
    tx.immediate();
    return attr;
  }

  private insertAttribution(attr: Attribution): void {
    this.db
      .prepare(
        `INSERT INTO attributions (id, commit_sha, file, hunk, actor_type, actor, provider, model, cli, session_id, created_at)
         VALUES (@id, @commit, @file, @hunk, @actorType, @actor, @provider, @model, @cli, @sessionId, @createdAt)`,
      )
      .run(attr);
  }

  /**
   * Associate a Git commit with the work that produced it. Resolves the rev to
   * a full sha, reads the files it touched from Git, and records one AI
   * attribution per file for the given (or active) session. Optionally writes
   * an additive `git notes` entry — Git history is never rewritten.
   */
  link(
    rev: string,
    opts: {
      sessionId?: string | null;
      actorType?: ActorType;
      actor?: string;
      writeNote?: boolean;
    } = {},
  ): { sha: string; files: string[]; count: number } | undefined {
    const sha = git.resolveRev(rev);
    if (!sha) {
      return undefined;
    }
    // Never attribute the board's own storage.
    const files = git
      .filesInCommit(sha)
      .filter((f) => !f.startsWith(".octoboard/"));
    const actorType = opts.actorType ?? "ai";
    const ident =
      actorType === "ai"
        ? this.identityForSession(opts.sessionId ?? this.activeSession)
        : {
            actor: opts.actor ?? this.config.agent,
            provider: null,
            model: null,
            cli: null,
            sessionId: opts.sessionId ?? null,
          };
    const targets = files.length > 0 ? files : [null];
    const tx = this.db.transaction(() => {
      for (const file of targets) {
        this.insertAttribution({
          id: id(),
          commit: sha,
          file,
          hunk: null,
          actorType,
          actor: opts.actor ?? ident.actor,
          provider: ident.provider,
          model: ident.model,
          cli: ident.cli,
          sessionId: ident.sessionId,
          createdAt: now(),
        });
      }
      // A link event spans N attribution rows, so it references the commit
      // itself (ref_table "commit"), not any single attribution row id.
      this.append(
        opts.actor ?? ident.actor,
        "link",
        `linked ${sha.slice(0, 8)} → ${actorType} ${opts.actor ?? ident.actor} (${targets.length} file${targets.length === 1 ? "" : "s"})`,
        "commit",
        sha,
        { sha, files },
      );
    });
    tx.immediate();
    if (opts.writeNote) {
      const label = `${ident.cli ?? ident.actor}${ident.model ? ` (${ident.model})` : ""}`;
      git.writeNote(
        sha,
        `blackboard: produced by ${label}, session ${ident.sessionId ?? "n/a"}`,
      );
    }
    return { sha, files, count: targets.length };
  }

  attributionsForCommit(commitSha: string): Attribution[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM attributions WHERE commit_sha = ? ORDER BY created_at ASC",
        )
        .all(commitSha) as any[]
    ).map(rowToAttribution);
  }

  attributionsForFile(file: string): Attribution[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM attributions WHERE file = ? ORDER BY created_at DESC",
        )
        .all(file) as any[]
    ).map(rowToAttribution);
  }

  /**
   * Attributions on a commit that concern a specific file — the rows whose
   * `file` matches (or is null, i.e. whole-commit). Falls back to all of the
   * commit's attributions if none name the file. Used by `blame`, so tracing a
   * line doesn't surface attributions for the commit's other files.
   */
  private attributionsForCommitFile(
    commitSha: string,
    file: string,
  ): Attribution[] {
    const all = this.attributionsForCommit(commitSha);
    const scoped = all.filter((a) => a.file === file || a.file === null);
    return scoped.length > 0 ? scoped : all;
  }

  // --- reviews ---------------------------------------------------------------

  /** Record who reviewed a commit and the outcome. */
  review(
    commit: string,
    opts: {
      reviewerType?: ReviewerType;
      reviewer?: string;
      outcome?: ReviewOutcome;
      note?: string | null;
      sessionId?: string | null;
    } = {},
  ): Review {
    const sha = git.resolveRev(commit) ?? commit;
    const rev: Review = {
      id: id(),
      commit: sha,
      reviewerType: opts.reviewerType ?? "ai",
      reviewer: opts.reviewer ?? this.config.agent,
      sessionId: opts.sessionId ?? this.activeSession,
      outcome: opts.outcome ?? "approved",
      note: opts.note ?? null,
      createdAt: now(),
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (id, commit_sha, reviewer_type, reviewer, session_id, outcome, note, created_at)
           VALUES (@id, @commit, @reviewerType, @reviewer, @sessionId, @outcome, @note, @createdAt)`,
        )
        .run(rev);
      this.append(
        rev.reviewer,
        "review",
        `${rev.reviewerType} review of ${sha.slice(0, 8)}: ${rev.outcome}`,
        "reviews",
        rev.id,
        { commit: sha, outcome: rev.outcome },
      );
    });
    tx.immediate();
    return rev;
  }

  reviewsForCommit(commitSha: string): Review[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM reviews WHERE commit_sha = ? ORDER BY created_at ASC",
        )
        .all(commitSha) as any[]
    ).map(rowToReview);
  }

  /** Handoffs left FOR an agent — "what was passed to me", newest first. */
  handoffsFor(toAgent: string): Handoff[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM handoffs WHERE to_agent = ? ORDER BY created_at DESC",
        )
        .all(toAgent) as any[]
    ).map(rowToHandoff);
  }

  // --- queries ---------------------------------------------------------------

  /**
   * Who touched a file: Git authors, distinct (session, agent) pairs that
   * recorded a change, and commit attributions. The `agent` is the actor name
   * recorded on the change; one entry per distinct (session, agent), collapsing
   * repeated edits within a session to a single row (its latest timestamp).
   */
  whoTouched(file: string): {
    gitAuthors: string[];
    attributions: Attribution[];
    sessions: { sessionId: string | null; agent: string; at: string }[];
  } {
    const rows = this.db
      .prepare(
        `SELECT session_id, agent_id, MAX(created_at) AS at FROM files_changed
         WHERE path = ?
         GROUP BY session_id, agent_id ORDER BY at DESC`,
      )
      .all(file) as any[];
    return {
      gitAuthors: git.fileAuthors(file),
      attributions: this.attributionsForFile(file),
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
        agent: r.agent_id,
        at: r.at,
      })),
    };
  }

  /**
   * Commits attributed to an actor, CLI, provider, or model (matched broadly
   * across those columns). Returns the actual matching attribution rows, so the
   * reported `actor`/`cli` always reflect a row that matched the query — never
   * an unrelated attribution on the same commit.
   */
  commitsByActor(
    query: string,
  ): { commit: string; actor: string; cli: string | null; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT commit_sha, actor, cli, created_at FROM attributions
         WHERE actor = ? OR cli = ? OR provider = ? OR model = ?
         ORDER BY created_at DESC`,
      )
      .all(query, query, query, query) as any[];
    // Collapse to one row per (commit, actor, cli); keep the earliest time.
    const seen = new Map<
      string,
      { commit: string; actor: string; cli: string | null; at: string }
    >();
    for (const r of rows) {
      const key = `${r.commit_sha} ${r.actor} ${r.cli ?? ""}`;
      const existing = seen.get(key);
      if (!existing || r.created_at < existing.at) {
        seen.set(key, {
          commit: r.commit_sha,
          actor: r.actor,
          cli: r.cli,
          at: r.created_at,
        });
      }
    }
    return [...seen.values()].sort((x, y) => (x.at < y.at ? 1 : -1));
  }

  /**
   * AI-attributed commits with no APPROVED human review — the accountability
   * gap. A commit reviewed but rejected/changes-requested is still unreviewed
   * for this purpose (sign-off was withheld), so it appears here.
   */
  unreviewedCommits(): { commit: string; actor: string; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT a.commit_sha, a.actor, MIN(a.created_at) AS at FROM attributions a
         WHERE a.actor_type = 'ai'
           AND NOT EXISTS (
             SELECT 1 FROM reviews r
             WHERE r.commit_sha = a.commit_sha AND r.reviewer_type = 'human' AND r.outcome = 'approved'
           )
         GROUP BY a.commit_sha ORDER BY at DESC`,
      )
      .all() as any[];
    return rows.map((r) => ({
      commit: r.commit_sha,
      actor: r.actor,
      at: r.at,
    }));
  }

  /**
   * Files touched by BOTH agents — joint-modification / collision surface.
   * Paths are normalized (leading `./` stripped) so a CLI-relative form and
   * git's repo-root form for the same file reconcile. Case and deeper path
   * differences are not reconciled.
   */
  jointFiles(agentA: string, agentB: string): string[] {
    const norm = (p: string): string => p.replace(/^\.\//, "");
    const filesOf = (agent: string): Set<string> => {
      const fc = this.db
        .prepare("SELECT DISTINCT path FROM files_changed WHERE agent_id = ?")
        .all(agent) as any[];
      const at = this.db
        .prepare(
          "SELECT DISTINCT file FROM attributions WHERE actor = ? AND file IS NOT NULL",
        )
        .all(agent) as any[];
      return new Set([
        ...fc.map((r) => norm(r.path)),
        ...at.map((r) => norm(r.file)),
      ]);
    };
    const a = filesOf(agentA);
    const b = filesOf(agentB);
    return [...a].filter((f) => b.has(f)).sort();
  }

  // --- governance (CI gate) --------------------------------------------------

  private distinctAttributedCommits(): string[] {
    return (
      this.db
        .prepare("SELECT DISTINCT commit_sha FROM attributions")
        .all() as any[]
    ).map((r) => r.commit_sha);
  }

  private hasAttribution(sha: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM attributions WHERE commit_sha = ? LIMIT 1")
        .get(sha) !== undefined
    );
  }

  // NB: the "approved human review" and "AI attribution" checks are now
  // expressed set-based inside report()/unreviewedCommits()/check() rather than
  // per-commit helpers, to avoid N+1 query loops.

  /**
   * Evaluate governance policy over a set of commits — the read-only basis for
   * a CI gate. The board only reports pass/fail and the specific violations; it
   * never blocks anything itself (the CI system decides what to do with a
   * non-zero result). This keeps the blackboard passive while still enabling
   * "no unreviewed AI work reaches main".
   */
  check(opts: PolicyOptions): PolicyResult {
    const violations: PolicyViolation[] = [];
    let chain: ChainVerification | null = null;

    if (opts.verifyChain) {
      chain = this.verifyChain();
      if (!chain.ok) {
        violations.push({
          kind: "chain-broken",
          commit: null,
          detail: `timeline hash chain broken at seq ${chain.brokenAtSeq}`,
        });
      }
    }

    // Attribution is required only for an explicit commit scope (otherwise the
    // "all attributed commits" scope trivially satisfies it).
    if (opts.requireAttribution && opts.commits) {
      for (const c of opts.commits) {
        if (!this.hasAttribution(c)) {
          violations.push({
            kind: "unattributed",
            commit: c,
            detail: "no attribution recorded for this commit",
          });
        }
      }
    }

    const scope = opts.commits ?? this.distinctAttributedCommits();
    if (opts.requireHumanReview) {
      // Set-based (was an N+1 of hasAiAttribution+hasHumanReview per commit):
      // unreviewedCommits() is the board-wide set of AI commits lacking an
      // approved human review; intersect it with the scope.
      const unreviewed = new Set(this.unreviewedCommits().map((c) => c.commit));
      for (const c of scope) {
        if (unreviewed.has(c)) {
          violations.push({
            kind: "unreviewed",
            commit: c,
            detail: "AI-produced commit has no approved human review",
          });
        }
      }
    }

    return {
      ok: violations.length === 0,
      violations,
      chain,
      checked: scope.length,
    };
  }

  // --- portability (export / import / trailers) ------------------------------

  private allAttributions(): Attribution[] {
    return (this.db.prepare("SELECT * FROM attributions").all() as any[]).map(
      rowToAttribution,
    );
  }

  private allReviews(): Review[] {
    return (this.db.prepare("SELECT * FROM reviews").all() as any[]).map(
      rowToReview,
    );
  }

  /**
   * Bundle attribution for a set of commits into a portable, version-stamped
   * object. This is how local-first attribution survives `git push`: export on
   * the machine that did the work, import into a team board (or CI) on the
   * other side. Git carries the code; the bundle carries the accountability.
   */
  exportBundle(commits?: string[]): AttributionBundle {
    const scope = new Set(commits ?? this.distinctAttributedCommits());
    const attributions = this.allAttributions().filter((a) =>
      scope.has(a.commit),
    );
    const reviews = this.allReviews().filter((r) => scope.has(r.commit));
    const sessionIds = new Set(
      [...attributions, ...reviews]
        .map((x) => x.sessionId)
        .filter((s): s is string => s !== null),
    );
    const sessions = [...sessionIds]
      .map((sid) => this.getSession(sid))
      .filter((s): s is Session => s !== undefined);
    const decisions = (
      this.db.prepare("SELECT * FROM decisions").all() as any[]
    )
      .map(rowToDecision)
      .filter((d) => d.relatedCommits.some((c) => scope.has(c)));
    const bundle: AttributionBundle = {
      version: BUNDLE_VERSION,
      exportedAt: now(),
      attributions,
      reviews,
      sessions,
      decisions,
      signature: null,
      signedBy: null,
      signedSession: null,
    };
    // Sign the bundle with the active session's key so the importer can verify
    // it came from a holder of that key (origin authenticity), and that it was
    // not altered in transit (integrity).
    const sid = this.activeSession;
    const priv = sid ? this.loadSessionKey(sid) : undefined;
    const session = sid ? this.getSession(sid) : undefined;
    if (priv && session?.publicKey) {
      bundle.signature = signHash(priv, Board.bundleDigest(bundle));
      bundle.signedBy = session.publicKey;
      bundle.signedSession = sid;
    }
    return bundle;
  }

  /** Canonical SHA-256 over a bundle's records (excludes the signature fields). */
  private static bundleDigest(bundle: AttributionBundle): string {
    const sortById = <T extends { id: string }>(rows: T[]): T[] =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const canonical = JSON.stringify({
      version: bundle.version,
      attributions: sortById(bundle.attributions),
      reviews: sortById(bundle.reviews),
      sessions: sortById(bundle.sessions),
      decisions: sortById(bundle.decisions),
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  /** Verify a bundle's signature, if any: true/false, or null when unsigned. */
  static verifyBundle(bundle: AttributionBundle): boolean | null {
    if (!bundle.signature || !bundle.signedBy) {
      return null;
    }
    return verifyHash(
      bundle.signedBy,
      Board.bundleDigest(bundle),
      bundle.signature,
    );
  }

  /**
   * Merge a bundle into this board. Idempotent: rows already present (by id)
   * are left untouched, so re-importing is safe. One `import` event is appended
   * to the local timeline; the imported rows keep their original ids/times.
   */
  importBundle(
    bundle: AttributionBundle,
    opts: { requireSigned?: boolean } = {},
  ): {
    attributions: number;
    reviews: number;
    sessions: number;
    decisions: number;
    verified: boolean | null;
  } {
    if (!bundle || bundle.version !== BUNDLE_VERSION) {
      throw new Error(
        `unsupported bundle version: ${bundle?.version ?? "(none)"}`,
      );
    }
    // Authenticity/integrity: null = unsigned, true = valid, false = tampered.
    const verified = Board.verifyBundle(bundle);
    if (opts.requireSigned && verified !== true) {
      throw new Error(
        verified === false
          ? "bundle signature is INVALID (tampered or wrong key)"
          : "bundle is unsigned and --require-signed was set",
      );
    }
    const counts = { attributions: 0, reviews: 0, sessions: 0, decisions: 0 };
    const tx = this.db.transaction(() => {
      const insSession = this.db.prepare(
        `INSERT OR IGNORE INTO sessions (id, agent_name, label, machine, working_directory, git_branch, repository, public_key, last_heartbeat, started_at, finished_at)
         VALUES (@id, @agentName, @label, @machine, @workingDirectory, @gitBranch, @repository, @publicKey, @lastHeartbeat, @startedAt, @finishedAt)`,
      );
      for (const s of bundle.sessions ?? []) {
        // Normalize: an external bundle may predate newer session columns, so
        // fill any missing field with null before binding.
        counts.sessions += insSession.run({
          id: s.id,
          agentName: s.agentName,
          label: s.label ?? null,
          machine: s.machine ?? null,
          workingDirectory: s.workingDirectory ?? null,
          gitBranch: s.gitBranch ?? null,
          repository: s.repository ?? null,
          publicKey: s.publicKey ?? null,
          lastHeartbeat: s.lastHeartbeat ?? null,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt ?? null,
        }).changes;
      }
      const insAttr = this.db.prepare(
        `INSERT OR IGNORE INTO attributions (id, commit_sha, file, hunk, actor_type, actor, provider, model, cli, session_id, created_at)
         VALUES (@id, @commit, @file, @hunk, @actorType, @actor, @provider, @model, @cli, @sessionId, @createdAt)`,
      );
      for (const a of bundle.attributions ?? []) {
        counts.attributions += insAttr.run(a).changes;
      }
      const insReview = this.db.prepare(
        `INSERT OR IGNORE INTO reviews (id, commit_sha, reviewer_type, reviewer, session_id, outcome, note, created_at)
         VALUES (@id, @commit, @reviewerType, @reviewer, @sessionId, @outcome, @note, @createdAt)`,
      );
      for (const r of bundle.reviews ?? []) {
        counts.reviews += insReview.run(r).changes;
      }
      const insDecision = this.db.prepare(
        `INSERT OR IGNORE INTO decisions (id, agent_id, session_id, title, rationale, evidence, related_commits, related_tasks, created_at)
         VALUES (@id, @agentId, @sessionId, @title, @rationale, @evidence, @relatedCommits, @relatedTasks, @createdAt)`,
      );
      for (const d of bundle.decisions ?? []) {
        counts.decisions += insDecision.run({
          ...d,
          relatedCommits: JSON.stringify(d.relatedCommits ?? []),
          relatedTasks: JSON.stringify(d.relatedTasks ?? []),
        }).changes;
      }
      // Skip the audit event on a pure no-op re-import (all rows already
      // present) so re-syncing the same bundle doesn't accrete noise.
      if (
        counts.attributions +
          counts.reviews +
          counts.sessions +
          counts.decisions >
        0
      ) {
        const trust =
          verified === true
            ? " [signed ✓]"
            : verified === false
              ? " [signature INVALID]"
              : " [unsigned]";
        this.append(
          this.config.agent,
          "import",
          `imported bundle: ${counts.attributions} attribution(s), ${counts.reviews} review(s)${trust}`,
          null,
          null,
          { ...counts, verified },
        );
      }
    });
    tx.immediate();
    return { ...counts, verified };
  }

  /**
   * Git trailer lines encoding a commit's attribution, for embedding in a
   * commit message so it travels with the commit itself (a lightweight
   * alternative to a bundle). Blackboard-namespaced — it does not hijack
   * `Co-Authored-By`.
   */
  trailersFor(rev: string): string[] {
    const sha = git.resolveRev(rev) ?? rev;
    const attrs = this.attributionsForCommit(sha);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const a of attrs) {
      const model = a.model ? ` ${a.model}` : "";
      const line = `Blackboard-Attribution: ${a.actorType} ${a.actor}${model}${a.cli ? ` via ${a.cli}` : ""}`;
      if (!seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
    }
    const sessionIds = [
      ...new Set(
        attrs.map((a) => a.sessionId).filter((s): s is string => s !== null),
      ),
    ];
    for (const sid of sessionIds) {
      lines.push(`Blackboard-Session: ${sid}`);
    }
    return lines;
  }

  /** Everything the board knows about a commit — the `explain` view. */
  explain(rev: string):
    | {
        commit: git.CommitInfo | { sha: string };
        attributions: Attribution[];
        reviews: Review[];
        decisions: Decision[];
        note: string | null;
      }
    | undefined {
    const sha = git.resolveRev(rev) ?? rev;
    const info = git.commitInfo(sha) ?? { sha };
    const attributions = this.attributionsForCommit(sha);
    if (attributions.length === 0 && !git.resolveRev(rev)) {
      return undefined;
    }
    return {
      commit: info,
      attributions,
      reviews: this.reviewsForCommit(sha),
      decisions: this.decisionsForCommit(sha),
      note: git.readNote(sha) ?? null,
    };
  }

  /** Which session introduced a line — Git blame → attribution. */
  blame(
    file: string,
    line: number,
  ):
    | { sha: string; gitAuthor: string; attributions: Attribution[] }
    | undefined {
    const b = git.blameLine(file, line);
    if (!b) {
      return undefined;
    }
    return {
      sha: b.sha,
      gitAuthor: b.author,
      attributions: this.attributionsForCommitFile(b.sha, file),
    };
  }

  /**
   * Blame → narrative: from a single line, trace back to the session that
   * introduced it and surface that session's whole story — what else it did,
   * the decisions it made, and the handoffs it left. Turns `git blame` into
   * "why does this line exist".
   */
  blameNarrative(
    file: string,
    line: number,
  ):
    | {
        sha: string;
        gitAuthor: string;
        attributions: Attribution[];
        session: Session | null;
        sessionTimeline: TimelineEvent[];
        decisions: Decision[];
        handoffs: Handoff[];
      }
    | undefined {
    const b = git.blameLine(file, line);
    if (!b) {
      return undefined;
    }
    const attributions = this.attributionsForCommitFile(b.sha, file);
    const sessionId =
      attributions
        .map((a) => a.sessionId)
        .find((s): s is string => s !== null) ?? null;
    const session = sessionId ? (this.getSession(sessionId) ?? null) : null;
    const sessionTimeline = sessionId ? this.sessionTimeline(sessionId) : [];
    const decisions = sessionId
      ? (
          this.db
            .prepare(
              "SELECT * FROM decisions WHERE session_id = ? ORDER BY created_at ASC",
            )
            .all(sessionId) as any[]
        ).map(rowToDecision)
      : [];
    const handoffs = sessionId
      ? (
          this.db
            .prepare(
              "SELECT * FROM handoffs WHERE from_session = ? ORDER BY created_at ASC",
            )
            .all(sessionId) as any[]
        ).map(rowToHandoff)
      : [];
    return {
      sha: b.sha,
      gitAuthor: b.author,
      attributions,
      session,
      sessionTimeline,
      decisions,
      handoffs,
    };
  }

  // --- reporting -------------------------------------------------------------

  /** Aggregate metrics for a scorecard: coverage, AI/human ratio, per-agent. */
  report(): Report {
    return this.readSnapshot(() => this.reportSnapshot());
  }

  private reportSnapshot(): Report {
    const one = (sql: string, ...params: unknown[]): number => {
      const row = this.db.prepare(sql).get(...params) as
        { n: number } | undefined;
      return row?.n ?? 0;
    };
    const attrTotal = one("SELECT COUNT(*) AS n FROM attributions");
    const attrAi = one(
      "SELECT COUNT(*) AS n FROM attributions WHERE actor_type = 'ai'",
    );
    const attrHuman = one(
      "SELECT COUNT(*) AS n FROM attributions WHERE actor_type = 'human'",
    );

    const commitsTotal = one(
      "SELECT COUNT(DISTINCT commit_sha) AS n FROM attributions",
    );
    // Set-based (was an N+1 loop of hasHumanReview per AI commit): count AI
    // commits, and those with an approved human review, in two queries.
    const aiProduced = one(
      "SELECT COUNT(DISTINCT commit_sha) AS n FROM attributions WHERE actor_type = 'ai'",
    );
    const reviewed = one(
      `SELECT COUNT(*) AS n FROM (
         SELECT DISTINCT a.commit_sha FROM attributions a
         WHERE a.actor_type = 'ai'
           AND EXISTS (SELECT 1 FROM reviews r
                       WHERE r.commit_sha = a.commit_sha
                         AND r.reviewer_type = 'human' AND r.outcome = 'approved')
       )`,
    );
    const unreviewed = aiProduced - reviewed;
    // N/A (null), not 100%, when there is no AI work to review.
    const reviewCoverage = aiProduced === 0 ? null : reviewed / aiProduced;

    const perAgentRows = this.db
      .prepare(
        `SELECT actor AS agent, actor_type AS actorType, COUNT(*) AS attributions,
                COUNT(DISTINCT commit_sha) AS commits, COUNT(DISTINCT file) AS files
         FROM attributions GROUP BY actor, actor_type ORDER BY attributions DESC`,
      )
      .all() as {
      agent: string;
      actorType: string;
      attributions: number;
      commits: number;
      files: number;
    }[];

    return {
      attributions: { total: attrTotal, ai: attrAi, human: attrHuman },
      commits: {
        total: commitsTotal,
        aiProduced,
        humanReviewed: reviewed,
        unreviewed,
      },
      reviewCoverage,
      aiHumanRatio: { ai: attrAi, human: attrHuman },
      perAgent: perAgentRows,
      sessions: {
        total: one("SELECT COUNT(*) AS n FROM sessions"),
        open: one(
          "SELECT COUNT(*) AS n FROM sessions WHERE finished_at IS NULL",
        ),
      },
      risks: {
        open: one("SELECT COUNT(*) AS n FROM risks WHERE status = 'open'"),
      },
    };
  }

  // --- liveness (heartbeat) --------------------------------------------------

  /** Stamp a session's liveness. Cheap; not recorded on the timeline. */
  heartbeat(sessionId?: string): Session | undefined {
    const sid = sessionId ?? this.activeSession;
    if (!sid) {
      return undefined;
    }
    this.db
      .prepare("UPDATE sessions SET last_heartbeat = ? WHERE id = ?")
      .run(now(), sid);
    return this.getSession(sid);
  }

  /** Open sessions whose heartbeat is within `withinMs` — genuinely active. */
  activeSessions(withinMs = 120_000): Session[] {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    return (
      this.db
        .prepare(
          "SELECT * FROM sessions WHERE finished_at IS NULL AND last_heartbeat >= ? ORDER BY last_heartbeat DESC",
        )
        .all(cutoff) as any[]
    ).map(rowToSession);
  }

  /**
   * Other active sessions that recorded a change to the same file — real-time
   * collision awareness (two live agents editing one file), a step beyond the
   * same-task conflict surfaced by `fileChanged`.
   */
  activeEditorsOfFile(
    file: string,
    excludeSession: string | null,
    withinMs = 120_000,
  ): { sessionId: string; agent: string }[] {
    const active = new Set(this.activeSessions(withinMs).map((s) => s.id));
    const rows = this.db
      .prepare(
        "SELECT DISTINCT session_id, agent_id FROM files_changed WHERE path = ? AND session_id IS NOT NULL",
      )
      .all(file) as any[];
    return rows
      .filter(
        (r) => active.has(r.session_id) && r.session_id !== excludeSession,
      )
      .map((r) => ({ sessionId: r.session_id, agent: r.agent_id }));
  }

  // --- retention & redaction -------------------------------------------------

  /**
   * Delete potentially-sensitive, bulky rows (messages, evidence, file-change
   * records) created before a horizon. The append-only timeline is NEVER pruned
   * — it is the audit trail — so pruning is recorded as one `prune` event.
   */
  prune(beforeIso: string): {
    messages: number;
    evidence: number;
    filesChanged: number;
  } {
    const tx = this.db.transaction(() => {
      const del = (table: string): number =>
        this.db
          .prepare(`DELETE FROM ${table} WHERE created_at < ?`)
          .run(beforeIso).changes;
      const counts = {
        messages: del("messages"),
        evidence: del("evidence"),
        filesChanged: del("files_changed"),
      };
      this.append(
        this.config.agent,
        "prune",
        `pruned rows before ${beforeIso}: ${counts.messages} message(s), ${counts.evidence} evidence, ${counts.filesChanged} file-change(s)`,
        null,
        null,
        counts,
      );
      return counts;
    });
    return tx.immediate();
  }

  /**
   * Redact a timeline entry's content across ALL read paths. Two things happen:
   * (1) the timeline row's displayed summary/payload is overlaid with a
   * tombstone (`timeline`/`since`/`sessionTimeline`), and (2) the underlying
   * source row that the entry points at (a message body, evidence note, handoff
   * text, decision rationale, risk title) is blanked in its own table — because
   * those tables are read directly by `inbox`/`status`/the dashboard and would
   * otherwise leak the content the overlay only hid on the timeline.
   *
   * The timeline row's stored hash input is left intact so the chain still
   * verifies. NOTE: this hides content at the read layer — it is not
   * cryptographic erasure (the original summary remains in the timeline row to
   * keep the chain valid). Don't store secrets you must be able to destroy.
   */
  redact(seq: number, reason: string | null = null): boolean {
    const row = this.db
      .prepare("SELECT ref_table, ref_id FROM timeline WHERE seq = ?")
      .get(seq) as
      { ref_table: string | null; ref_id: string | null } | undefined;
    if (!row) {
      return false;
    }
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT OR REPLACE INTO redactions (seq, reason, actor, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(seq, reason, this.config.agent, now());
      // Blank the free-text columns of the source row, if any, so no direct
      // read path can surface the redacted content.
      const TOMB = "[redacted]";
      const blanks: Record<string, string> = {
        messages: "UPDATE messages SET body = ? WHERE id = ?",
        evidence: "UPDATE evidence SET ref = ?, note = ? WHERE id = ?",
        handoffs: "UPDATE handoffs SET summary = ?, context = ? WHERE id = ?",
        decisions: "UPDATE decisions SET rationale = ? WHERE id = ?",
        risks: "UPDATE risks SET title = ? WHERE id = ?",
      };
      if (row.ref_table && row.ref_id && blanks[row.ref_table]) {
        const sql = blanks[row.ref_table];
        const argCount = (sql.match(/\?/g) ?? []).length;
        const params = Array<string>(argCount - 1).fill(TOMB);
        this.db.prepare(sql).run(...params, row.ref_id);
      }
      this.append(
        this.config.agent,
        "redaction",
        `redacted #${seq}${reason ? `: ${reason}` : ""}`,
        "timeline",
        String(seq),
        { seq },
      );
    });
    tx.immediate();
    return true;
  }

  /** Seqs that have been redacted, with their reason. */
  private redactionMap(): Map<number, string | null> {
    const rows = this.db
      .prepare("SELECT seq, reason FROM redactions")
      .all() as {
      seq: number;
      reason: string | null;
    }[];
    return new Map(rows.map((r) => [r.seq, r.reason]));
  }

  /** Apply the redaction overlay to a set of events (content → tombstone). */
  private applyRedactions(events: TimelineEvent[]): TimelineEvent[] {
    const redacted = this.redactionMap();
    if (redacted.size === 0) {
      return events;
    }
    return events.map((e) =>
      redacted.has(e.seq)
        ? {
            ...e,
            summary: `[redacted${redacted.get(e.seq) ? `: ${redacted.get(e.seq)}` : ""}]`,
            payload: null,
          }
        : e,
    );
  }

  // --- ingestion -------------------------------------------------------------

  /**
   * Record a batch of normalized ingest events (from a transcript adapter)
   * under the acting agent and active session, then append one `ingest`
   * summary event. Each file/decision/note is attributed like any other write.
   */
  ingest(events: IngestEvent[]): {
    files: number;
    decisions: number;
    notes: number;
  } {
    const counts = { files: 0, decisions: 0, notes: 0 };
    // One transaction for the whole batch: a crash mid-transcript leaves the
    // board unchanged (all-or-nothing), rather than a half-applied prefix that
    // a re-run would double-record. The per-item writes nest as savepoints.
    const tx = this.db.transaction(() => {
      for (const e of events) {
        if (e.type === "file") {
          this.fileChanged(this.config.agent, e.path, e.change);
          counts.files += 1;
        } else if (e.type === "decision") {
          this.decision(this.config.agent, e.title, {
            rationale: e.rationale ?? null,
          });
          counts.decisions += 1;
        } else if (e.type === "note") {
          this.note(this.config.agent, e.text);
          counts.notes += 1;
        }
      }
      // Skip the summary event for an empty ingest — it would be pure noise in
      // the immutable timeline on a no-op transcript.
      if (counts.files + counts.decisions + counts.notes > 0) {
        this.append(
          this.config.agent,
          "ingest",
          `ingested ${counts.files} file(s), ${counts.decisions} decision(s), ${counts.notes} note(s)`,
          null,
          null,
          counts,
        );
      }
    });
    tx.immediate();
    return counts;
  }

  // --- read ------------------------------------------------------------------

  status(forAgent?: string): BoardStatus {
    // One read snapshot for the whole view: a concurrent writer committing
    // between these queries can't produce a status that mixes pre- and
    // post-write state.
    return this.readSnapshot(() => ({
      agents: this.listAgents(),
      openTasks: this.listTasks().filter((t) => t.status !== "done"),
      unreadMessages: forAgent ? this.inbox(forAgent) : this.allUnread(),
      openRisks: this.listRisks("open"),
      recentTimeline: this.timeline(10),
    }));
  }

  /**
   * Run a read-only function inside a single SQLite snapshot so every query it
   * makes sees a consistent point-in-time view of the board. Nested calls (a
   * snapshot within a snapshot) reuse the outer one.
   */
  private readSnapshot<T>(fn: () => T): T {
    if (this.db.inTransaction) {
      return fn();
    }
    return this.db.transaction(fn)();
  }

  private allUnread(): Message[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM messages WHERE read_at IS NULL ORDER BY created_at DESC",
        )
        .all() as any[]
    ).map(rowToMessage);
  }
}

// --- row mappers -------------------------------------------------------------

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    provider: r.provider ?? null,
    model: r.model ?? null,
    cli: r.cli ?? null,
    version: r.version ?? null,
    createdAt: r.created_at,
    lastSeen: r.last_seen,
  };
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    agentName: r.agent_name,
    label: r.label,
    machine: r.machine ?? null,
    workingDirectory: r.working_directory ?? null,
    gitBranch: r.git_branch ?? null,
    repository: r.repository ?? null,
    publicKey: r.public_key ?? null,
    lastHeartbeat: r.last_heartbeat ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
  };
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    // Coerce every element to a string so the `string[]` type is honored even
    // if a caller stored non-strings (which would otherwise crash consumers
    // that call string methods on the elements).
    return Array.isArray(parsed) ? parsed.map((e) => String(e)) : [];
  } catch {
    return [];
  }
}

function rowToDecision(r: any): Decision {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id ?? null,
    title: r.title,
    rationale: r.rationale,
    evidence: r.evidence ?? null,
    relatedCommits: parseJsonArray(r.related_commits),
    relatedTasks: parseJsonArray(r.related_tasks),
    createdAt: r.created_at,
  };
}

function rowToAttribution(r: any): Attribution {
  return {
    id: r.id,
    commit: r.commit_sha,
    file: r.file,
    hunk: r.hunk,
    actorType: r.actor_type,
    actor: r.actor,
    provider: r.provider ?? null,
    model: r.model ?? null,
    cli: r.cli ?? null,
    sessionId: r.session_id ?? null,
    createdAt: r.created_at,
  };
}

function rowToReview(r: any): Review {
  return {
    id: r.id,
    commit: r.commit_sha,
    reviewerType: r.reviewer_type,
    reviewer: r.reviewer,
    sessionId: r.session_id ?? null,
    outcome: r.outcome,
    note: r.note ?? null,
    createdAt: r.created_at,
  };
}

function rowToHandoff(r: any): Handoff {
  return {
    id: r.id,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    fromSession: r.from_session ?? null,
    toSession: r.to_session ?? null,
    summary: r.summary,
    context: r.context ?? null,
    relatedFiles: parseJsonArray(r.related_files),
    openQuestions: parseJsonArray(r.open_questions),
    taskKey: r.task_key ?? null,
    createdAt: r.created_at,
    acceptedAt: r.accepted_at ?? null,
  };
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    key: r.key,
    number: r.number ?? null,
    title: r.title,
    description: r.description ?? null,
    status: r.status,
    project: r.project ?? null,
    impact: r.impact ?? null,
    riskLevel: r.risk_level ?? null,
    progress: r.progress ?? 0,
    createdBy: r.created_by,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

function rowToRisk(r: any): Risk {
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    severity: r.severity,
    status: r.status,
    taskKey: r.task_key ?? null,
    createdAt: r.created_at,
  };
}

function rowToFileChange(r: any): FileChange {
  return {
    id: r.id,
    agentId: r.agent_id,
    sessionId: r.session_id ?? null,
    path: r.path,
    change: r.change,
    taskKey: r.task_key,
    createdAt: r.created_at,
  };
}

function rowToTimeline(r: any): TimelineEvent {
  return {
    id: r.id,
    seq: r.seq,
    at: r.at,
    actor: r.actor,
    sessionId: r.session_id ?? null,
    kind: r.kind,
    refTable: r.ref_table,
    refId: r.ref_id,
    summary: r.summary,
    payload: r.payload === null ? null : JSON.parse(r.payload),
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
