# Provenance 导出（`provenance/0`）

[English](./provenance-export.md)

`octoboard export-provenance` 把看板导出为开放 `provenance/0` wire format 下的
**签名、防篡改快照**。这是 Blackboard 的原生能力：一份可移植、可验证的看板内容
导出，用于审计追溯、合规归档、分析，以及在工具之间搬运状态。

`provenance/0` 是一种**开放格式**，不属于任何单一产品。Blackboard 把它作为**自有
基建**实现（Ed25519 签名 + 规范化 JSON，见 `src/provenance-export.ts`）——它是
字节层面的契约，绝非共享库。**很多种系统都能消费这份导出**——审计系统、分析流水线、
治理引擎，或一个 project-memory 引擎。一个 project-memory 引擎只是**众多可能消费者
之一**；Blackboard 既不依赖它、也不是为它而建，即使没有任何消费者，这份导出本身也
完全成立。

## 文档结构

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
  "signature": "<base64 Ed25519，覆盖 canonicalize({issuer, issuedAt, payload})>"
}
```

`externalKey` 是 Blackboard 自己的稳定 id（`bb:risk:…`、`bb:task:…`、
`bb:decision:…`、`ev:commit:…`、`ev:review:…`），因此对任何按它去重的消费者，
重复导出都是幂等的。

## Blackboard 如何映射成 bundle

翻译逻辑住在**生产者**这边——它懂自己的 schema，绝不放到消费者里：

| Blackboard 记录 | 变成 |
| --------------- | ---- |
| `risk`          | 一个 `issue` 节点 |
| `task`          | 一个 `task` 节点 |
| `decision`      | 一个 `decision` 节点（rationale → 边的 `intent`） |
| 一个 decision + 它列出的 task + 该 task 对应的 risk | 一条推断出的 `addresses` 边 |
| `related_commits` | `commit` 证据 |
| `review`        | `supports`（approved）或 `contradicts`（rejected）证据 |

bundle 承载**证据，而非结论**。它从不声称任何东西"trusted"——一份导出该信多少、
该信哪些 issuer，完全由消费者决定。

## 签名

`signature = base64(Ed25519_sign(privateKey, canonicalize({ issuer, issuedAt, payload })))`，
其中 `canonicalize` 是"对象键递归排序"后的 `JSON.stringify`。消费者通过重算这段输入、
并用 `issuer.publicKey` 校验来验签。对 issuer、时间戳或 payload 的任何改动都会使其失效。

## 用法

```bash
octoboard export-provenance --out board.bundle.json          # 临时签名密钥
octoboard export-provenance --key board.key.pem --as-actor my-board
```

有效签名只证明这份导出**可归属且未被篡改**——不代表该 issuer 已被授权。"该信哪些
issuer"是消费者/治理层的事，不在本格式范围内。
