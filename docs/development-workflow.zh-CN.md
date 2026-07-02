[English](development-workflow.md) | **简体中文**

# 开发工作流(面向 AI agent 与人类)

本项目由多个 AI 编码 agent(Claude 及其他)和人类共同开发。Git 的工作树是**共享的
可变状态**;缺乏纪律时,两个 agent 就会撞车。一次这样的撞车记录在
[ADR 0001](adr/0001-shared-worktree-collision.zh-CN.md)。下述规则用于防止它。

> **唯一铁律:** 隔离每一个会话;未经人工把关的评审,任何东西都不得进入 `main`、
> 标签或 npm。

## 1. 一个 AI 会话 = 一个工作树 = 一个分支

每个会话在**自己的**检出、**自己的**分支上工作。绝不让两个会话共用一个工作树。

```bash
# 基于最新 main 的隔离工作树(共享对象库,拥有自己的 HEAD/索引):
git fetch origin
git worktree add ../octopus-blackboard--<session> -b agent/<session>/<topic> origin/main

# ……或在没有 worktree 时用独立克隆。无论哪种:都拥有你自己的 HEAD。
```

- 分支名:`agent/<session-id>/<topic>`(agent)或 `<user>/<topic>`(人类)。
- **所有**工作都在那里进行。不要 `checkout` 另一个会话正在用的共享工作树。
- 在支持每会话隔离的 agent 框架里,以专属工作树启动。不要让两个 agent 共用一个工作
  目录。
- 完成后移除:`git worktree remove ../octopus-blackboard--<session>`。

## 2. 不直接向 `main` 提交

`main` 只用于集成。agent 与人类**绝不**直接向 `main` 执行 `commit`、`merge`、
`rebase` 或 `push`。

- 通过从你的分支发起的**拉取请求(PR)**落地改动。
- `main` 必须**受分支保护**:必需 PR、必需评审、禁止直接推送、禁止强推。(配置保护
  是仓库管理员的后续动作;在此之前,本规则按约定即视为强制。)

## 3. 未经明确人工批准,不打标签 / 不发布 / 不发包

发布是**单一归属、人工把关**的动作——绝不是编码会话的副作用。

- 未经针对某个具名版本的明确人工「现在发布」,不得 `git tag`、不得
  `git push --tags`、不得把版本号提升合入 `main`、不得 `npm publish`。
- 发布经由**一个指定的集成者**或 CI 发布任务,使两个会话无法同时发布。
- **标签一旦推送即不可变。** 用新版本(如 `v0.2.1`)修正糟糕的发布,而不是移动或
  删除标签。

## 4. 评审中的分支不可变,除非人类明确取代其决定

评审结论是决定,不是建议。

- 一旦某分支被**拒绝**,任何会话都不得将其恢复、重新合并或发布。本地
  `git branch -D` **无法**强制这一点——该引用可从 reflog 恢复。强制力来自分支保护 /
  必需评审,以及本规则。
- 只有**人类**可以明确地重新打开或取代一个被拒绝的决定。
- 同样,不要改写或强制更新一个正在评审中的分支。

## 5. 集成路径:PR → 评审 → 合并队列 / 集成者

1. 从 `agent/<session>/<topic>` 向 `main` 发起 PR。
2. 独立评审(人类,或与作者**不同**的 agent)。
3. 只经由**合并队列**或**指定集成者**合并——单一串行器,使两个改动无法都快进 `main`。
4. 如需发布,则是独立的、经人工批准的步骤(见 §3)。

## 快速检查清单(在你触碰共享状态之前)

- [ ] 我在**自己的**工作树/分支里,而不是共享工作树里?(§1)
- [ ] 我是否正要向 `main` commit/merge/push?→ **停**,走 PR。(§2)
- [ ] 我是否正要打标签 / 发布 / 发包?→ **停**,需人工批准。(§3)
- [ ] 我是否正在动一个评审中或已被拒绝的分支?→ **停**。(§4)
- [ ] 标准门禁通过?`npm run typecheck && npm run lint && npm run format:check && npm test`

另见:[CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md) ·
[ADR 0001](adr/0001-shared-worktree-collision.zh-CN.md)
