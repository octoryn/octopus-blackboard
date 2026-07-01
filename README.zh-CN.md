# Octopus Blackboard（章鱼黑板）

**面向 AI 编码 Agent 的共享记忆与协调层。**

> Agent 不需要另一个老板，它们需要一块共享黑板。

[English](./README.md)

---

Claude Code、Codex、Gemini CLI、Cursor、以及你本地的各种 agent，都在改同一个仓
库——但彼此失明。一个在重构 auth，另一个在改同一个文件。上下文散落在不同 CLI 里，
没人能复盘发生过什么。

Octopus Blackboard **不是 orchestrator。** 它不调度 agent、不触发 agent，也不替
agent 做任何决定。它是一个被动的、本地优先的共享记忆，只回答六个问题：

```text
谁在做什么        →  agents, tasks, claims
改了什么          →  files_changed
决定了什么        →  decisions
有什么证据        →  evidence
有哪些未决风险    →  risks
给谁留了什么话    →  messages, handoffs
```

每个 agent 只需要能够 **读黑板、写黑板、留言、附证据**。这就是全部契约。

## 为什么

企业真正怕的，不是 agent 不够聪明，而是：

- 多个 AI 工具同时改代码
- 上下文散落在不同 CLI
- 没有共享记忆、没有审计、没有 handoff
- 没有冲突认知、无法复盘

黑板正好切中这一点。每一次写入，都会向 append-only 的 `timeline` 追加一条
**防篡改的哈希链条目**，因此整段历史可审计、可复盘——任何对早期条目的事后修改都
会导致校验失败。

## 安装

```bash
npm install
npm run build      # 编译到 dist/
```

需要 Node ≥ 22。黑板就是 `.octoboard/` 下的单个 SQLite 文件，从当前工作目录向上
查找（类似 `.git`）。

## CLI

```bash
octoboard init                                   # 在此处创建 .octoboard/
octoboard status                                 # 当前谁在黑板上

octoboard note "Codex is refactoring auth middleware"
octoboard claim trust-layer-policy-schema        # 认领工作；冲突时告警
octoboard message claude "Review policy edge cases before merge"
octoboard decision "Use hash-chain audit log" --why "tamper-evidence"
octoboard risk "Migration may break audit replay" --severity high
octoboard file src/auth.ts --change modified --task trust-layer-policy-schema
octoboard handoff claude "Tests pass except policy replay" --task trust-layer-policy-schema

octoboard timeline                               # 完整的哈希链历史
octoboard verify                                 # 校验链条是否完好
```

身份通过 `--as <agent>` 或环境变量 `OCTOBOARD_AGENT` 设置。用 `--board <dir>` 或
`OCTOBOARD_DIR` 指向特定黑板。

### 冲突认知

黑板从不阻塞——它只**暴露**。如果两个 agent 认领同一个 key，或改动同一个 task 的
文件，两次写入都会被记录，并对后来者告警：

```text
⚠ CONFLICT: "trust-layer-policy-schema" is also held by codex. Both claims recorded.
```

## AI 归属与共享开发记忆

Git 记录的是谁 **push** 了 commit。它不记录:是哪个 AI agent 产出了代码、在哪个
session、在哪台机器、是否被另一个 AI review 过、是否有人类批准过。随着 AI 原生开
发普及,问责必须超越 Git authorship。

黑板在 Git **之上**加一层归属——它绝不 rewrite 历史。Git 仍是代码的真相源,黑板
成为归属的真相源。

### Session(会话)

session 是一个 agent 的一段连续执行,也是归属挂靠的单位。开启后,后续每次写入都归
属到它(活跃 session 会跨 CLI 调用按 agent 记住):

```bash
export OCTOBOARD_AGENT=claude OCTOBOARD_PROVIDER=anthropic \
       OCTOBOARD_MODEL=claude-opus-4-8 OCTOBOARD_CLI=claude-code

blackboard session start --label "auth work"   # 捕获机器、分支、仓库
blackboard claim policy-engine
blackboard file src/policy.ts --change modified
# ... 做一次 git commit ...
blackboard link HEAD                            # 把该 commit 的文件归属出去
blackboard session stop
```

身份完全 provider-independent——`--provider`、`--model`、`--cli` 或对应的
`OCTOBOARD_*` 环境变量。任何 AI CLI(本地或云端)都能自我注册,不对任何厂商做假设。

### 关联 commit

`blackboard link <rev>` 通过 Git 读取该 commit 改动的文件,为活跃 session 每个文件
记一条归属。可选地在 `refs/notes/blackboard` 下写一条 additive 的 `git notes`:

```bash
blackboard link HEAD --note
blackboard attribute <sha> --file src/x.ts --actor human --name Ran  # 手动
```

### Review

```bash
blackboard review HEAD --by ai   --name codex --outcome approved --note "tests pass"
blackboard review HEAD --by human --name Ran   --outcome approved
```

### 查询共享记忆

```bash
blackboard who src/auth.ts             # git 作者 + 触碰过它的 AI session
blackboard who src/auth.ts --line 42   # 哪个 session 引入了这一行
blackboard explain HEAD                # 归属 + review + 相关决策
blackboard commits claude-code         # 哪些 commit 来自某个 AI / CLI
blackboard unreviewed                  # 从未经人类 review 的 AI commit
blackboard joint claude codex          # 被两个 agent 同时改过的文件
blackboard timeline --session <id>     # 单个 session 的 HH:MM 时间线
```

每一条归属、review、session、决策都会同时记入哈希链 `timeline`,因此完整的问责历
史防篡改、可复盘。`blackboard` 与 `octoboard` 是同一个命令。

## 治理与问责链

归属的意义在于**能落地约束**。从"干活"到"合并门禁"的完整链路:

```text
agent work → commit attribution → export/import → CI check → human-review gate
```

### CI 门禁(`check`)

把查询变成可执行门禁。只读——报告 pass/fail 并以非零退出;真正 block 的是 CI 系统,
黑板从不阻塞。

```bash
# CI 里,在 PR 分支上——存在未经人类 review 的 AI commit 就让构建失败:
blackboard check --range origin/main..HEAD --require-human-review
echo $?   # 0=通过, 1=有违规

blackboard check            # 默认门禁:校验链 + 要求人类 review
```

### 可携带性(`export` / `import` / `trailers`)

归属是本地优先的;这几条让它活过 `git push`,进入团队板子或 CI:

```bash
blackboard export --range origin/main..HEAD --out attribution.json  # 开发机上
blackboard import attribution.json                                   # 团队板 / CI 上
blackboard trailers HEAD                                             # commit message 用的 trailer 行
```

`import` 幂等(按行 id 去重)。bundle 携带 attributions、reviews、sessions、相关 decisions。

### 订阅(`watch`)

补齐 read/write/**subscribe**/message 契约。被动:轮询并报告,绝不推工作。

```bash
blackboard watch --for claude     # 只提示发给我的 message/handoff/冲突
blackboard watch                  # 全量流
blackboard watch --once           # 一次性轮询(脚本用)
```

### 签名 session(`sign` / `verify`)

最小身份(v0):每个 session 一对 Ed25519 密钥(私钥留本地 `.octoboard/keys/`,已
gitignore)。对 timeline head 签名,让 `verify` 区分**可信**与仅仅"自证":

```bash
blackboard sign        # 用当前活跃 session key 对 head 签名
blackboard verify      # 链完整性 + 哪些 session 签过、trusted/stale
```

`session stop` 时自动对 head 签名。一旦任何更早的历史被改动,覆盖该 head 的签名就变
**stale**——即使签名本身在密码学上仍有效,篡改也会显形。这还不是完整 PKI(无密钥分
发/吊销)。

## MCP 服务器

任何支持 MCP 的 agent 都能直接读写黑板。注册服务器（stdio transport）：

```json
{
  "mcpServers": {
    "blackboard": {
      "command": "npx",
      "args": ["octopus-blackboard-mcp"],
      "env": { "OCTOBOARD_AGENT": "claude", "OCTOBOARD_DIR": "/path/to/repo/.octoboard" }
    }
  }
}
```

提供的工具：`board_status`、`board_timeline`、`board_note`、`board_claim`、
`board_message`、`board_inbox`、`board_decision`、`board_evidence`、
`board_file_changed`、`board_risk`、`board_handoff`;归属层:`session_start`、
`session_stop`、`board_link`、`board_attribute`、`board_review`、`board_who`、
`board_explain`、`board_unreviewed`;以及治理链:`board_check`、`board_export`、
`board_import`、`board_trailers`、`board_since`、`board_sign`、`board_trust`。每个
工具都接受可选的 `agent` 参数,用于按调用覆盖身份。

推荐模式：agent 在**开始工作前**调用 `board_status` 看看其他人在干什么，然后边做
边写。

## 数据模型

| 层 | 表 | 作用 |
|---|---|---|
| **谁在场** | `agents`、`sessions` | provider 无关的身份、session 上下文 |
| **正在发生** | `tasks`、`messages`、`handoffs` | 协调——认领、留言、交接 |
| **谁产出了什么** | `attributions`、`reviews` | AI/人类归属与 review,以 commit 为键 |
| **沉淀的事实** | `decisions`、`evidence`、`files_changed`、`risks`、`timeline` | 可审计的共享记忆 |

`timeline` 是 append-only 的哈希链，所有其他写入也会记录进去，因此黑板与它的审计
日志永远不会发散。

## 技术形态

```text
better-sqlite3（本地优先，默认）
  + MCP 服务器   （读 / 写黑板）
  + CLI          （octoboard ...）
  + 哈希链审计日志（timeline）
  + 可选 Postgres sync   （规划中）
  + 可选 git / file watcher（规划中）
```

## 状态

早期 MVP（v0.1）。已可用:本地 SQLite 黑板、CLI(`octoboard` / `blackboard`)、
MCP 服务器、可校验的哈希链 timeline、一等 session、provider 无关的 AI/人类归属(挂
到 Git commit)、review,以及查询层(`who`、`explain`、`commits`、`unreviewed`、
`joint`)。Git 集成为只读 + additive `git notes`——绝不 rewrite 历史。Postgres
同步与变更订阅在路线图上。

## 许可证

AGPL-3.0-or-later © Octoryn。见 [LICENSE](./LICENSE)。
