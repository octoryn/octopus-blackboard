**English** | [简体中文](SECURITY.zh-CN.md)

# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub Security Advisories ("Report a vulnerability" on the
repository's Security tab) or email **security@octoryn.com**. Include a
description, reproduction steps, and impact. We aim to acknowledge within a few
business days.

## Scope notes

The blackboard is a local-first coordination layer that accepts input from
multiple AI agents over MCP, so a few areas are security-relevant by design:

- **Untrusted MCP input** — the MCP server accepts arguments from any connected
  agent. Git-facing helpers pass user-controlled revs/paths through
  `--end-of-options` / `--` to prevent argument injection (a dashed rev must
  never be read as a `git` flag such as `--output=<path>`). Report any bypass.
- **Read-only dashboard** — `blackboard serve` exposes the whole board with no
  auth and binds to `127.0.0.1` by default. Only expose it on the LAN
  (`--host 0.0.0.0`) on a trusted network; there is no authentication.
- **Redaction is read-layer, not erasure** — `redact` hides content across all
  read paths but the original summary remains in the timeline row so the hash
  chain still verifies. It is **not** cryptographic erasure; do not store
  secrets you must be able to destroy.
- **Identity is self-asserted until signed** — any agent may write under any
  `OCTOBOARD_AGENT` name. Session signing (`sign` / `verify`) provides
  cryptographic attribution for signed heads; unsigned writes are asserted, not
  proven.
- **Tamper-evidence has a boundary** — the hash chain + head anchor detect
  in-place edits and truncation, but an attacker with database write access can
  rewrite both. For strong guarantees, anchor the head hash externally (a
  commit, a log, a second machine); `verify` reports an `unanchored` state when
  it cannot confirm the tail.
- **Private keys** — session signing keys live under `.octoboard/keys/`
  (`0700` dir, `0600` files) and never leave the machine. `.octoboard/` is
  gitignored by default; keep it out of version control.

## Supported versions

This project is pre-1.0; only the latest version receives fixes.
