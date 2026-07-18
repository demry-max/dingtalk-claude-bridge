# dingtalk-claude-bridge

**把 Claude Code 接进钉钉** —— 单聊或群里 @机器人，让 Claude 回答问题、看图片、听语音（钉钉自带转写）、读文件，并保持上下文连续。走钉钉 **Stream 模式**长连接，**无需公网服务器、域名、回调地址**，跑在一台装有 Claude Code 的电脑上即可。

**Chat with Claude Code from DingTalk** — DM the bot or @mention it in groups. Uses DingTalk Stream Mode (WebSocket), so no public server is required.

姊妹项目：[feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge)（飞书版）· [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge)（企业微信版）

## 特性

- 🔌 **零公网依赖**：钉钉 Stream 模式长连接收消息
- 🧠 **会话记忆**：每个会话映射一个 Claude session（`--resume` 续聊）；`/new` 重开，`/status` 查看
- 🗂️ **Agent 工作区**：workspace 内置 CLAUDE.md 人格 + `memory/` 长期记忆（说「记住…」自动落盘、跨会话生效）+ `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md 并在后续会话自动加载）
- 🖼️ **多消息类型**：文本 / 图片（Claude 直接看图）/ 语音（钉钉自动转写）/ 文件 / 图文混排
- 🔐 **权限分级**：首个单聊者自动成为 owner（本机只读工具 + 联网）；其他成员仅联网检索
- 💰 **用订阅不用 API Key**：`claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS + Windows**（cross-spawn 兼容 `.cmd`）

## 快速开始

**1. 钉钉开放平台配置（约 3 分钟）**：到 [open.dingtalk.com](https://open.dingtalk.com/) → 应用开发 → 创建**企业内部应用**：

1. 应用能力 → 添加「**机器人**」，消息接收模式选「**Stream 模式**」
2. 凭证与基础信息：记下 **Client ID / Client Secret**
3. 版本管理与发布 → 发布应用
4. 单聊：钉钉里搜机器人名字直接发消息；群聊：群设置 → 机器人 → 添加

**2. 部署**：

```bash
npm install -g @anthropic-ai/claude-code   # 安装/更新 Claude Code CLI
claude /login                              # 弹出登录链接，浏览器完成授权

git clone https://github.com/demry-max/dingtalk-claude-bridge.git
cd dingtalk-claude-bridge
npm install
# 把 Client ID / Client Secret 填入 .env（DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET）
npm start
```

然后在钉钉里给机器人发「你好」。**第一个单聊它的人自动成为 owner**。开机自启参考 [docs/部署手册](docs/钉钉-Claude-机器人部署手册.md) 最后一节（macOS launchd / Windows 启动项）。

> 完整手册（可直接丢给 Claude Code 说「按手册部署」）：[docs/钉钉-Claude-机器人部署手册.md](docs/钉钉-Claude-机器人部署手册.md)

## 架构

```
钉钉单聊 / 群 @机器人
        │  Stream 模式长连接（TOPIC /v1.0/im/bot/messages/get）
        ▼
桥接服务（Node.js 常驻：去重、串行队列、owner 鉴权、消息解析、文件下载）
        │  spawn: claude -p --resume <会话ID> --allowedTools …（提示词走 stdin）
        ▼
Claude Code CLI（无头模式）→ sessionWebhook 回复 markdown（降级纯文本）
```

## 安全

- `.env`（Client Secret）与运行数据均被 `.gitignore` 排除
- 非 owner 无本机文件权限；附件目录仅只读放行
- 默认只授予 Claude 只读工具；勿给无人值守机器人开 Write/Bash

## License

[MIT](LICENSE)
