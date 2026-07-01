/**
 * Domain types for the Octopus Blackboard — a shared memory and coordination
 * layer for AI coding agents.
 *
 * The blackboard does NOT orchestrate, schedule, or trigger agents. It records
 * what each agent chooses to write, and lets every other agent read it. Six
 * questions it answers:
 *
 *   Who is working on what   → agents, tasks, claims
 *   What changed             → files_changed
 *   What was decided         → decisions
 *   What evidence exists      → evidence
 *   What risks are open      → risks
 *   What was left for whom    → messages, handoffs
 *
 * Every mutation appends a tamper-evident entry to the `timeline` (a hash
 * chain), so the whole history is replayable and auditable.
 */

/**
 * A participating AI system (or human), identified provider-independently. No
 * assumptions about any specific vendor: any CLI can register itself with these
 * fields. `name` is the stable board handle; the rest describe the system.
 */
export interface Agent {
  id: string;
  /** Stable handle used on the board, e.g. "claude", "codex", "gemini". */
  name: string;
  /** Free-form product/kind label, e.g. "claude-code", "cursor". */
  kind: string | null;
  /** Vendor / origin, e.g. "anthropic", "openai", "google", "local". */
  provider: string | null;
  /** Model identifier, e.g. "claude-opus-4-8", "gpt-5", "llama-3.1-70b". */
  model: string | null;
  /** The CLI / surface, e.g. "claude-code", "codex-cli", "cursor". */
  cli: string | null;
  /** CLI or integration version. */
  version: string | null;
  createdAt: string;
  lastSeen: string;
}

/**
 * One continuous execution session for an agent — the unit attribution,
 * reviews, and handoffs hang off of. Started with `session start`, closed with
 * `session stop`; captures the machine and repository context it ran in.
 */
export interface Session {
  id: string;
  agentName: string;
  label: string | null;
  machine: string | null;
  workingDirectory: string | null;
  gitBranch: string | null;
  repository: string | null;
  /** Ed25519 public key (PEM) for this session's signatures, if signing is on. */
  publicKey: string | null;
  /** Last liveness heartbeat; used to tell active sessions from stale ones. */
  lastHeartbeat: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export type ActorType = "human" | "ai";

/**
 * Who actually produced a change — the attribution Git cannot record. Bound to
 * a commit (and optionally a file/hunk). For AI actors the provider/model/cli
 * are denormalized so "which commits came from Claude Code" is a cheap query
 * even after session rows change.
 */
export interface Attribution {
  id: string;
  commit: string;
  file: string | null;
  hunk: string | null;
  actorType: ActorType;
  /** Agent handle or human name. */
  actor: string;
  provider: string | null;
  model: string | null;
  cli: string | null;
  sessionId: string | null;
  createdAt: string;
}

export type ReviewerType = "human" | "ai";
export type ReviewOutcome = "approved" | "changes-requested" | "rejected" | "commented";

/** Review responsibility for a commit — who reviewed it, and the outcome. */
export interface Review {
  id: string;
  commit: string;
  reviewerType: ReviewerType;
  reviewer: string;
  sessionId: string | null;
  outcome: ReviewOutcome;
  note: string | null;
  createdAt: string;
}

export type TaskStatus = "open" | "claimed" | "done" | "blocked";

/**
 * A unit of work. `key` is a human slug (unique) used to claim/hand off work;
 * `claimedBy` is the single agent currently holding it — the basis for
 * conflict awareness (two agents claiming the same key).
 */
export interface Task {
  id: string;
  key: string;
  title: string | null;
  status: TaskStatus;
  createdBy: string | null;
  claimedBy: string | null;
  claimedAt: string | null;
  releasedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A note left for another agent (to=null is a broadcast to the board). */
export interface Message {
  id: string;
  fromAgent: string;
  toAgent: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
}

/** A decision worth remembering — the "what was decided" of the board. */
export interface Decision {
  id: string;
  agentId: string;
  sessionId: string | null;
  title: string;
  rationale: string | null;
  /** Free-form evidence pointer (path, URL, log). */
  evidence: string | null;
  /** Commit shas this decision relates to. */
  relatedCommits: string[];
  /** Task keys this decision relates to. */
  relatedTasks: string[];
  createdAt: string;
}

/** A pointer to supporting evidence (a file, URL, log, test run). */
export interface Evidence {
  id: string;
  agentId: string;
  ref: string;
  note: string | null;
  /** Optional link to what this evidence supports, e.g. "task:auth-mw". */
  target: string | null;
  createdAt: string;
}

export type FileChangeKind = "added" | "modified" | "deleted";

/** A record that an agent touched a file (cooperative, not authoritative). */
export interface FileChange {
  id: string;
  agentId: string;
  sessionId: string | null;
  path: string;
  change: FileChangeKind;
  taskKey: string | null;
  createdAt: string;
}

export type RiskSeverity = "low" | "medium" | "high";
export type RiskStatus = "open" | "mitigated" | "closed";

/** An open risk the next agent should be aware of before acting. */
export interface Risk {
  id: string;
  agentId: string;
  title: string;
  severity: RiskSeverity;
  status: RiskStatus;
  createdAt: string;
}

/** A handoff: agent A passes context for some work to agent B. */
export interface Handoff {
  id: string;
  fromAgent: string;
  toAgent: string;
  fromSession: string | null;
  toSession: string | null;
  summary: string;
  context: string | null;
  relatedFiles: string[];
  openQuestions: string[];
  taskKey: string | null;
  createdAt: string;
  acceptedAt: string | null;
}

/**
 * One entry in the append-only, hash-chained audit log. `hash` is computed
 * over the entry plus the previous entry's hash, so any tampering with an
 * earlier row breaks verification of every row after it.
 */
export interface TimelineEvent {
  id: string;
  seq: number;
  at: string;
  actor: string;
  /** The session this event belongs to, if one was active. */
  sessionId: string | null;
  kind: string;
  refTable: string | null;
  refId: string | null;
  summary: string;
  payload: unknown;
  prevHash: string;
  hash: string;
}

/** A point-in-time read of the board, what `octoboard status` renders. */
export interface BoardStatus {
  agents: Agent[];
  openTasks: Task[];
  unreadMessages: Message[];
  openRisks: Risk[];
  recentTimeline: TimelineEvent[];
}
