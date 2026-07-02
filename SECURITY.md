**English** | [简体中文](SECURITY.zh-CN.md)

# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub Security Advisories ("Report a vulnerability" on the
repository's Security tab) or email **security@octopusos.ai**. Include a
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
- **Append-only enforcement** — `BEFORE UPDATE` / `BEFORE DELETE` triggers on
  the `timeline` refuse modification/deletion of audit rows from any connection.
  A determined attacker with DB access can drop the triggers, but the hash chain
  then detects the tamper.
- **Redaction** — `redact` hides content across all read paths. For **messages**
  it is now true erasure: the body was never written into the hashed timeline
  (metadata-only summary) and `redact` blanks `messages.body`. For notes /
  decisions the tamper-evident log retains the recorded text by design — don't
  put destroy-must secrets in those.
- **Identity is self-asserted until signed** — any agent may write under any
  `OCTOBOARD_AGENT` name; the name is a handle, not an authenticated identity.
  Cryptographic identity comes from session signing (`sign` / `verify`) and
  signed bundles — don't use the `agent` name for authorization.
- **Tamper-evidence + external anchoring** — the hash chain + in-DB head anchor
  detect in-place edits and truncation. Because an attacker with DB write access
  can rewrite both, anchor the head **externally**: `blackboard anchor
  --git-note` (or `--out file`) records `seq:hash`, and `blackboard verify
  --against <anchor>` then proves the anchored history still exists and is
  unaltered (`ok` / `truncated` / `altered`).
- **Sync authenticity** — `export` signs the bundle with the active session's
  key; `import` verifies it (`import --require-signed` refuses unsigned/tampered
  bundles). Without a signature, imported records are taken at face value.
- **Private keys** — session signing keys live under `.octoboard/keys/`
  (`0700` dir, `0600` files) and never leave the machine. `.octoboard/` is
  gitignored by default; keep it out of version control.

## Supported versions

This project is pre-1.0; only the latest version receives fixes.
