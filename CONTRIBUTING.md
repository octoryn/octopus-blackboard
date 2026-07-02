**English** | [简体中文](CONTRIBUTING.zh-CN.md)

# Contributing to Octopus Blackboard

Thanks for your interest in contributing. This guide covers the basics.

> **Multiple agents or sessions?** Read
> [docs/development-workflow.md](docs/development-workflow.md) first: one session =
> one worktree = one branch, no direct commits to `main`, and no tag/release/publish
> without explicit human approval. Background: [ADR 0001](docs/adr/0001-shared-worktree-collision.md).

## Development setup

```bash
npm install
npm run build       # tsc → dist/
npm run cli -- --help   # run the CLI from source (tsx)
```

Requires Node ≥ 22.

## Before opening a PR

Run the full local gate — CI runs the same checks:

```bash
npm run typecheck     # tsc --noEmit, must be clean
npm run lint          # eslint
npm run format:check  # prettier (run `npm run format` to fix)
npm test              # vitest
```

- **Type safety:** the project is `strict`. Avoid `any` except at well-considered
  boundaries (dynamic JSON, untyped libs), and comment it.
- **Tests:** new behavior needs tests. Tests must be **hermetic** — unique temp
  dirs (`tests/helpers.ts`), no external network, cleaned up. Git-dependent
  tests create a throwaway repo and `chdir` into it.
- **The passive boundary is load-bearing.** The blackboard only records, shares,
  and exposes. It must never orchestrate, execute, assign, trigger, or schedule
  an agent. A feature that does any of those does not belong here.
- **The hash chain is an invariant.** Every mutation appends one `timeline`
  entry inside the *same* transaction as its entity write (and the `meta` head
  anchor). Never append outside a transaction; never mutate a stored timeline
  row. `npm test` includes tamper/truncation regression tests — keep them green.
- **Git integration is read-only + additive.** `src/git.ts` may read Git or
  write `git notes`; it must never rewrite history. User-controlled revs/paths
  go through `--end-of-options` / `--`.
- **Docs are bilingual.** Every Markdown doc ships in English and 简体中文
  (`X.md` + `X.zh-CN.md`), cross-linked, with sections kept in sync. Update both
  in the same PR.

## Project layout

- `src/board.ts` — the `Board` class, the single owner of the SQLite database.
- `src/db.ts` — schema + additive migrations. `src/{cli,mcp}.ts` — entry points.
- `src/{git,serve,sync,signing,adapters,mcp-config}.ts` — feature modules.
- `docs/attribution.md` — the attribution data flow and its boundaries.
- `examples/two-agents.sh` — the end-to-end scenario.

## Commit / PR

- Keep PRs focused. Describe what changed and why.
- Update `CHANGELOG.md` (Unreleased section) for user-facing changes.
- Update the relevant docs (`README.md`, `README.zh-CN.md`, `docs/`) when you
  change the CLI / MCP / library surface.

## Reporting bugs / security issues

File a normal issue for bugs. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
