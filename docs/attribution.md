# Attribution data flow

[简体中文](./attribution.zh-CN.md)

How a change moves from an agent's keystrokes to a queryable, auditable
attribution record — and where the boundaries are.

> Git is the source of **code**. The blackboard is the source of **attribution**.
> The blackboard never rewrites Git history.

## The lifecycle

```mermaid
flowchart TD
    A[agent session start] -->|"captures machine,<br/>branch, repo, identity"| S[(sessions)]
    A --> P[(current_sessions<br/>DB table)]
    P -.->|"active session per agent,<br/>survives CLI restarts"| W

    W[writes: note / claim /<br/>file / decision / handoff] --> TL[(timeline<br/>hash chain)]
    W --> FC[(files_changed)]

    G[git commit] -->|"human runs it;<br/>Git records authorship"| GIT[(Git history)]

    L[blackboard link HEAD] -->|"reads files in commit<br/>(read-only)"| GIT
    L --> ATTR[(attributions<br/>commit → session/agent)]
    L -.->|"optional, additive"| NOTE[/refs~notes~blackboard/]

    R[blackboard review HEAD] --> REV[(reviews)]

    ATTR --> Q{queries}
    REV --> Q
    FC --> Q
    S --> Q
    Q --> Q1[who / explain / commits]
    Q --> Q2[unreviewed / joint / blame]

    ATTR --> TL
    REV --> TL
    S --> TL
```

## Step by step

1. **`session start`** — opens a `sessions` row capturing `machine`,
   `working_directory`, `git_branch`, `repository`, and the agent's
   provider-independent identity (`provider` / `model` / `cli` / `version`). The
   session id is recorded in the `current_sessions` DB table, keyed by agent, so
   every later CLI process (a separate OS process) attributes to it — and
   start/stop are transactional, so concurrent CLIs can't race the pointer.

2. **Work happens** — `note`, `claim`, `file`, `decision`, `handoff`. Each is
   one SQLite transaction that also appends a `timeline` entry. The active
   session id is stamped onto every write and folded into the hash.

3. **The human commits** — an ordinary `git commit`. Git records who *pushed*.
   The blackboard does not touch this step.

4. **`link <rev>`** — resolves the rev to a full sha (`git rev-parse`), reads
   the files the commit touched (`git show --name-only`, read-only), and writes
   one `attributions` row per file, denormalizing the session's
   provider/model/cli so later queries are cheap and stable. `.octoboard/`
   paths are never attributed. With `--note` it also writes an **additive**
   `git notes` entry under `refs/notes/blackboard` — no existing object is
   rewritten.

5. **`review <rev>`** — records a `reviews` row (human or AI, with an outcome).
   Like `link`, it resolves the rev to a full sha so reviews and attributions
   share the same key.

6. **Query** — `who`, `explain`, `commits`, `unreviewed`, `joint`, and
   line-level `blame` read across `attributions`, `reviews`, `files_changed`,
   `sessions`, and Git.

## Why the sha is the join key

`link`, `attribute`, and `review` all resolve their revision argument to a full
commit sha before storing. This is what lets `blackboard review HEAD` clear a
commit that `blackboard link HEAD` attributed earlier — both collapse to the
same 40-char key. Storing the literal `"HEAD"` would silently break
`unreviewed` and `explain`. (There is a regression test for exactly this.)

## What is tamper-evident, and what is not

Everything the blackboard records — every attribution, review, session
boundary, and decision — also lands in the `timeline` hash chain, so after the
fact you cannot quietly alter *who produced what* without `verify` failing.

Each entry's hash covers the previous entry's hash plus a strictly-incrementing
`seq`, and the current head (`seq` + `hash`) is anchored in a `meta` row.
`verify` checks three things: every link recomputes, `seq` is contiguous (a
deleted middle row is caught), and the surviving tail still matches the anchored
head (a deleted *newest* row is caught too). To also defeat an attacker who
edits the anchor, periodically record the head hash somewhere outside the DB
(a commit, a log, a second machine) — the board exposes it via `verify`.

The chain protects the blackboard's own records. It does **not** prove the Git
commit itself is unmodified — that is Git's job (and, if you want cryptographic
commit integrity, signed commits). The two layers compose: Git vouches for the
code; the blackboard vouches for the attribution narrative around it.

Writes serialize safely when several CLIs share one board: each mutation runs in
an *immediate* SQLite transaction, so concurrent writers take turns (bounded by
`busy_timeout`) rather than one silently failing.

## Known limitations (deferred)

- **Merge commits** attribute zero files: `git show --name-only` prints nothing
  for a merge by default, so `link` records a single whole-commit attribution
  with no per-file rows. Attributing a merge's brought-in files needs a
  first-parent/diff-tree decision that is intentionally deferred.
- **Deleted files** in a linked commit are still attributed as "produced,"
  which may be semantically wrong. Deferred pending a clearer model of what
  attribution means for a deletion.

Both are recorded here rather than silently handled, so a consumer of the data
knows the edges.

## Boundaries (by design)

The attribution layer only records, shares, and exposes. It does **not**
orchestrate, execute, assign, trigger, or schedule. `link` and `review` are
explicit, human- or agent-initiated acts — nothing auto-fires on commit. Keeping
attribution a deliberate step is what keeps the blackboard passive.
