# Provenance export (`provenance/0`)

`octoboard export-provenance` emits the board as a **signed, tamper-evident
snapshot** in the open `provenance/0` wire format. This is a Blackboard-native
capability: a portable, verifiable export of what the board has captured, useful
for audit trails, compliance archives, analytics, and moving state between tools.

`provenance/0` is an **open format**, not any one product's format. Blackboard
implements it as its own infrastructure (Ed25519 signing and canonical JSON, in
`src/provenance-export.ts`) — a contract of bytes on the wire, never a shared
library. **Many kinds of system can consume the export** — an audit system, an
analytics pipeline, a governance engine, or a project-memory engine. A
project-memory engine is merely *one possible consumer*; Blackboard neither
depends on it nor is built for it, and this export makes sense with no such
consumer in the picture at all.

## Document shape

```jsonc
{
  "protocol": "provenance/0",
  "issuer":   { "id": "octopus-blackboard", "publicKey": "<base64 DER SPKI Ed25519>" },
  "issuedAt": 1700000000000,
  "payload": {
    "nodes":    [ { "type": "issue|decision|task|evidence", "title": "...", "externalKey": "bb:..." } ],
    "edges":    [ { "from": "...", "to": "...", "relation": "addresses|resolves|implements|...", "intent": "..." } ],
    "evidence": [ { "evidence": "<node key>", "target": "<edge key>", "stance": "supports|contradicts" } ]
  },
  "signature": "<base64 Ed25519 over canonicalize({issuer, issuedAt, payload})>"
}
```

`externalKey` values are Blackboard's own stable ids (`bb:risk:…`, `bb:task:…`,
`bb:decision:…`, `ev:commit:…`, `ev:review:…`) so re-exports are idempotent for
any consumer that dedupes on them.

## What Blackboard maps into a bundle

The translation lives here, with the producer that understands its own schema —
never in a consumer:

| Blackboard record | becomes |
| ----------------- | ------- |
| `risk`            | an `issue` node |
| `task`            | a `task` node |
| `decision`        | a `decision` node (rationale → edge `intent`) |
| a decision + the task it lists + the risk that task addresses | an inferred `addresses` edge |
| `related_commits` | `commit` evidence |
| `review`          | `supports` (approved) or `contradicts` (rejected) evidence |

The bundle carries **evidence, not conclusions**. It never asserts that anything
is "trusted" — how much to believe an export, and which issuers to trust, is
entirely the consumer's decision.

## Signing

`signature = base64(Ed25519_sign(privateKey, canonicalize({ issuer, issuedAt, payload })))`,
where `canonicalize` is `JSON.stringify` with object keys sorted recursively. A
consumer verifies by recomputing that input and checking it against
`issuer.publicKey`. Any change to issuer, timestamp, or payload invalidates it.

## Usage

```bash
octoboard export-provenance --out board.bundle.json          # ephemeral signing key
octoboard export-provenance --key board.key.pem --as-actor my-board
```

A valid signature proves the export is **attributable and untampered** — not that
the issuer is authorized. Deciding which issuers to trust is a consumer/governance
concern, outside this format.
