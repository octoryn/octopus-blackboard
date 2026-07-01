import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type Database from "better-sqlite3";
import { openDb } from "./db.js";
import { loadConfig, type AgentIdentity, type BoardConfig, type ConfigOverrides } from "./config.js";
import { clearCurrentSession, setCurrentSession } from "./current.js";
import * as git from "./git.js";
import type {
  Agent,
  ActorType,
  Attribution,
  BoardStatus,
  Decision,
  Evidence,
  FileChange,
  FileChangeKind,
  Handoff,
  Message,
  Review,
  ReviewerType,
  ReviewOutcome,
  Risk,
  RiskSeverity,
  Session,
  Task,
  TimelineEvent
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
    this.activeSession = config.sessionId;
    this.db = openDb(config.dbPath);
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
    return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS_HASH };
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
      e.prevHash
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
    payload: unknown
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
      hash: ""
    };
    event.hash = Board.computeHash(event);
    this.db
      .prepare(
        `INSERT INTO timeline (id, seq, at, actor, session_id, kind, ref_table, ref_id, summary, payload, prev_hash, hash)
         VALUES (@id, @seq, @at, @actor, @sessionId, @kind, @refTable, @refId, @summary, @payload, @prevHash, @hash)`
      )
      .run({
        ...event,
        payload: event.payload === null ? null : JSON.stringify(event.payload)
      });
    // Anchor the head (seq + hash) so tail truncation is detectable: deleting
    // the newest rows leaves an internally-consistent chain, but no longer
    // matches the recorded head. Same transaction as the insert.
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('head_seq', @seq), ('head_hash', @hash) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run({ seq: String(event.seq), hash: event.hash });
    return event;
  }

  private headAnchor(): { seq: number; hash: string } | null {
    const rows = this.db
      .prepare("SELECT key, value FROM meta WHERE key IN ('head_seq','head_hash')")
      .all() as { key: string; value: string }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const seq = map.get("head_seq");
    const hash = map.get("head_hash");
    return seq !== undefined && hash !== undefined ? { seq: Number(seq), hash } : null;
  }

  /** Re-walk the chain and confirm every hash links to its predecessor. */
  verifyChain(): ChainVerification {
    const rows = this.db.prepare("SELECT * FROM timeline ORDER BY seq ASC").all() as any[];
    let prevHash = GENESIS_HASH;
    let prevSeq = 0;
    for (const row of rows) {
      // Contiguity: seq must increment by exactly 1 (catches a missing middle
      // row even before the hash check).
      if (row.seq !== prevSeq + 1) {
        return { ok: false, length: rows.length, brokenAtSeq: row.seq };
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
        prevHash
      });
      if (row.prev_hash !== prevHash || row.hash !== recomputed) {
        return { ok: false, length: rows.length, brokenAtSeq: row.seq };
      }
      prevHash = row.hash;
      prevSeq = row.seq;
    }
    // Tail-truncation check against the recorded head anchor. Boards written
    // before anchoring existed have no anchor; those fall back to chain-internal
    // checks only.
    const anchor = this.headAnchor();
    if (anchor) {
      const lastSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0;
      const lastHash = rows.length > 0 ? rows[rows.length - 1].hash : GENESIS_HASH;
      if (lastSeq !== anchor.seq || lastHash !== anchor.hash) {
        return { ok: false, length: rows.length, brokenAtSeq: anchor.seq };
      }
    }
    return { ok: true, length: rows.length, brokenAtSeq: null };
  }

  timeline(limit = 50): TimelineEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM timeline ORDER BY seq DESC LIMIT ?")
      .all(limit) as any[];
    return rows.map(rowToTimeline).reverse();
  }

  // --- agents ----------------------------------------------------------------

  /**
   * Register the agent if new and stamp `last_seen`. Idempotent by name. When
   * registering the acting agent, its full provider-independent identity
   * (provider/model/cli/version) is merged in; non-null fields never overwrite
   * with null, so a later bare touch cannot erase identity.
   */
  ensureAgent(name: string, identity?: Partial<AgentIdentity>): Agent {
    const id0 = identity ?? (name === this.config.agent ? this.config.identity : undefined);
    const existing = this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name) as
      | any
      | undefined;
    const at = now();
    if (existing) {
      this.db
        .prepare(
          `UPDATE agents SET last_seen = ?,
             kind = COALESCE(?, kind), provider = COALESCE(?, provider),
             model = COALESCE(?, model), cli = COALESCE(?, cli), version = COALESCE(?, version)
           WHERE id = ?`
        )
        .run(
          at,
          id0?.kind ?? null,
          id0?.provider ?? null,
          id0?.model ?? null,
          id0?.cli ?? null,
          id0?.version ?? null,
          existing.id
        );
      return rowToAgent(this.db.prepare("SELECT * FROM agents WHERE id = ?").get(existing.id));
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
      lastSeen: at
    };
    this.db
      .prepare(
        "INSERT INTO agents (id, name, kind, provider, model, cli, version, created_at, last_seen) VALUES (@id, @name, @kind, @provider, @model, @cli, @version, @createdAt, @lastSeen)"
      )
      .run(agent);
    return agent;
  }

  getAgent(name: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE name = ?").get(name);
    return row ? rowToAgent(row) : undefined;
  }

  // --- sessions --------------------------------------------------------------

  /**
   * Open a new session for the acting agent and make it current (persisted to
   * the pointer file, so later CLI invocations attribute to it). Captures the
   * machine and repository context the session runs in.
   */
  startSession(label: string | null = null): Session {
    const tx = this.db.transaction((): Session => {
      this.ensureAgent(this.config.agent);
      const at = now();
      const session: Session = {
        id: id(),
        agentName: this.config.agent,
        label,
        machine: hostname(),
        workingDirectory: process.cwd(),
        gitBranch: git.currentBranch() ?? null,
        repository: git.remoteUrl() ?? git.repoRoot() ?? null,
        startedAt: at,
        finishedAt: null
      };
      this.db
        .prepare(
          `INSERT INTO sessions (id, agent_name, label, machine, working_directory, git_branch, repository, started_at, finished_at)
           VALUES (@id, @agentName, @label, @machine, @workingDirectory, @gitBranch, @repository, @startedAt, @finishedAt)`
        )
        .run(session);
      // Stamp subsequent events (including this one) with the new session.
      this.activeSession = session.id;
      this.append(
        this.config.agent,
        "session-start",
        `session started${label ? ` (${label})` : ""}`,
        "sessions",
        session.id,
        { machine: session.machine, gitBranch: session.gitBranch }
      );
      return session;
    });
    const session = tx.immediate();
    setCurrentSession(this.config.boardDir, this.config.agent, session.id);
    return session;
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
      this.db.prepare("UPDATE sessions SET finished_at = ? WHERE id = ?").run(at, target);
      this.activeSession = target;
      // Legacy/migrated session rows may lack an agent_name; fall back to the
      // acting agent so the timeline actor and pointer key are never null.
      this.append(existing.agentName ?? this.config.agent, "session-stop", "session stopped", "sessions", target, null);
      return this.getSession(target);
    });
    const session = tx.immediate();
    if (session) {
      clearCurrentSession(this.config.boardDir, session.agentName ?? this.config.agent);
    }
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? rowToSession(row) : undefined;
  }

  listSessions(limit = 30): Session[] {
    return (
      this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as any[]
    ).map(rowToSession);
  }

  /** All timeline events belonging to a session, oldest first. */
  sessionTimeline(sessionId: string): TimelineEvent[] {
    return (
      this.db
        .prepare("SELECT * FROM timeline WHERE session_id = ? ORDER BY seq ASC")
        .all(sessionId) as any[]
    ).map(rowToTimeline);
  }

  listAgents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY last_seen DESC").all() as any[]).map(
      rowToAgent
    );
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
      const existing = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key) as
        | any
        | undefined;
      let conflict: string | null = null;
      let task: Task;
      if (!existing) {
        task = {
          id: id(),
          key,
          title,
          status: "claimed",
          createdBy: actor,
          claimedBy: actor,
          claimedAt: at,
          releasedAt: null,
          createdAt: at,
          updatedAt: at
        };
        this.db
          .prepare(
            `INSERT INTO tasks (id, key, title, status, created_by, claimed_by, claimed_at, released_at, created_at, updated_at)
             VALUES (@id, @key, @title, @status, @createdBy, @claimedBy, @claimedAt, @releasedAt, @createdAt, @updatedAt)`
          )
          .run(task);
      } else {
        if (existing.claimed_by && existing.claimed_by !== actor && !existing.released_at) {
          conflict = existing.claimed_by;
        }
        this.db
          .prepare(
            "UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?, released_at = NULL, title = COALESCE(?, title), updated_at = ? WHERE key = ?"
          )
          .run(actor, at, title, at, key);
        task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
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
      const existing = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key) as
        | any
        | undefined;
      if (!existing) {
        return undefined;
      }
      this.db
        .prepare(
          "UPDATE tasks SET status = 'open', released_at = ?, claimed_by = NULL, updated_at = ? WHERE key = ?"
        )
        .run(at, at, key);
      const task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
      this.append(actor, "release", `released "${key}"`, "tasks", task.id, { key });
      return task;
    });
    return tx.immediate();
  }

  /** Mark a task done. */
  complete(actor: string, key: string): Task | undefined {
    const tx = this.db.transaction((): Task | undefined => {
      this.ensureAgent(actor);
      const at = now();
      const existing = this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key) as
        | any
        | undefined;
      if (!existing) {
        return undefined;
      }
      this.db
        .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE key = ?")
        .run(at, key);
      const task = rowToTask(this.db.prepare("SELECT * FROM tasks WHERE key = ?").get(key));
      this.append(actor, "complete", `completed "${key}"`, "tasks", task.id, { key });
      return task;
    });
    return tx.immediate();
  }

  listTasks(status?: string): Task[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC").all(
          status
        ) as any[])
      : (this.db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC").all() as any[]);
    return rows.map(rowToTask);
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
        readAt: null
      };
      this.db
        .prepare(
          "INSERT INTO messages (id, from_agent, to_agent, body, created_at, read_at) VALUES (@id, @fromAgent, @toAgent, @body, @createdAt, @readAt)"
        )
        .run(msg);
      const dest = to ? `→ ${to}` : "(broadcast)";
      this.append(actor, "message", `message ${dest}: ${body}`, "messages", msg.id, { to });
      return msg;
    });
    return tx.immediate();
  }

  /** Messages addressed to `agent` (or broadcast) that are still unread. */
  inbox(agent: string, includeRead = false): Message[] {
    const sql = includeRead
      ? "SELECT * FROM messages WHERE to_agent = ? OR to_agent IS NULL ORDER BY created_at DESC"
      : "SELECT * FROM messages WHERE (to_agent = ? OR to_agent IS NULL) AND read_at IS NULL ORDER BY created_at DESC";
    return (this.db.prepare(sql).all(agent) as any[]).map(rowToMessage);
  }

  markRead(messageId: string): void {
    this.db.prepare("UPDATE messages SET read_at = ? WHERE id = ?").run(now(), messageId);
  }

  decision(
    actor: string,
    title: string,
    opts: {
      rationale?: string | null;
      evidence?: string | null;
      relatedCommits?: string[];
      relatedTasks?: string[];
    } = {}
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
        createdAt: now()
      };
      this.db
        .prepare(
          `INSERT INTO decisions (id, agent_id, session_id, title, rationale, evidence, related_commits, related_tasks, created_at)
           VALUES (@id, @agentId, @sessionId, @title, @rationale, @evidence, @relatedCommits, @relatedTasks, @createdAt)`
        )
        .run({
          ...dec,
          relatedCommits: JSON.stringify(dec.relatedCommits),
          relatedTasks: JSON.stringify(dec.relatedTasks)
        });
      this.append(actor, "decision", `decided: ${title}`, "decisions", dec.id, {
        rationale: dec.rationale,
        relatedCommits: dec.relatedCommits
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
    return (this.db.prepare("SELECT * FROM decisions ORDER BY created_at DESC").all() as any[])
      .map(rowToDecision)
      .filter((d) => d.relatedCommits.some((c) => matches(c, commitSha)));
  }

  evidence(actor: string, ref: string, note: string | null = null, target: string | null = null): Evidence {
    const tx = this.db.transaction((): Evidence => {
      this.ensureAgent(actor);
      const ev: Evidence = { id: id(), agentId: actor, ref, note, target, createdAt: now() };
      this.db
        .prepare(
          "INSERT INTO evidence (id, agent_id, ref, note, target, created_at) VALUES (@id, @agentId, @ref, @note, @target, @createdAt)"
        )
        .run(ev);
      this.append(actor, "evidence", `evidence: ${ref}`, "evidence", ev.id, { target });
      return ev;
    });
    return tx.immediate();
  }

  fileChanged(actor: string, path: string, change: FileChangeKind, taskKey: string | null = null): FileChange {
    const tx = this.db.transaction((): FileChange => {
      this.ensureAgent(actor);
      const fc: FileChange = {
        id: id(),
        agentId: actor,
        sessionId: this.activeSession,
        path,
        change,
        taskKey,
        createdAt: now()
      };
      this.db
        .prepare(
          "INSERT INTO files_changed (id, agent_id, session_id, path, change, task_key, created_at) VALUES (@id, @agentId, @sessionId, @path, @change, @taskKey, @createdAt)"
        )
        .run(fc);
      this.append(actor, "file", `${change}: ${path}`, "files_changed", fc.id, { taskKey });
      return fc;
    });
    return tx.immediate();
  }

  /** Files another agent reports touching for a task — conflict awareness. */
  filesForTask(taskKey: string): FileChange[] {
    return (
      this.db
        .prepare("SELECT * FROM files_changed WHERE task_key = ? ORDER BY created_at DESC")
        .all(taskKey) as any[]
    ).map(rowToFileChange);
  }

  risk(actor: string, title: string, severity: RiskSeverity = "medium"): Risk {
    const tx = this.db.transaction((): Risk => {
      this.ensureAgent(actor);
      const r: Risk = {
        id: id(),
        agentId: actor,
        title,
        severity,
        status: "open",
        createdAt: now()
      };
      this.db
        .prepare(
          "INSERT INTO risks (id, agent_id, title, severity, status, created_at) VALUES (@id, @agentId, @title, @severity, @status, @createdAt)"
        )
        .run(r);
      this.append(actor, "risk", `risk [${severity}]: ${title}`, "risks", r.id, null);
      return r;
    });
    return tx.immediate();
  }

  listRisks(status: string | null = "open"): Risk[] {
    const rows = status
      ? (this.db.prepare("SELECT * FROM risks WHERE status = ? ORDER BY created_at DESC").all(
          status
        ) as any[])
      : (this.db.prepare("SELECT * FROM risks ORDER BY created_at DESC").all() as any[]);
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
    } = {}
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
        acceptedAt: null
      };
      this.db
        .prepare(
          `INSERT INTO handoffs (id, from_agent, to_agent, from_session, to_session, summary, context, related_files, open_questions, task_key, created_at, accepted_at)
           VALUES (@id, @fromAgent, @toAgent, @fromSession, @toSession, @summary, @context, @relatedFiles, @openQuestions, @taskKey, @createdAt, @acceptedAt)`
        )
        .run({
          ...h,
          relatedFiles: JSON.stringify(h.relatedFiles),
          openQuestions: JSON.stringify(h.openQuestions)
        });
      this.append(actor, "handoff", `handoff → ${to}: ${summary}`, "handoffs", h.id, {
        taskKey: h.taskKey,
        openQuestions: h.openQuestions
      });
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
          sessionId
        };
      }
    }
    return {
      actor: this.config.agent,
      provider: this.config.identity.provider,
      model: this.config.identity.model,
      cli: this.config.identity.cli,
      sessionId: this.activeSession
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
    } = {}
  ): Attribution {
    const sha = git.resolveRev(commit) ?? commit;
    const actorType = opts.actorType ?? "ai";
    const ident =
      actorType === "ai"
        ? this.identityForSession(opts.sessionId ?? this.activeSession)
        : { actor: this.config.agent, provider: null, model: null, cli: null, sessionId: opts.sessionId ?? null };
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
      createdAt: now()
    };
    const tx = this.db.transaction(() => {
      this.insertAttribution(attr);
      const where = attr.file ? ` ${attr.file}` : "";
      this.append(attr.actor, "attribution", `${attr.actorType} produced ${sha.slice(0, 8)}${where}`, "attributions", attr.id, {
        commit: sha,
        file: attr.file
      });
    });
    tx.immediate();
    return attr;
  }

  private insertAttribution(attr: Attribution): void {
    this.db
      .prepare(
        `INSERT INTO attributions (id, commit_sha, file, hunk, actor_type, actor, provider, model, cli, session_id, created_at)
         VALUES (@id, @commit, @file, @hunk, @actorType, @actor, @provider, @model, @cli, @sessionId, @createdAt)`
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
    opts: { sessionId?: string | null; actorType?: ActorType; actor?: string; writeNote?: boolean } = {}
  ): { sha: string; files: string[]; count: number } | undefined {
    const sha = git.resolveRev(rev);
    if (!sha) {
      return undefined;
    }
    // Never attribute the board's own storage.
    const files = git.filesInCommit(sha).filter((f) => !f.startsWith(".octoboard/"));
    const actorType = opts.actorType ?? "ai";
    const ident =
      actorType === "ai"
        ? this.identityForSession(opts.sessionId ?? this.activeSession)
        : { actor: opts.actor ?? this.config.agent, provider: null, model: null, cli: null, sessionId: opts.sessionId ?? null };
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
          createdAt: now()
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
        { sha, files }
      );
    });
    tx.immediate();
    if (opts.writeNote) {
      const label = `${ident.cli ?? ident.actor}${ident.model ? ` (${ident.model})` : ""}`;
      git.writeNote(sha, `blackboard: produced by ${label}, session ${ident.sessionId ?? "n/a"}`);
    }
    return { sha, files, count: targets.length };
  }

  attributionsForCommit(commitSha: string): Attribution[] {
    return (
      this.db
        .prepare("SELECT * FROM attributions WHERE commit_sha = ? ORDER BY created_at ASC")
        .all(commitSha) as any[]
    ).map(rowToAttribution);
  }

  attributionsForFile(file: string): Attribution[] {
    return (
      this.db
        .prepare("SELECT * FROM attributions WHERE file = ? ORDER BY created_at DESC")
        .all(file) as any[]
    ).map(rowToAttribution);
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
    } = {}
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
      createdAt: now()
    };
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (id, commit_sha, reviewer_type, reviewer, session_id, outcome, note, created_at)
           VALUES (@id, @commit, @reviewerType, @reviewer, @sessionId, @outcome, @note, @createdAt)`
        )
        .run(rev);
      this.append(
        rev.reviewer,
        "review",
        `${rev.reviewerType} review of ${sha.slice(0, 8)}: ${rev.outcome}`,
        "reviews",
        rev.id,
        { commit: sha, outcome: rev.outcome }
      );
    });
    tx.immediate();
    return rev;
  }

  reviewsForCommit(commitSha: string): Review[] {
    return (
      this.db
        .prepare("SELECT * FROM reviews WHERE commit_sha = ? ORDER BY created_at ASC")
        .all(commitSha) as any[]
    ).map(rowToReview);
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
         GROUP BY session_id, agent_id ORDER BY at DESC`
      )
      .all(file) as any[];
    return {
      gitAuthors: git.fileAuthors(file),
      attributions: this.attributionsForFile(file),
      sessions: rows.map((r) => ({ sessionId: r.session_id, agent: r.agent_id, at: r.at }))
    };
  }

  /**
   * Commits attributed to an actor, CLI, provider, or model (matched broadly
   * across those columns). Returns the actual matching attribution rows, so the
   * reported `actor`/`cli` always reflect a row that matched the query — never
   * an unrelated attribution on the same commit.
   */
  commitsByActor(query: string): { commit: string; actor: string; cli: string | null; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT commit_sha, actor, cli, created_at FROM attributions
         WHERE actor = ? OR cli = ? OR provider = ? OR model = ?
         ORDER BY created_at DESC`
      )
      .all(query, query, query, query) as any[];
    // Collapse to one row per (commit, actor, cli); keep the earliest time.
    const seen = new Map<string, { commit: string; actor: string; cli: string | null; at: string }>();
    for (const r of rows) {
      const key = `${r.commit_sha} ${r.actor} ${r.cli ?? ""}`;
      const existing = seen.get(key);
      if (!existing || r.created_at < existing.at) {
        seen.set(key, { commit: r.commit_sha, actor: r.actor, cli: r.cli, at: r.created_at });
      }
    }
    return [...seen.values()].sort((x, y) => (x.at < y.at ? 1 : -1));
  }

  /** AI-attributed commits with no human review — the accountability gap. */
  unreviewedCommits(): { commit: string; actor: string; at: string }[] {
    const rows = this.db
      .prepare(
        `SELECT a.commit_sha, a.actor, MIN(a.created_at) AS at FROM attributions a
         WHERE a.actor_type = 'ai'
           AND NOT EXISTS (
             SELECT 1 FROM reviews r WHERE r.commit_sha = a.commit_sha AND r.reviewer_type = 'human'
           )
         GROUP BY a.commit_sha ORDER BY at DESC`
      )
      .all() as any[];
    return rows.map((r) => ({ commit: r.commit_sha, actor: r.actor, at: r.at }));
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
      const fc = this.db.prepare("SELECT DISTINCT path FROM files_changed WHERE agent_id = ?").all(agent) as any[];
      const at = this.db.prepare("SELECT DISTINCT file FROM attributions WHERE actor = ? AND file IS NOT NULL").all(agent) as any[];
      return new Set([...fc.map((r) => norm(r.path)), ...at.map((r) => norm(r.file))]);
    };
    const a = filesOf(agentA);
    const b = filesOf(agentB);
    return [...a].filter((f) => b.has(f)).sort();
  }

  /** Everything the board knows about a commit — the `explain` view. */
  explain(rev: string): {
    commit: git.CommitInfo | { sha: string };
    attributions: Attribution[];
    reviews: Review[];
    decisions: Decision[];
    note: string | null;
  } | undefined {
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
      note: git.readNote(sha) ?? null
    };
  }

  /** Which session introduced a line — Git blame → attribution. */
  blame(file: string, line: number): { sha: string; gitAuthor: string; attributions: Attribution[] } | undefined {
    const b = git.blameLine(file, line);
    if (!b) {
      return undefined;
    }
    return { sha: b.sha, gitAuthor: b.author, attributions: this.attributionsForCommit(b.sha) };
  }

  // --- read ------------------------------------------------------------------

  status(forAgent?: string): BoardStatus {
    return {
      agents: this.listAgents(),
      openTasks: this.listTasks().filter((t) => t.status !== "done"),
      unreadMessages: forAgent ? this.inbox(forAgent) : this.allUnread(),
      openRisks: this.listRisks("open"),
      recentTimeline: this.timeline(10)
    };
  }

  private allUnread(): Message[] {
    return (
      this.db.prepare("SELECT * FROM messages WHERE read_at IS NULL ORDER BY created_at DESC").all() as any[]
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
    lastSeen: r.last_seen
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
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null
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
    createdAt: r.created_at
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
    createdAt: r.created_at
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
    createdAt: r.created_at
  };
}

function rowToTask(r: any): Task {
  return {
    id: r.id,
    key: r.key,
    title: r.title,
    status: r.status,
    createdBy: r.created_by,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    releasedAt: r.released_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

function rowToMessage(r: any): Message {
  return {
    id: r.id,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    body: r.body,
    createdAt: r.created_at,
    readAt: r.read_at
  };
}

function rowToRisk(r: any): Risk {
  return {
    id: r.id,
    agentId: r.agent_id,
    title: r.title,
    severity: r.severity,
    status: r.status,
    createdAt: r.created_at
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
    createdAt: r.created_at
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
    hash: r.hash
  };
}
