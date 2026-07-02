[English](CONTRIBUTING.md) | **简体中文**

# 为 Octopus Blackboard 贡献

感谢你有兴趣贡献。本指南覆盖基础。

> **多个 agent 或会话?** 先读
> [docs/development-workflow.zh-CN.md](docs/development-workflow.zh-CN.md):一个会话
> = 一个工作树 = 一个分支,不直接向 `main` 提交,未经明确人工批准不打标签/发布/发包。
> 背景见 [ADR 0001](docs/adr/0001-shared-worktree-collision.zh-CN.md)。

## 开发环境

```bash
npm install
npm run build       # tsc → dist/
npm run cli -- --help   # 从源码跑 CLI（tsx）
```

需要 Node ≥ 22。

## 提 PR 之前

跑一遍完整的本地门禁——CI 跑的是同一套检查：

```bash
npm run typecheck     # tsc --noEmit，必须干净
npm run lint          # eslint
npm run format:check  # prettier（用 `npm run format` 修复）
npm test              # vitest
```

- **类型安全**：项目是 `strict`。除了深思熟虑的边界（动态 JSON、无类型库）外避免
  `any`，并加注释。
- **测试**：新行为需要测试。测试必须**自洽（hermetic）**——独立临时目录
  （`tests/helpers.ts`）、无外部网络、用完清理。依赖 git 的测试会建一个一次性仓库并
  `chdir` 进去。
- **被动边界是承重墙。** 黑板只记录、共享、暴露。它绝不编排、执行、分配、触发或调度
  agent。做这些的功能不属于这里。
- **哈希链是不变量。** 每次修改都在与实体写入*同一个*事务里追加一条 `timeline`
  条目（以及 `meta` head 锚点）。绝不在事务外 append;绝不改动已存储的 timeline 行。
  `npm test` 含篡改/截断回归测试——保持它们绿。
- **Git 集成是只读 + additive。** `src/git.ts` 可以读 Git 或写 `git notes`;绝不
  rewrite 历史。用户可控的 rev/路径都经过 `--end-of-options` / `--`。
- **文档双语。** 每个 Markdown 文档都提供英文与简体中文（`X.md` + `X.zh-CN.md`）、
  交叉链接、章节保持同步。同一个 PR 里一起更新。

## 项目结构

- `src/board.ts` —— `Board` 类,SQLite 数据库的唯一所有者。
- `src/db.ts` —— schema + additive 迁移。`src/{cli,mcp}.ts` —— 入口。
- `src/{git,serve,sync,signing,adapters,mcp-config}.ts` —— 功能模块。
- `docs/attribution.md` —— 归属数据流及其边界。
- `examples/two-agents.sh` —— 端到端场景。

## Commit / PR

- PR 保持聚焦。说明改了什么、为什么。
- 面向用户的改动更新 `CHANGELOG.md`（Unreleased 段）。
- 当你改动 CLI / MCP / 库的表面时,更新相关文档（`README.md`、`README.zh-CN.md`、
  `docs/`）。

## 报告 bug / 安全问题

普通 bug 提 issue。安全漏洞请遵循 [SECURITY.md](SECURITY.md),不要开公开 issue。
