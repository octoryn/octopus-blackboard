**English** | [简体中文](0001-shared-worktree-collision.zh-CN.md)

# ADR 0001 — A shared Git working tree caused a review/release collision

- **Status:** Accepted
- **Date:** 2026-07-02
- **Context:** Multiple AI coding agents (Claude sessions) working on this repo.

## Summary

Two AI sessions operated on the **same Git working tree** at the same time. One
session reviewed a feature branch (`feat/provenance-export`) and **rejected** it,
deleting the branch. Minutes later a second session **restored** that branch from
the reflog, committed a **0.2.0 release**, **fast-forward merged it into `main`**,
tagged **`v0.2.0`**, and **pushed to origin** — silently overriding the review
decision. npm was not published, so the blast radius stopped at Git/origin.

This ADR records the incident and adopts the workflow rules that prevent it. See
[development-workflow.md](../development-workflow.md) for the operational rules.

## What happened (evidence)

All operations appear in **one shared `HEAD` reflog** — proof they ran in a single
working tree, not independent checkouts (an independent worktree/clone keeps its
own reflog). Timeline (local time, 2026-07-02):

| time | operation | actor signal |
| ---- | --------- | ------------ |
| 13:10:54 | reviewer checks out `main`, deletes `feat/provenance-export` (REJECT) | machine default identity |
| 13:12:40 | `feat/provenance-export` **recreated** from the reflog SHA `2fbac2c` | machine default identity |
| 13:15:25 | commit `7c3bf62` "release: 0.2.0" | `Octoryn <ran.tao@…>` + `Co-Authored-By: Claude` |
| 13:16:11 | amend → `e818e15` | `Octoryn <ran.tao@…>` |
| 13:16:17 | checkout `main` + **fast-forward merge** → `e818e15` | machine default identity |
| 13:17:01 | `origin/main` **update by push** → `e818e15`; tag `v0.2.0` pushed | — |

Corroborating facts:

- **One** clone on disk; `git worktree list` shows **one** worktree; no
  `.git/worktrees/`.
- The 0.2.0 release commits carry a **different git identity**
  (`Octoryn <ran.tao@outlook.com.au>`) than every prior commit
  (`Octopus Core Pty Ltd <octoryn@octoryn-mbp.local>`), and a
  `Co-Authored-By: Claude Opus 4.8` trailer — a second AI actor.

**Root cause:** a shared-mutable-state race. `HEAD`, the index, and the branch
namespace are global to a working tree. With two writers and no isolation or lock,
one session's `checkout` / `branch -D` / `commit` / `merge` changed the ground
under the other, between two of the reviewer's commands.

## Decision

### 1. Shared Git working trees are unsafe for multiple AI agents

A working tree has exactly one `HEAD`, one index, and one branch namespace — all
mutable, all global to that tree. Concurrent agents have no isolation: any agent's
ref or index operation is immediately visible to and destructive of the others'.
There is no lock and no ownership. This is the same class of bug as unsynchronised
threads sharing memory. **We will not run two agents in one working tree.**

### 2. One AI session = one isolated worktree = one branch

Each session gets its own `git worktree add` (or its own clone) and works on a
single `agent/<session>/<topic>` branch. Isolated `HEAD`/index/branch means one
session physically **cannot** mutate another's state. This alone would have
prevented the incident. (In agent harnesses that support it, launch with
per-session worktree isolation.)

### 3. `main` is not modified directly by agents

Agents commit only to their own branch and land through review — never a direct
commit, fast-forward, or push to `main`. A rejected branch resurrected and
fast-forwarded onto `main` is exactly the failure above. `main` should be
**branch-protected** so a review verdict is *enforced*, not advisory.

> A local `git branch -D` is **not** a durable rejection: any session can restore
> the ref from the reflog (as happened here). Rejection must be enforced by branch
> protection / required review, not by deleting a local ref.

### 4. Release / tag / publish is a gated, single-owner action

Version bump, tag, `git push --tags`, and `npm publish` require **explicit human
approval** and go through one designated integrator (or CI release job). A release
must never be produced as a side-effect of one session while another is
mid-review. Tags are treated as immutable once pushed.

## Consequences

- Agents pay a small setup cost (a worktree/clone per session). Cheap next to a
  silently-overridden review and an unwanted tagged release.
- `main` and tags become trustworthy: what's there passed review and human-gated
  release.
- Enforcement (branch protection, required review, merge queue) is a follow-up
  action, tracked separately; this ADR sets the policy.

## Notes

- **This incident does not itself decide the fate of v0.2.0.** Whether to keep,
  revert, or supersede it with v0.2.1 is a separate human decision. No revert, tag
  deletion, force-push, or npm publish was performed.
- The irony is intentional to record: this is precisely the coordination failure
  Blackboard exists to *surface* — two agents, opposite decisions, shared state,
  no mutual awareness — occurring one layer below Blackboard, in Git itself.
