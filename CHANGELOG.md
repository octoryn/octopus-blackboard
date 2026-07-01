**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
semantic versioning once it reaches 1.0.

## [0.1.2] - 2026-07-01

### Added

- **Tasks & kanban.** Tasks now carry a stable number (`#145`), description,
  project, impact (blast radius), risk level, and 0–100 progress. New commands
  `task add` / `task show` / `task status` / `tasks`, plus `assign` and
  `progress`. **Assigning is passive notification** — it records the assignee
  and drops a "please look at task #N" message in that agent's inbox; the agent
  reads it and decides to act, the board never launches anyone. The read-only
  `serve` dashboard gains a live kanban (columns by status; cards show number,
  progress bar, assignees, active-agent count, project, risk). MCP tools:
  `board_task_define`, `board_task`, `board_tasks`, `board_assign`,
  `board_progress`. Risks can be attached to a task (`risk --task`).

## [0.1.1] - 2026-07-01

### Documentation

- All documentation is now **bilingual** (English + 简体中文) with a top-of-file
  language switcher: `README`, `docs/attribution`, `CONTRIBUTING`, `SECURITY`,
  `CODE_OF_CONDUCT`, `CHANGELOG`.
- Corrected the MCP tool list in both READMEs to include every shipped tool.

### Changed

- Applied Prettier across `src/` and `tests/` (formatting only, no behavior
  change).

## [0.1.0] - 2026-07-01

First public release. A shared memory, attribution, and governance layer for AI
coding agents — it records and exposes; it never orchestrates.

### Added

- **Coordination core** — local-first SQLite board with a tamper-evident,
  hash-chained `timeline` (contiguity + head-anchor checks catch middle-row and
  tail truncation). Agents, tasks with conflict-aware claims, messages, handoffs
  (surfaced in the recipient's inbox), risks, decisions, evidence, file-change
  records.
- **AI attribution & shared development memory** — first-class sessions
  capturing machine/branch/repo context; provider-independent agent identity
  (`provider` / `model` / `cli` / `version`); attribution and reviews keyed to
  Git commits. Git integration is read-only plus additive `git notes` — history
  is never rewritten. Query layer: `who`, `explain`, `commits`, `unreviewed`,
  `joint`, line-level `blame` → narrative.
- **Governance chain** — `check` CI gate (exits non-zero on unreviewed AI work;
  requires an *approved* human review); `export` / `import` portable attribution
  bundles; `trailers`; `watch` / `since` subscribe primitive; session signing v0
  (Ed25519, `sign` / `verify` with trusted/stale/unanchored states).
- **Visibility** — `report` accountability scorecard (review coverage, AI/human
  ratio, per-agent); `blame` → session narrative; `serve` read-only web
  dashboard (dependency-free, loopback-only).
- **Team backend** — `sync` to a shared file or Postgres (portable records only,
  never the private hash chain); session `heartbeat` with active-vs-stale
  liveness and real-time same-file collision warnings; `prune` retention and
  `redact` read-layer redaction (the timeline is never pruned).
- **Transcript ingestion** — `ingest` adapters: a `generic` normalized schema
  (stable path for any CLI) plus a tool-use JSONL heuristic for
  `claude-code` / `codex` / `gemini` / `grok`.
- **Interfaces** — `octoboard` / `blackboard` CLI, an MCP stdio server
  (verified against the official SDK client), and `mcp-config` to generate
  one-step client config for Cursor, Claude Code, Codex, Gemini, VS Code, and
  Windsurf. Programmatic library entry point.

### Security

- Git-facing helpers use `--end-of-options` / `--` so an attacker-controlled rev
  or path cannot be interpreted as a `git` flag (prevents arbitrary file write
  via `git show --output`, reachable over MCP).
- The dashboard binds to `127.0.0.1` by default (opt-in `--host`).
- `redact` blanks content across every read path (timeline overlay + source
  row); the review gate requires an approved outcome; `verify` surfaces an
  `unanchored` state when tail truncation cannot be ruled out.
- `synchronous=FULL` under WAL for audit-log durability; the active-session
  pointer is stored transactionally in the DB (no cross-process race); session
  private keys are `0600` under a `0700` directory.

### Notes

- Hardened across three rounds of adversarial review (correctness, security,
  persistence, and indexing). 59 tests.
- Known deferred limitations (documented in `docs/attribution.md`): merge
  commits attribute zero files; deleted files are attributed as "produced".
