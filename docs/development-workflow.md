**English** | [简体中文](development-workflow.zh-CN.md)

# Development workflow (for AI agents and humans)

This project is worked on by multiple AI coding agents (Claude, and others) and by
humans. Git's working tree is **shared mutable state**; without discipline, two
agents collide. One such collision is recorded in
[ADR 0001](adr/0001-shared-worktree-collision.md). These rules prevent it.

> **The one rule:** isolate every session, and let nothing reach `main`, a tag, or
> npm without human-gated review.

## 1. One AI session = one worktree = one branch

Each session works in its **own** checkout and its **own** branch. Never two
sessions in one working tree.

```bash
# Isolated worktree off the latest main (shares the object store, own HEAD/index):
git fetch origin
git worktree add ../octopus-blackboard--<session> -b agent/<session>/<topic> origin/main

# ...or a separate clone if worktrees aren't available. Either way: your own HEAD.
```

- Branch name: `agent/<session-id>/<topic>` (agents) or `<user>/<topic>` (humans).
- Do **all** work there. Do not `checkout` a shared tree that another session uses.
- In agent harnesses that support per-session isolation, launch with a dedicated
  worktree. Do not share one working directory between two agents.
- When done, remove it: `git worktree remove ../octopus-blackboard--<session>`.

## 2. No direct commits to `main`

`main` is integration-only. Agents and humans **never** `commit`, `merge`,
`rebase`, or `push` directly onto `main`.

- Land changes via a **pull request** from your branch.
- `main` must be **branch-protected**: required PR, required review, no direct
  pushes, no force-pushes. (Configuring protection is a repo-admin follow-up; until
  then, treat this rule as binding by convention.)

## 3. No tag / release / publish without explicit human approval

Releasing is a **single-owner, human-gated** action — never a side-effect of a
coding session.

- No `git tag`, no `git push --tags`, no version bump merged to `main`, and no
  `npm publish` without an explicit human "release now" for a named version.
- Route releases through **one designated integrator** or a CI release job, so two
  sessions cannot both release.
- **Tags are immutable once pushed.** Correct a bad release with a new version
  (e.g. `v0.2.1`), not by moving or deleting a tag.

## 4. Review branches are immutable unless a human supersedes them

A review verdict is a decision, not a suggestion.

- Once a branch is **rejected**, it is not to be resurrected, re-merged, or shipped
  by any session. A local `git branch -D` does **not** enforce this — the ref is
  recoverable from the reflog. Enforcement lives in branch protection / required
  review and in this rule.
- Only a **human** may reopen or supersede a rejected decision, explicitly.
- Likewise, do not rewrite or force-update a branch that is under review.

## 5. Integration path: PR → review → merge queue / integrator

1. Open a PR from `agent/<session>/<topic>` into `main`.
2. Independent review (human, or a *different* agent than the author).
3. Merge only through a **merge queue** or a **designated integrator** — one
   serializer, so two changes cannot both fast-forward `main`.
4. Release, if any, is a separate human-approved step (§3).

## Quick checklist (before you touch shared state)

- [ ] Am I in my **own** worktree/branch, not a shared tree? (§1)
- [ ] Am I about to commit/merge/push to `main`? → **stop**, use a PR. (§2)
- [ ] Am I tagging / releasing / publishing? → **stop**, needs human approval. (§3)
- [ ] Am I touching a branch under review or already rejected? → **stop**. (§4)
- [ ] Standard gate green? `npm run typecheck && npm run lint && npm run format:check && npm test`

See also: [CONTRIBUTING.md](../CONTRIBUTING.md) · [ADR 0001](adr/0001-shared-worktree-collision.md)
