import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Resolved configuration for a single blackboard. Local-first: the board is a
 * SQLite file under a `.octoboard/` directory, discovered by walking up from
 * the current working directory (like `.git`). A future Postgres sync backend
 * will plug in here behind `databaseUrl`.
 */
export interface AgentIdentity {
  /** Stable handle written to the board, e.g. "claude". */
  name: string;
  /** Free-form product/kind label, e.g. "claude-code". */
  kind: string | null;
  /** Vendor, e.g. "anthropic", "openai", "local". */
  provider: string | null;
  /** Model id, e.g. "claude-opus-4-8". */
  model: string | null;
  /** CLI / surface, e.g. "claude-code". */
  cli: string | null;
  /** Integration version. */
  version: string | null;
}

export interface BoardConfig {
  /** Directory holding the board (the `.octoboard/` folder). */
  boardDir: string;
  /** Absolute path to the SQLite database file. */
  dbPath: string;
  /** Identity this process writes under, e.g. "claude". */
  agent: string;
  /** Product/kind label for the agent, e.g. "claude-code". */
  agentKind: string | null;
  /** Full provider-independent identity for this agent. */
  identity: AgentIdentity;
  /** Active session id for this agent, if one is running. */
  sessionId: string | null;
}

const BOARD_DIRNAME = ".octoboard";
const DB_FILENAME = "board.db";

/**
 * Walk up from `start` looking for an existing `.octoboard/` directory. Returns
 * the directory path if found, otherwise undefined.
 */
export function findBoardDir(start: string = process.cwd()): string | undefined {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, BOARD_DIRNAME);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/**
 * Resolve the board directory for read/write operations. Honors an explicit
 * override (`OCTOBOARD_DIR` or the `--board` flag), then an existing
 * `.octoboard/` up the tree. Falls back to `<cwd>/.octoboard` (the path
 * `init` will create).
 */
export function resolveBoardDir(explicit?: string): string {
  const override = explicit ?? process.env.OCTOBOARD_DIR;
  if (override && override.length > 0) {
    return resolve(override);
  }
  return findBoardDir() ?? join(process.cwd(), BOARD_DIRNAME);
}

/**
 * Provider-independent identity from flags/env. Any AI CLI can populate these
 * with minimal integration; none are required beyond a name.
 */
function resolveIdentity(overrides: ConfigOverrides): AgentIdentity {
  const env = process.env;
  const kind = overrides.agentKind ?? env.OCTOBOARD_AGENT_KIND ?? env.OCTOBOARD_CLI ?? null;
  return {
    name: overrides.agent ?? env.OCTOBOARD_AGENT ?? "anon",
    kind,
    provider: overrides.provider ?? env.OCTOBOARD_PROVIDER ?? null,
    model: overrides.model ?? env.OCTOBOARD_MODEL ?? null,
    cli: overrides.cli ?? env.OCTOBOARD_CLI ?? kind,
    version: overrides.version ?? env.OCTOBOARD_VERSION ?? null
  };
}

export interface ConfigOverrides {
  boardDir?: string;
  agent?: string;
  agentKind?: string;
  provider?: string;
  model?: string;
  cli?: string;
  version?: string;
}

export function loadConfig(overrides: ConfigOverrides = {}): BoardConfig {
  const boardDir = resolveBoardDir(overrides.boardDir);
  const identity = resolveIdentity(overrides);
  return {
    boardDir,
    dbPath: join(boardDir, DB_FILENAME),
    agent: identity.name,
    agentKind: identity.kind,
    identity,
    // An explicit env override wins; otherwise the Board resolves the agent's
    // active session transactionally from the DB's current_sessions table.
    sessionId: process.env.OCTOBOARD_SESSION && process.env.OCTOBOARD_SESSION.length > 0
      ? process.env.OCTOBOARD_SESSION
      : null
  };
}
