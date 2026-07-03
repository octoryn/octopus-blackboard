# MCP registry metadata (local only — not submitted)

[简体中文](./registry-metadata.zh-CN.md)

This repo ships a [`server.json`](../server.json) at the root describing the
blackboard MCP server in the shape the official MCP registry expects. It exists
so the metadata is version-controlled, reviewable, and ready — **it is not a
submission.**

## Not submitted anywhere

No part of this repo posts to the external MCP registry or any third-party
service. Publishing `server.json` to a registry is a **separate, founder-gated
step** performed deliberately outside this codebase (e.g. via the registry's
own publisher CLI, with the appropriate namespace ownership proof). Nothing here
does it for you, and nothing here makes a network call to do it.

## Runtime note

The npm package is `octopus-blackboard`. Its published bin that starts the MCP
server over stdio is `octopus-blackboard-mcp` — that is the exact command the
`mcp-config` / `quickstart` snippets use:

```json
{ "command": "npx", "args": ["-y", "octopus-blackboard-mcp"] }
```

When this metadata is eventually submitted, confirm the registry entry resolves
to that same stdio entry point.

## Keeping it in sync

`version` in `server.json` mirrors `package.json`. Bump both together at release
time. (This onboarding cycle does **not** bump the version.)
