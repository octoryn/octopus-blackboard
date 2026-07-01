import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

/**
 * Open (creating if needed) the SQLite database that backs a blackboard and
 * apply the schema. The schema is idempotent (`IF NOT EXISTS`), so opening an
 * existing board is safe. WAL mode lets multiple agents read while one writes —
 * the common case when several CLIs share one board.
 */
export function openDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // Durability to match the tamper-evident audit-log promise: FULL fsyncs each
  // commit so the most recent timeline entries + head anchor survive OS crash /
  // power loss, not just an app crash (WAL's default NORMAL would risk them).
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  applySchema(db);
  migrate(db);
  db.exec(INDEXES); // after migrate: indexes may reference newly-added columns
  return db;
}

function applySchema(db: Database.Database): void {
  db.exec(SCHEMA);
}

/**
 * Additive, in-place migration for boards created by an earlier version. Only
 * ever ADDS nullable columns and new tables — never drops or rewrites — so
 * upgrading an existing `.octoboard/board.db` is safe and lossless.
 */
function migrate(db: Database.Database): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (db.pragma(`table_info(${table})`) as { name: string }[]).map(
        (c) => c.name,
      ),
    );

  const ensure = (table: string, column: string, decl: string): void => {
    if (!columns(table).has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  };

  // agents: provider-independent identity fields
  ensure("agents", "provider", "TEXT");
  ensure("agents", "model", "TEXT");
  ensure("agents", "cli", "TEXT");
  ensure("agents", "version", "TEXT");

  // sessions: reshaped for first-class attribution (old boards had a stub,
  // never-written table using agent_id/ended_at; add the new columns beside it)
  ensure("sessions", "agent_name", "TEXT");
  ensure("sessions", "finished_at", "TEXT");
  ensure("sessions", "machine", "TEXT");
  ensure("sessions", "working_directory", "TEXT");
  ensure("sessions", "git_branch", "TEXT");
  ensure("sessions", "repository", "TEXT");
  ensure("sessions", "public_key", "TEXT");
  ensure("sessions", "last_heartbeat", "TEXT");

  // session linkage on writes
  ensure("timeline", "session_id", "TEXT");
  ensure("files_changed", "session_id", "TEXT");

  // decisions: evidence & relations
  ensure("decisions", "session_id", "TEXT");
  ensure("decisions", "evidence", "TEXT");
  ensure("decisions", "related_commits", "TEXT");
  ensure("decisions", "related_tasks", "TEXT");

  // handoffs: richer context
  ensure("handoffs", "from_session", "TEXT");
  ensure("handoffs", "to_session", "TEXT");
  ensure("handoffs", "context", "TEXT");
  ensure("handoffs", "related_files", "TEXT");
  ensure("handoffs", "open_questions", "TEXT");

  // tasks: kanban fields
  ensure("tasks", "number", "INTEGER");
  ensure("tasks", "description", "TEXT");
  ensure("tasks", "project", "TEXT");
  ensure("tasks", "impact", "TEXT");
  ensure("tasks", "risk_level", "TEXT");
  ensure("tasks", "progress", "INTEGER NOT NULL DEFAULT 0");
  ensure("risks", "task_key", "TEXT");
  ensure("evidence", "sha256", "TEXT");
  // Backfill stable, unique numbers for tasks created before numbering existed,
  // in creation order (rowid is unique, so no two tasks collide).
  db.exec(
    `UPDATE tasks SET number = (SELECT COUNT(*) FROM tasks t2 WHERE t2.rowid <= tasks.rowid)
     WHERE number IS NULL`,
  );

  // Drop indexes that turned out redundant/low-value (present on boards created
  // by earlier versions): the implicit index on the UNIQUE seq column, and the
  // low-selectivity actor_type index.
  db.exec("DROP INDEX IF EXISTS idx_timeline_seq");
  db.exec("DROP INDEX IF EXISTS idx_attr_type");
}

/**
 * The board schema. Mirrors the domain model in `types.ts`. `timeline` is the
 * append-only hash chain every other write also records into.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  kind       TEXT,
  provider   TEXT,
  model      TEXT,
  cli        TEXT,
  version    TEXT,
  created_at TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  agent_name        TEXT NOT NULL,
  label             TEXT,
  machine           TEXT,
  working_directory TEXT,
  git_branch        TEXT,
  repository        TEXT,
  public_key        TEXT,
  last_heartbeat    TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);

CREATE TABLE IF NOT EXISTS redactions (
  seq        INTEGER PRIMARY KEY,
  reason     TEXT,
  actor      TEXT,
  created_at TEXT NOT NULL
);

-- Each agent's active session, kept in the DB (not a JSON file) so start/stop
-- are transactional and cannot race between concurrent CLI processes.
CREATE TABLE IF NOT EXISTS current_sessions (
  agent      TEXT PRIMARY KEY,
  session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  head_seq   INTEGER NOT NULL,
  head_hash  TEXT NOT NULL,
  signature  TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL UNIQUE,
  number      INTEGER,
  title       TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  project     TEXT,
  impact      TEXT,
  risk_level  TEXT,
  progress    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  claimed_by  TEXT,
  claimed_at  TEXT,
  released_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Agents assigned to a task (many-to-many). Assigning is how "notify Claude to
-- look at task #145" is recorded — it also drops a message in the assignee's
-- inbox. The board records the assignment; it never launches the agent.
CREATE TABLE IF NOT EXISTS task_assignees (
  task_key    TEXT NOT NULL,
  agent       TEXT NOT NULL,
  assigned_by TEXT,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (task_key, agent)
);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent   TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at    TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  session_id      TEXT,
  title           TEXT NOT NULL,
  rationale       TEXT,
  evidence        TEXT,
  related_commits TEXT,
  related_tasks   TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  ref        TEXT NOT NULL,
  note       TEXT,
  target     TEXT,
  sha256     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files_changed (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  session_id TEXT,
  path       TEXT NOT NULL,
  change     TEXT NOT NULL,
  task_key   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS risks (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  title      TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'medium',
  status     TEXT NOT NULL DEFAULT 'open',
  task_key   TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id             TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  from_session   TEXT,
  to_session     TEXT,
  summary        TEXT NOT NULL,
  context        TEXT,
  related_files  TEXT,
  open_questions TEXT,
  task_key       TEXT,
  created_at     TEXT NOT NULL,
  accepted_at    TEXT
);

CREATE TABLE IF NOT EXISTS attributions (
  id         TEXT PRIMARY KEY,
  commit_sha TEXT NOT NULL,
  file       TEXT,
  hunk       TEXT,
  actor_type TEXT NOT NULL,
  actor      TEXT NOT NULL,
  provider   TEXT,
  model      TEXT,
  cli        TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id            TEXT PRIMARY KEY,
  commit_sha    TEXT NOT NULL,
  reviewer_type TEXT NOT NULL,
  reviewer      TEXT NOT NULL,
  session_id    TEXT,
  outcome       TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS timeline (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL UNIQUE,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL,
  ref_table  TEXT,
  ref_id     TEXT,
  summary    TEXT NOT NULL,
  payload    TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);

-- Enforce append-only at the database layer, for EVERY connection (not just the
-- board's code): the timeline can be INSERTed into, never UPDATEd or DELETEd.
-- This turns "append-only by convention" into "append-only by default" — a
-- casual sqlite3 edit or a buggy write is refused. A determined attacker with
-- DB access can still DROP these triggers, but then the hash chain + head anchor
-- detect the tamper (belt and braces). No legitimate code path updates/deletes
-- timeline rows (redaction uses an overlay; prune never touches the timeline).
CREATE TRIGGER IF NOT EXISTS timeline_no_update BEFORE UPDATE ON timeline
BEGIN SELECT RAISE(ABORT, 'timeline is append-only: rows cannot be modified'); END;
CREATE TRIGGER IF NOT EXISTS timeline_no_delete BEFORE DELETE ON timeline
BEGIN SELECT RAISE(ABORT, 'timeline is append-only: rows cannot be deleted'); END;

`;

/**
 * Indexes, applied after migration so they may safely reference columns added
 * to pre-existing tables during an upgrade.
 */
const INDEXES = `
-- NB: timeline.seq is INTEGER UNIQUE, which already creates an implicit index —
-- so no explicit idx_timeline_seq (it would be a redundant duplicate B-tree).
-- actor_type is too low-selectivity (2-3 values) for an index to help.
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read_at);
CREATE INDEX IF NOT EXISTS idx_files_task ON files_changed(task_key);
CREATE INDEX IF NOT EXISTS idx_files_session ON files_changed(session_id);
CREATE INDEX IF NOT EXISTS idx_files_path ON files_changed(path);
CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline(session_id);
CREATE INDEX IF NOT EXISTS idx_risks_status ON risks(status);
CREATE INDEX IF NOT EXISTS idx_attr_commit ON attributions(commit_sha);
CREATE INDEX IF NOT EXISTS idx_attr_file ON attributions(file);
CREATE INDEX IF NOT EXISTS idx_attr_actor ON attributions(actor);
CREATE INDEX IF NOT EXISTS idx_reviews_commit ON reviews(commit_sha);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(finished_at, last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_assignees_task ON task_assignees(task_key);
CREATE INDEX IF NOT EXISTS idx_risks_task ON risks(task_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_number ON tasks(number);
`;
