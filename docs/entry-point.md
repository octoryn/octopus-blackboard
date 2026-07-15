# Why adopt Blackboard first

[简体中文](./entry-point.zh-CN.md)

Most infrastructure asks you to change how you work before it gives you
anything back. Blackboard is the opposite: it is the **cheapest, lowest-risk
entry point** into the Octopus stack, and it pays off the moment a second agent
touches your repo.

## The one-minute case

- **One command.** `npx octopus-blackboard quickstart` initializes the board,
  detects your MCP client, and hands you a paste-ready config. No account, no
  server to run, no schema to design.
- **Works today, with tools you already have.** You do not need an orchestrator,
  a scheduler, or the rest of the stack. Claude Code and Cursor pointed at the
  same `.octoboard/` already share memory. That is the whole product.
- **Local-first and offline.** The board is a single SQLite file under
  `.octoboard/`, discovered by walking up from your working directory like
  `.git`. Nothing leaves your machine. No network call is required to read or
  write it.
- **Additive, never in the way.** Blackboard is *not* an orchestrator. It does
  not schedule agents, trigger them, or decide anything on their behalf. It
  records and exposes; agents decide. You can stop using it and delete one
  directory.

## What you actually get on day one

Two agents on the same repo are normally blind to each other — one refactors
auth while another rewrites the same file, context scatters across CLIs, and
nobody can replay what happened. With the board:

- **Shared coordination memory** — who is working on what, what changed, what
  was decided, what risks are open, what was handed off to whom.
- **Conflict awareness** — the board never blocks; it *surfaces*. If two agents
  claim the same key or touch the same task's files, both writes are recorded
  and the second agent is warned.
- **A tamper-evident timeline** — every write appends a hash-chained entry to an
  append-only log. The history is auditable and replayable, and any
  after-the-fact edit to an earlier entry breaks verification.

## The timeline is the source of truth other tools build on

Blackboard is deliberately a **capture layer**. Its philosophy (since v0.2.1) is
simple: *protocols transport facts; consumers derive meaning.* The board records
what happened as plain, verifiable facts on the timeline. It does not try to
interpret them for you.

That is exactly what makes it a good *first* adoption. Because the timeline is a
neutral, tamper-evident record — not a proprietary workflow — anything you add
later reads from a foundation that is already trustworthy. You are not betting on
a workflow engine; you are writing down facts you will want regardless of what
else you adopt.

## Honest about the roadmap

To be clear about what exists versus what is planned:

- **Available today:** the local SQLite board, the CLI (`octoboard` /
  `blackboard`), the MCP server any client can connect to, the hash-chained
  timeline, sessions, provider-independent AI/human attribution keyed to Git
  commits, reviews, the query layer, and the read-only `serve` dashboard.
- **Beta / roadmap boundary:** Postgres sync target support exists for portable
  attribution records, with live CI coverage; operating it at scale and change
  subscriptions are still hardening. Deeper integration with other Octopus repos
  — for example, a richer bridge to **octopus-evidence** so that evidence
  captured on the board flows into a dedicated evidence and verification layer
  — is **future work, not a current feature.** Today Blackboard stays a capture
  layer: it records evidence as facts, and leaves the
  derivation of meaning to consumers. Do not adopt it expecting an
  evidence-verification pipeline that is not yet built.

Adopt Blackboard first because it is useful *by itself*, on the tools you
already run, with nothing else installed. Everything else in the stack is
optional and additive on top of a timeline you can already trust.

## Next steps

- Run `npx octopus-blackboard quickstart` and paste the config it prints.
- Read the [README](../README.md) for the full CLI and MCP tool surface.
- See [`examples/two-agents.sh`](../examples/two-agents.sh) for the flagship
  two-agent scenario end to end.
