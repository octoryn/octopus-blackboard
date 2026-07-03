**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
semantic versioning once it reaches 1.0.

## [0.3.0] - 2026-07-03

### Added

- **`quickstart` — zero-config onboarding in one command.** `npx octopus-blackboard
  quickstart` (also `octoboard quickstart`) collapses the old 4-5 step setup:
  it initializes `.octoboard/` if absent (reusing the real init path; idempotent,
  never clobbers an existing board), detects your MCP client, prints a
  ready-to-paste config snippet plus a 3-line "paste → reload → done" guide, and
  does one test write + status read to prove the board is live (skip with
  `--no-probe`; force a client with `--client`). New module `src/quickstart.ts`
  exports `detectClient` / `runQuickstart` / `renderQuickstart` / `boardExistsAt`.
- **"Get Started in 2 Minutes"** section at the top of both READMEs, and a
  **`docs/entry-point.md`** (+ zh-CN) narrative on why to adopt Blackboard first.
- A local `server.json` (official MCP-registry schema) as a **starting point** for
  a future registry listing — see `docs/registry-metadata.md`. The actual
  submission is a separate, human-gated step; nothing here contacts a registry.

### Fixed

- **Client auto-detection no longer guesses confidently wrong.** A bare `.vscode/`
  (an editor-settings dir) is no longer reported as "VS Code" — the actual
  `.vscode/mcp.json` is now required; and a bare `.mcp.json` (shared by several
  clients) maps to the generic snippet instead of asserting "Claude Code". The
  definitive `.claude/` marker still wins when present. Prevents pasting the
  snippet into the wrong config file. Found by adversarial review; regression-tested.

## [0.2.4] - 2026-07-02

### Added

- **CI + automated release via GitHub Actions.** `ci.yml` runs the full gate on
  every push/PR; `release.yml` publishes to npm with provenance on a `v*` tag.
  This is the first release cut through the automated pipeline (no locally-held
  token).

### Fixed

- **Packaging:** restored `pg` (and its dependency tree) in `package-lock.json`,
  which had drifted out of sync with `package.json`, so `npm ci` installs cleanly.

## [0.2.3] - 2026-07-02

### Changed

- **Contact details moved to the `octopusos.ai` domain.** Maintainer/contact:
  Ran Tao `<ran@octopusos.ai>` (`package.json` author). Security reports now go to
  `security@octopusos.ai` (`SECURITY.md`), conduct reports to
  `conduct@octopusos.ai` (`CODE_OF_CONDUCT.md`).

## [0.2.2] - 2026-07-02

### Changed

- **License changed from AGPL-3.0-or-later to Apache-2.0.** Relicensed by the
  copyright holder (Octoryn) to a permissive license, removing copyleft/network
  obligations and easing adoption of Blackboard as an awareness substrate. The
  `LICENSE` file, `package.json`, and both READMEs are updated.

## [0.2.1] - 2026-07-02

### Reverted

- Reverts provenance export because it interpreted work instead of only capturing
  it. Blackboard remains a capture/awareness substrate. This removes the
  `export-provenance` command, the `provenance/0` producer
  (`src/provenance-export.ts`) and its tests, and the README/docs references
  added in 0.2.0. The architectural reason: **protocols should transport facts;
  consumers derive meaning.** Emitting an `issue` / `decision` / `evidence` graph
  (with inferred causal edges and stances) made the board interpret work on a
  consumer's behalf, which a capture layer must not do.

## [0.2.0] - 2026-07-01 — superseded by 0.2.1

- Added an `export-provenance` command that emitted a signed `provenance/0` graph
  bundle. **Superseded and reverted in 0.2.1** on architectural grounds (see
  above); the feature is not carried forward. The GitHub `v0.2.0` tag is retained
  for history — 0.2.0 is not erased, it is superseded.

## [0.1.6] - 2026-07-01

### Documentation

- Added brand diagrams under `docs/diagrams/` (SVG source + PNG): a README
  banner, a before/after comparison, the value flow, and the accountability
  chain. Embedded in both READMEs.

## [0.1.5] - 2026-07-01

### Security / integrity (audit follow-ups)

- **External anchoring** closes the truncation gap. `blackboard anchor`
  records the current head (`seq:hash`) to a file or a git note; `blackboard
  verify --against <anchor>` proves the anchored history still exists and is
  unaltered (`ok` / `truncated` / `altered`) — so even an attacker who drops
  the append-only triggers and truncates the tail is caught. New
  `Board.head()` / `verifyAnchor()`.
- **Signed bundles.** `export` now signs the bundle with the active session's
  key; `import` verifies it and reports `signature ✓ / INVALID / unsigned`.
  `import --require-signed` refuses unsigned or tampered bundles. Gives sync
  origin authenticity, not just id-dedup. New `Board.verifyBundle()`.
- **Redaction is now true erasure for messages.** Message bodies are no longer
  duplicated into the hashed, append-only timeline (the summary is metadata-
  only); the body lives solely in `messages.body`, which `redact` blanks — so
  redacting a message removes its content from every storage location.
  Decision rationale likewise no longer goes into the timeline payload.
- **Consistent read snapshots.** `status`, `report`, and `listTaskCards` now
  run inside a single SQLite read snapshot, so a concurrent commit can't yield
  a view that mixes pre- and post-write state.

### Notes

- Agent *names* are handles, not authenticated identities; cryptographic
  identity comes from session signing (`sign` / `verify`, bundle signatures).
  Don't trust the `agent` name for authorization.

## [0.1.4] - 2026-07-01

### Security / integrity

- **Append-only is now enforced at the database layer.** `BEFORE UPDATE` /
  `BEFORE DELETE` triggers on the `timeline` refuse any modification or deletion
  of an audit row from any connection — "append-only by convention" is now
  "append-only by default". A determined attacker with DB access can still drop
  the triggers, but the hash chain + head anchor then detect the tamper.
- **Evidence is content-addressed.** Attaching a local file now stores its
  SHA-256, so a later swap/edit of the file is detectable. New `verifyEvidence()`
  / `blackboard evidence-verify` report `ok` / `changed` / `missing` / `unhashed`.
- `import` no longer appends an audit event on a pure no-op re-import.

Verified by a 10-process concurrency stress test (1000 concurrent writes, 0
lost, 0 duplicate/forked seq, chain intact, one task under 10 racing claims).

## [0.1.3] - 2026-07-01

### Changed

- The `serve` dashboard now shows the Octoryn brand mark instead of a placeholder
  emoji. The README shows the logo and a live screenshot of the kanban dashboard.

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
