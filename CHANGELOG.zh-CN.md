[English](CHANGELOG.md) | **简体中文**

# 变更日志

本项目所有重要变更记录于此。格式基于
[Keep a Changelog](https://keepachangelog.com/zh-CN/)，达到 1.0 后遵循语义化版本。

## [0.2.3] - 2026-07-02

### 变更

- **联系方式迁移到 `octopusos.ai` 域名。** 维护者 / 联系人:Ran Tao
  `<ran@octopusos.ai>`(`package.json` author)。安全报告改至
  `security@octopusos.ai`(`SECURITY.md`),行为准则报告改至
  `conduct@octopusos.ai`(`CODE_OF_CONDUCT.md`)。

## [0.2.2] - 2026-07-02

### 变更

- **许可证从 AGPL-3.0-or-later 改为 Apache-2.0。** 由版权持有者(Octoryn)重新授权为
  宽松许可,去除 copyleft / 网络分发义务,便于将 Blackboard 作为感知底座被采用。已更新
  `LICENSE` 文件、`package.json` 与两份 README。

## [0.2.1] - 2026-07-02

### 回退

- 回退 provenance 导出,因为它「解释」了工作,而非仅仅「记录」工作。Blackboard 仍是
  记录 / 感知底座。本次移除 `export-provenance` 命令、`provenance/0` 生产者
  (`src/provenance-export.ts`)及其测试,以及 0.2.0 引入的 README/docs 引用。架构原因:
  **协议传输事实;消费者推导意义。** 导出一个 `issue` / `decision` / `evidence` 图
  (含推断因果边与立场)会让板子替消费者「解释」工作——这是记录层绝不能做的。

## [0.2.0] - 2026-07-01 —— 已被 0.2.1 取代

- 新增了 `export-provenance` 命令,导出签名的 `provenance/0` 图包。**已在 0.2.1 中被
  取代并回退**,原因见上(架构层面);该功能不再向前延续。GitHub 的 `v0.2.0` tag 保留
  以存档——0.2.0 未被抹除,而是被取代。

## [0.1.6] - 2026-07-01

### 文档

- 在 `docs/diagrams/` 新增品牌示意图（SVG 源 + PNG）:README banner、before/after
  对比图、价值流程图、问责链单线图,并嵌入两份 README。

## [0.1.5] - 2026-07-01

### 安全 / 完整性（审核后续）

- **外部锚定**补上末尾截断的缺口。`blackboard anchor` 把当前 head（`seq:hash`）写到
  文件或 git note;`blackboard verify --against <anchor>` 证明被锚定的历史仍存在且未被
  改动（`ok` / `truncated` / `altered`）——即使攻击者 DROP 掉 append-only 触发器再截断
  末尾也会被抓到。新增 `Board.head()` / `verifyAnchor()`。
- **签名 bundle。** `export` 现在用活跃 session 的密钥对 bundle 签名;`import` 会校验并
  报告 `signature ✓ / INVALID / unsigned`。`import --require-signed` 拒收未签名或被篡改
  的 bundle。让 sync 具备来源真实性,而不只是按 id 去重。新增 `Board.verifyBundle()`。
- **消息脱敏现在是真擦除。** 消息正文不再复制进被哈希的 append-only 时间线（summary 只
  存元数据）;正文只存在 `messages.body`,而 `redact` 会抹掉它——所以脱敏一条消息会从
  所有存储位置移除其内容。决策 rationale 同理不再进时间线 payload。
- **一致读快照。** `status`、`report`、`listTaskCards` 现在在单个 SQLite 读快照里执行,
  并发提交无法产生"混了写前写后状态"的视图。

### 说明

- agent **名字**是句柄,不是经过认证的身份;密码学身份来自 session 签名（`sign` /
  `verify`、bundle 签名）。授权判断不要信 `agent` 名字。

## [0.1.4] - 2026-07-01

### 安全 / 完整性

- **append-only 现在在数据库层强制。** `timeline` 上的 `BEFORE UPDATE` /
  `BEFORE DELETE` 触发器拒绝任何连接对审计行的修改或删除——从"靠约定 append-only"
  变成"默认 append-only"。有数据库写权限的攻击者仍可 DROP 触发器,但随后哈希链 +
  head 锚点会检测到篡改。
- **evidence 内容寻址。** 附加本地文件时存储其 SHA-256,因此文件被换/改后可检测。新增
  `verifyEvidence()` / `blackboard evidence-verify`,报告 `ok` / `changed` /
  `missing` / `unhashed`。
- `import` 对纯 no-op 重复导入不再追加审计事件。

经 10 进程并发压测验证(1000 次并发写、0 丢失、0 重复/分叉 seq、链完好、10 个并发认领
同一 key 只产生 1 个任务)。

## [0.1.3] - 2026-07-01

### 变更

- `serve` 看板顶栏改用 Octoryn 品牌 logo（此前是占位 emoji）。README 展示 logo 以及
  看板的真实截图。

## [0.1.2] - 2026-07-01

### 新增

- **任务与看板（Kanban）。** 任务现在带稳定编号（`#145`）、描述、project、影响面
  （blast radius）、风险等级、0–100 进度。新命令 `task add` / `task show` /
  `task status` / `tasks`,以及 `assign` 和 `progress`。**派发即被动通知**——它记录
  被指派人,并在该 agent 收件箱放一条"请查看任务 #N";agent 读到后自己决定是否开工,
  板子从不启动任何人。只读 `serve` 看板新增实时 Kanban（按状态分列;卡片显示编号、
  进度条、负责人、活跃 agent 数、project、风险）。MCP 工具:`board_task_define`、
  `board_task`、`board_tasks`、`board_assign`、`board_progress`。风险可挂到任务上
  （`risk --task`）。

## [0.1.1] - 2026-07-01

### 文档

- 所有文档现在均为**双语**（英文 + 简体中文），文件顶部带语言切换：`README`、
  `docs/attribution`、`CONTRIBUTING`、`SECURITY`、`CODE_OF_CONDUCT`、`CHANGELOG`。
- 修正了两份 README 的 MCP 工具清单,补全所有已发布工具。

### 变更

- 对 `src/` 与 `tests/` 应用 Prettier（仅格式化,无行为变化）。

## [0.1.0] - 2026-07-01

首个公开发布。面向 AI 编码 agent 的共享记忆、归属与治理层——它记录并暴露,绝不编排。

### 新增

- **协调核心** —— 本地优先的 SQLite 板,带防篡改的哈希链 `timeline`（连续性 + head
  锚点检查,能抓中间行与尾部截断）。agents、带冲突认知认领的 tasks、messages、
  handoffs（会出现在收件方 inbox）、risks、decisions、evidence、文件改动记录。
- **AI 归属与共享开发记忆** —— 一等 session,捕获机器/分支/仓库上下文;provider
  无关的 agent 身份（`provider` / `model` / `cli` / `version`）;以 Git commit 为键的
  归属与 review。Git 集成为只读加 additive `git notes`——绝不 rewrite 历史。查询层:
  `who`、`explain`、`commits`、`unreviewed`、`joint`、行级 `blame` → 叙事。
- **治理链** —— `check` CI 门禁（存在未审 AI 工作即非零退出;要求*已批准*的人类
  review）;`export` / `import` 可携带归属 bundle;`trailers`;`watch` / `since` 订阅
  原语;session 签名 v0（Ed25519,`sign` / `verify`,含 trusted/stale/unanchored 状态）。
- **可见性** —— `report` 问责计分卡（review 覆盖率、AI/人类比例、按 agent）;`blame`
  → session 叙事;`serve` 只读 web 看板（零依赖、仅环回）。
- **团队后端** —— `sync` 到共享文件或 Postgres（只同步可携带记录,绝不含私有哈希
  链）;session `heartbeat`,带活跃/陈旧在线状态与实时同文件碰撞告警;`prune` 保留
  与 `redact` 读层脱敏（时间线绝不被 prune）。
- **Transcript 摄取** —— `ingest` 适配器:`generic` 规范化 schema（任意 CLI 的稳定
  路径）加上针对 `claude-code` / `codex` / `gemini` / `grok` 的 tool-use JSONL 启发式。
- **接口** —— `octoboard` / `blackboard` CLI、MCP stdio 服务器（用官方 SDK client 验证
  过）、以及 `mcp-config`——为 Cursor、Claude Code、Codex、Gemini、VS Code、Windsurf
  一步生成客户端配置。含库形式的编程入口。

### 安全

- 面向 Git 的辅助函数使用 `--end-of-options` / `--`,使攻击者可控的 rev 或路径无法被
  当作 `git` 标志（阻止通过 `git show --output` 任意写文件——该路径可经 MCP 触达）。
- 看板默认绑定 `127.0.0.1`（`--host` 显式开放）。
- `redact` 在所有读路径抹掉内容（时间线覆盖层 + 源行）;review 门禁要求已批准的
  outcome;当无法排除尾部截断时,`verify` 会显示 `unanchored` 状态。
- WAL 下 `synchronous=FULL` 保证审计日志耐久;活跃 session 指针事务性地存在 DB 里（无
  跨进程竞态）;session 私钥在 `0700` 目录下为 `0600`。

### 说明

- 经过三轮对抗审核（正确性、安全、持久化、索引）加固。59 个测试。
- 已知 defer 的限制（记录在 `docs/attribution.md`）:合并 commit 归属 0 文件;删除的
  文件被归属为 "produced"。
