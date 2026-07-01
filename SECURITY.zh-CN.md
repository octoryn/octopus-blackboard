[English](SECURITY.md) | **简体中文**

# 安全策略

## 报告漏洞

安全漏洞请**不要开公开 issue**。

请通过 GitHub Security Advisories（仓库 Security 页的 "Report a vulnerability"）或
邮件 **security@octoryn.com** 私下报告。请附上描述、复现步骤和影响。我们力争在几个
工作日内回应。

## 范围说明

黑板是一个本地优先的协调层,通过 MCP 接受多个 AI agent 的输入,因此有几处按设计就与
安全相关:

- **不可信的 MCP 输入** —— MCP 服务器接受任何已连接 agent 的参数。面向 Git 的辅助
  函数把用户可控的 rev/路径经过 `--end-of-options` / `--` 传递,以阻止参数注入(以
  `-` 开头的 rev 绝不能被当作 `git` 标志,例如 `--output=<path>`)。发现绕过请报告。
- **只读看板** —— `blackboard serve` 无鉴权地暴露整块板,默认绑定 `127.0.0.1`。仅在
  可信网络上、在明确需要时才 `--host 0.0.0.0` 暴露到 LAN;它没有任何鉴权。
- **redaction 是读层遮蔽,不是擦除** —— `redact` 在所有读路径上隐藏内容,但原始
  summary 仍留在 timeline 行里,以便哈希链仍可校验。它**不是**密码学擦除;别存你必须
  能销毁的机密。
- **身份在签名前是自证的** —— 任何 agent 都能以任意 `OCTOBOARD_AGENT` 名字写入。
  session 签名（`sign` / `verify`）为已签名的 head 提供密码学归属;未签名的写入是
  声称,而非证明。
- **防篡改有边界** —— 哈希链 + head 锚点能检测原地改动与截断,但有数据库写权限的攻击
  者可以两者一起改写。要强保证,请把 head hash 锚定到外部(一个 commit、一份日志、
  另一台机器);当 `verify` 无法确认尾部时会报 `unanchored` 状态。
- **私钥** —— session 签名密钥放在 `.octoboard/keys/` 下（目录 `0700`、文件 `0600`）,
  绝不离开本机。`.octoboard/` 默认已 gitignore;别把它纳入版本控制。

## 支持的版本

本项目处于 1.0 之前;只有最新版本会收到修复。
