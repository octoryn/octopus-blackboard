/**
 * Zero-config onboarding for the blackboard — the single command that makes it
 * the easiest entry point of the stack. `octoboard quickstart` initializes a
 * board in the cwd (if absent), detects which MCP client you are running from
 * the surrounding files, prints a ready-to-paste config snippet, and (unless
 * told not to) proves the board works with one write + one read.
 *
 * This module is purely additive. It does not touch board logic or storage: it
 * reuses the real init path (`Board`), the real board discovery (`config.ts`),
 * and the real config generator (`mcp-config.ts`). Everything here is
 * idempotent and safe to re-run — it never clobbers an existing board or DB.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Board } from "./board.js";
import { findBoardDir, loadConfig } from "./config.js";
import { mcpConfig, type McpClient } from "./mcp-config.js";

/** An MCP client we can auto-detect from files in the working tree. */
export interface DetectedClient {
  /** The `mcp-config` client id to generate a snippet for. */
  client: McpClient;
  /** Human-facing label, e.g. "Claude Code". */
  label: string;
  /** The marker path (relative to cwd) that gave it away, if any. */
  marker: string | null;
}

/**
 * Detection markers, most-specific first. Each entry maps a directory or file
 * that a client leaves in a project to the `mcp-config` client id. Order
 * matters: the first marker found wins.
 *
 * Only markers that are real evidence of a *specific* MCP client are mapped to
 * that client. Two ambiguous markers are deliberately handled conservatively so
 * detection is never confidently wrong (which would send the user to paste the
 * snippet into the wrong config file):
 *   - a bare `.vscode/` is an editor-settings dir, not proof VS Code is your MCP
 *     client — so we require the actual `.vscode/mcp.json`;
 *   - a bare `.mcp.json` is the generic project-scoped MCP config that several
 *     clients read — so it maps to the generic snippet, not to Claude Code
 *     (the definitive `.claude/` marker, checked first, still wins when present).
 */
const DETECTION: { marker: string; client: McpClient; label: string }[] = [
  { marker: ".claude", client: "claude-code", label: "Claude Code" },
  { marker: ".cursor", client: "cursor", label: "Cursor" },
  { marker: ".codex", client: "codex", label: "Codex" },
  { marker: ".gemini", client: "gemini", label: "Gemini CLI" },
  { marker: ".windsurf", client: "windsurf", label: "Windsurf" },
  { marker: join(".vscode", "mcp.json"), client: "vscode", label: "VS Code" },
  // Ambiguous, kept last: recognize an MCP config exists but stay generic.
  { marker: ".mcp.json", client: "json", label: "generic MCP client" },
];

/**
 * Detect the MCP client from the environment by looking for the marker files a
 * client leaves in a project (`.claude/` → Claude Code, `.cursor/` → Cursor,
 * …). Falls back to the generic JSON snippet when nothing matches. Pure: it
 * only reads `cwd`, so a test can point it at a fixture directory.
 */
export function detectClient(cwd: string = process.cwd()): DetectedClient {
  for (const { marker, client, label } of DETECTION) {
    const path = join(cwd, marker);
    if (existsSync(path)) {
      return { client, label, marker };
    }
  }
  return { client: "json", label: "generic MCP client", marker: null };
}

export interface QuickstartOptions {
  /** Where to init / detect from. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Force a specific client instead of auto-detecting. */
  client?: McpClient;
  /** Identity the connected client writes under (defaults to the client id). */
  agent?: string;
  /** Skip the one-write + one-read proof step. */
  noProbe?: boolean;
  /** Use a local build path instead of the published npx bin (dev). */
  localEntry?: string;
}

export interface QuickstartResult {
  /** The `.octoboard/` directory that now holds the board. */
  boardDir: string;
  /** Absolute path to the SQLite database. */
  dbPath: string;
  /** True when this run created the board; false when one already existed. */
  created: boolean;
  /** The detected (or forced) client and how it was found. */
  detected: DetectedClient;
  /** Where to paste the snippet + the snippet itself. */
  config: ReturnType<typeof mcpConfig>;
  /** The write+read proof, unless it was skipped. */
  probe: { seq: number; agents: string[]; chainOk: boolean } | null;
}

/**
 * Run the zero-config quickstart. Idempotent: initializes `.octoboard/` only if
 * absent (reusing the real `Board` init path), never overwrites an existing
 * board or DB. Returns a structured result so callers (CLI, tests) can render
 * or assert on it.
 */
export function runQuickstart(opts: QuickstartOptions = {}): QuickstartResult {
  const cwd = opts.cwd ?? process.cwd();

  // (a) auto-init the board in the cwd if absent — but honor an existing board
  // discovered up the tree (like `.git`), so re-running inside a subdirectory
  // never creates a second, competing board.
  const existingDir = findBoardDir(cwd);
  const boardDir = existingDir ?? join(cwd, ".octoboard");
  const created = !existingDir;

  const detected = opts.client
    ? {
        client: opts.client,
        label: opts.client,
        marker: null as string | null,
      }
    : detectClient(cwd);

  const agent =
    opts.agent ?? (detected.client === "json" ? "claude" : detected.client);

  // Open the board through the real init path. `new Board(...)` → `openDb(...)`
  // creates `.octoboard/board.db` with the full schema when missing and is a
  // no-op (idempotent, `IF NOT EXISTS`) when it already exists.
  const cfg = loadConfig({ boardDir, agent });
  const board = new Board(cfg);

  let probe: QuickstartResult["probe"] = null;
  try {
    // (c) config snippet — reuse the existing generator verbatim.
    const config = mcpConfig(detected.client, {
      agent: opts.agent,
      localEntry: opts.localEntry,
    });

    // (d) optional proof: one write + one read that the board actually works.
    if (!opts.noProbe) {
      const ev = board.note(agent, "quickstart: board is live");
      const status = board.status(agent);
      const chain = board.verifyChain();
      probe = {
        seq: ev.seq,
        agents: status.agents.map((a) => a.name),
        chainOk: chain.ok,
      };
    }

    return {
      boardDir,
      dbPath: cfg.dbPath,
      created,
      detected,
      config,
      probe,
    };
  } finally {
    board.close();
  }
}

/** True if `<dir>` already contains an initialized board DB. */
export function boardExistsAt(dir: string): boolean {
  const db = join(dir, ".octoboard", "board.db");
  return existsSync(db) && statSync(db).isFile();
}

/**
 * Render a quickstart result as the human-facing terminal output: what was
 * initialized, the paste-ready snippet, the 3-line "paste → reload → done"
 * guide, and the proof line.
 */
export function renderQuickstart(r: QuickstartResult): string {
  const lines: string[] = [];
  lines.push("Octopus Blackboard — quickstart");
  lines.push("");
  lines.push(
    r.created
      ? `✓ Initialized a new board at ${r.dbPath}`
      : `✓ Board already present at ${r.dbPath} (left untouched)`,
  );

  const how = r.detected.marker
    ? `detected from ${r.detected.marker}`
    : r.detected.client === "json"
      ? "no client detected — using the generic snippet"
      : "client forced";
  lines.push(`✓ MCP client: ${r.detected.label} (${how})`);

  if (r.probe) {
    const mark = r.probe.chainOk ? "✓" : "✗";
    lines.push(
      `${mark} Proof: wrote timeline entry #${r.probe.seq}; board reports agents [${r.probe.agents.join(", ")}]; audit chain ${r.probe.chainOk ? "intact" : "BROKEN"}`,
    );
  }

  lines.push("");
  lines.push("── Paste this MCP config ──────────────");
  lines.push(`# Add to: ${r.config.path}`);
  if (r.config.note) lines.push(`# ${r.config.note}`);
  lines.push(r.config.content);
  lines.push("");
  lines.push("── You're done in 3 steps ─────────────");
  lines.push("  1. Paste the block above into the config file shown.");
  lines.push(
    "  2. Reload your MCP client (restart it, or reopen the project).",
  );
  lines.push(
    '  3. Ask your agent to call `board_status` — then `board_note "hello"`. That is your first board action.',
  );

  return lines.join("\n");
}
