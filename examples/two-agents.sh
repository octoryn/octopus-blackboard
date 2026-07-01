#!/usr/bin/env bash
#
# Two AI agents (Claude Code + Codex) sharing ONE blackboard on the same repo,
# then the governance chain: attribution → review → CI gate.
#
# Run from an empty directory:  bash two-agents.sh
# Requires `octoboard` on PATH  (npm i -g octopus-blackboard),
# or set BB="node /path/to/dist/cli.js".
set -e
BB="${BB:-octoboard}"

# Each agent is just the CLI run under a different identity (env vars). In real
# life these are two different tools each configured via `octoboard mcp-config`.
claude() { OCTOBOARD_AGENT=claude OCTOBOARD_PROVIDER=anthropic OCTOBOARD_MODEL=claude-opus-4-8 OCTOBOARD_CLI=claude-code $BB "$@"; }
codex()  { OCTOBOARD_AGENT=codex  OCTOBOARD_PROVIDER=openai   OCTOBOARD_MODEL=gpt-5        OCTOBOARD_CLI=codex-cli  $BB "$@"; }
human()  { OCTOBOARD_AGENT=ran $BB "$@"; }
hr() { echo; echo "──── $* ────"; }

git init -q; git config user.email dev@x.co; git config user.name Dev
printf ".octoboard/\n" > .gitignore
printf "export function login(u,p){ return u===p }\n" > auth.ts
git add -A; git commit -qm "initial auth service"

hr "Claude claims a task; Codex hits the conflict, takes another"
claude init >/dev/null
claude session start --label "harden auth" >/dev/null
claude claim auth-hardening --title "Harden auth"
codex session start --label "rate limiting" >/dev/null
codex claim auth-hardening          # ⚠ conflict — Claude holds it
codex claim rate-limiting

hr "Claude edits, commits, records a decision, links attribution, hands off"
printf "import {timingSafeEqual} from 'crypto'\nexport function login(u,p){ return u.length===p.length && timingSafeEqual(Buffer.from(u),Buffer.from(p)) }\n" > auth.ts
git commit -qam "constant-time login compare"
claude decision "Use timingSafeEqual" --why "prevents timing side-channel" --commit "$(git rev-parse HEAD)"
claude link HEAD --note
claude handoff codex "auth.ts done; wire the rate limiter" --question "cap at 5/min?"

hr "Codex sees the handoff in its inbox, reviews the commit"
codex inbox
codex review HEAD --by ai --name codex --outcome approved

hr "CI gate blocks: AI commit has no HUMAN approval"
claude check --require-human-review || true

hr "Human approves → gate passes → scorecard"
human review HEAD --by human --name Ran --outcome approved >/dev/null
claude check --require-human-review
claude session stop >/dev/null; codex session stop >/dev/null
claude report

hr "Why does auth.ts line 2 exist?  (blame → narrative)"
claude blame auth.ts 2

hr "Tamper-evidence: verify chain + session signatures"
claude verify
