# MCP 注册表元数据（仅本地——未提交）

[English](./registry-metadata.md)

本仓库在根目录附带了一份 [`server.json`](../server.json)，以官方 MCP 注册表期望的
结构描述了黑板 MCP 服务器。它的存在是为了让这份元数据纳入版本控制、可供评审、随时
就绪——**它并不是一次提交。**

## 未向任何地方提交

本仓库的任何部分都不会向外部 MCP 注册表或任何第三方服务发送内容。将 `server.json`
发布到注册表是一个**独立的、需创始人把关的步骤**，会在本代码库之外有意执行（例如
通过注册表自身的发布 CLI，并附带相应的命名空间所有权证明）。这里没有任何代码替你
执行它，也没有任何代码为此发起网络请求。

## 运行时说明

npm 包名为 `octopus-blackboard`。其发布的、通过 stdio 启动 MCP 服务器的 bin 是
`octopus-blackboard-mcp`——这正是 `mcp-config` / `quickstart` 片段所使用的命令：

```json
{ "command": "npx", "args": ["-y", "octopus-blackboard-mcp"] }
```

将来提交这份元数据时，请确认注册表条目解析到同一个 stdio 入口。

## 保持同步

`server.json` 中的 `version` 与 `package.json` 保持一致。发布时一并升级两者。（本次
上手周期**不**升级版本。）
