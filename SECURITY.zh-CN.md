[English](SECURITY.md) | **简体中文**

# 安全策略

## 报告漏洞

安全漏洞请**不要开公开 issue**。

请通过 GitHub Security Advisories（仓库 Security 页的 "Report a vulnerability"）或
邮件 **security@octopusos.ai** 私下报告。请附上描述、复现步骤和影响。我们力争在几个
工作日内回应。

## 范围说明

黑板是一个本地优先的协调层,通过 MCP 接受多个 AI agent 的输入,因此有几处按设计就与
安全相关:

- **不可信的 MCP 输入** —— MCP 服务器接受任何已连接 agent 的参数。面向 Git 的辅助
  函数把用户可控的 rev/路径经过 `--end-of-options` / `--` 传递,以阻止参数注入(以
  `-` 开头的 rev 绝不能被当作 `git` 标志,例如 `--output=<path>`)。发现绕过请报告。
- **只读看板** —— `blackboard serve` 无鉴权地暴露整块板,默认绑定 `127.0.0.1`。仅在
  可信网络上、在明确需要时才 `--host 0.0.0.0` 暴露到 LAN;它没有任何鉴权。
- **append-only 强制** —— `timeline` 上的 `BEFORE UPDATE` / `BEFORE DELETE` 触发器
  拒绝任何连接对审计行的修改/删除。有 DB 写权限的攻击者能 DROP 触发器,但随后哈希链
  会检测到篡改。
- **脱敏** —— `redact` 在所有读路径隐藏内容。对**消息**现在是真擦除:正文从未写进被
  哈希的时间线(summary 只存元数据),`redact` 会抹掉 `messages.body`。笔记 / 决策的
  防篡改日志按设计保留所记文本——别把必须销毁的机密放进这些。
- **身份在签名前是自证的** —— 任何 agent 都能以任意 `OCTOBOARD_AGENT` 名字写入;名字
  是句柄,不是经认证的身份。密码学身份来自 session 签名（`sign` / `verify`)和已签名
  的 bundle——授权判断不要信 `agent` 名字。
- **防篡改 + 外部锚定** —— 哈希链 + DB 内 head 锚点能检测原地改动与截断。因为有 DB
  写权限的攻击者能两者一起改写,请把 head **锚定到外部**:`blackboard anchor
  --git-note`(或 `--out file`)记录 `seq:hash`,随后 `blackboard verify
  --against <anchor>` 证明被锚定的历史仍存在且未被改动(`ok` / `truncated` /
  `altered`)。
- **sync 真实性** —— `export` 用活跃 session 的密钥对 bundle 签名;`import` 会校验
  (`import --require-signed` 拒收未签名/被篡改的 bundle)。没有签名时,导入的记录按
  面值接受。
- **私钥** —— session 签名密钥放在 `.octoboard/keys/` 下（目录 `0700`、文件 `0600`）,
  绝不离开本机。`.octoboard/` 默认已 gitignore;别把它纳入版本控制。

## 支持的版本

本项目处于 1.0 之前;只有最新版本会收到修复。
