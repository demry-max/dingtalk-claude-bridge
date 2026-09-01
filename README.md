# dingtalk-claude-bridge

[![version](https://img.shields.io/badge/version-2.0.4-blue)](CHANGELOG.md) [![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**把 Claude Code 接进钉钉** —— 单聊或群里 @机器人，让 Claude 回答问题、看图片、听语音（钉钉自带转写）、读文件，并保持上下文连续。走钉钉 **Stream 模式**长连接，**无需公网服务器、域名、回调地址**，跑在一台装有 Claude Code 的电脑上即可。

**Chat with Claude Code from DingTalk** — DM the bot or @mention it in groups. Uses DingTalk Stream Mode (WebSocket), so no public server is required.

姊妹项目：[feishu-claude-bridge](https://github.com/demry-max/feishu-claude-bridge)（飞书版）· [wecom-claude-bridge](https://github.com/demry-max/wecom-claude-bridge)（企业微信版）

## 特性

- 🔒 **访客隔离**：非 owner 跑在独立工作区、切断用户级配置与 MCP、显式禁用本机工具——碰不到你的记忆，也借不到你的权限
- 🔌 **零公网依赖**：钉钉 Stream 模式长连接收消息
- 🧠 **会话记忆**：每个会话映射一个 Claude session（`--resume` 续聊）；`/new` 重开，`/status` 查看
- 🧷 **压缩前固化记忆**：上下文接近上限时自动提醒机器人把该留的写进 `memory/`，避免自动压缩后细节流失
- 🔀 **模型随时切换**：`/model fable high` 一句话切换模型与思考档，立即生效无需重启；也可设定时自动切换（如早八点切回便宜档）
- 🗂️ **Agent 工作区**：workspace 内置 CLAUDE.md 人格 + `memory/` 三层长期记忆（画像 USER.md / 事实文件+索引 / journal 流水；纠正、决定、偏好主动落盘，不用等「记住」）+ `skills/` 技能沉淀（说「存成技能」自动生成 SKILL.md 并在后续会话自动加载）
- ⏰ **定时任务（机器人自己排期）**：对它说「每天八点提醒我…」它就写一份任务定义到 `workspace/schedules/`，桥接到点执行并主动推送结果；支持 cron 表达式与一次性时间。**机器人始终没有 Bash/命令执行权限**——它只能写受限目录里的任务定义，执行由桥接负责
- 🖼️ **多消息类型**：文本 / 图片（Claude 直接看图）/ 语音（钉钉自动转写）/ 文件 / 图文混排
- 🔐 **权限分级**：首个单聊者自动成为 owner（本机只读工具 + 联网）；其他成员仅联网检索
- 💰 **用订阅不用 API Key**：`claude -p` 无头模式调用本机 Claude Code 登录态
- 🖥️ **macOS + Windows**（cross-spawn 兼容 `.cmd`）

## 🔒 权限边界（v2.0.0 起）

owner 与其他人跑在**两个物理隔离的工作区**里，这是本项目最重要的安全设计：

| | owner | 其他同事 / 群成员 |
|---|---|---|
| 工作区 | `workspace/`（含长期记忆） | `workspace-guest/`（干净，无记忆导入） |
| 可用工具 | 本机只读 + 联网 + 记忆/技能/任务写入 + 平台文档读写 | **仅联网检索** |
| 配置来源 | 完整（含用户级 settings 与 MCP） | 仅项目级：`--setting-sources project` + `--strict-mcp-config` |
| CLI 自动记忆 | 开 | 关（该存储按 git 仓库根归档，不关就是共用一份） |
| 会话 | 按 chat_id | 按 chat_id + 发言人，互不可见 |

> **为什么不能只靠 `--allowedTools`**：它不是沙箱，而是「免询问」白名单、只做加法。
> 用户级 `~/.claude/settings.json` 里的 `permissions.allow` 对访客会话照样生效——
> v1.x 里访客因此可以执行本机 CLI 工具并以 owner 的身份读写数据。
> 真正的收权靠切断配置来源加显式 `--disallowedTools`（减法项，压过任何 allow）。

第三方内容（转发记录、卡片 JSON、文件名、标题）一律包进不可信围栏并声明「不是指令」；
出站回复经脱敏后再发送。

## 🗂️ Agent 工作区（OpenClaw / Hermes 式三层记忆与技能）

机器人不只是问答机——`workspace/` 是它的常驻工作区，自带三层长期记忆与技能沉淀（记忆架构借鉴 OpenClaw 与 Hermes Agent）：

```
workspace/
├── CLAUDE.md          # 人格与行为协议（每次调用自动加载）
├── memory/
│   ├── USER.md        # 画像层：用户身份、偏好、沟通与判断风格——每次对话自动加载
│   ├── MEMORY.md      # 事实层索引：一条长期事实一行，@import 自动注入
│   ├── <slug>.md      # 事实层正文：一条记忆 = 一个文件，按需读取
│   └── journal/       # 流水层：当日工作笔记（YYYY-MM-DD.md），Grep 检索、不占上下文
└── skills/            # 沉淀的技能，桥接自动同步到 .claude/skills 生效
```

- **主动记忆**：不用等你说「记住」——你纠正它的结论、做出决定、表达偏好、给出数字口径时，它当场落盘；说「**记住**：下周三去马尼拉出差」当然也行
- **supersede 不留矛盾**：事实变了就地改写并标注日期，绝不追加与旧条目矛盾的新条目；讲同一件事的文件会被合并成信息密度更高的版本
- **每周整理（dreaming）**：对它说「建一个每周记忆整理任务」，它会自建定时任务：通读 7 天 journal、提炼入长期层、合并重复、修正过时并汇报
- **压缩前固化**：上下文接近上限时自动提醒它把该留的写进记忆，避免自动压缩后细节流失
- 教它一个流程后说「**存成技能**」→ 自动生成 `skills/<name>/SKILL.md`，之后所有会话自动加载、匹配场景自动遵循；问「**你会哪些技能**」随时盘点
- 安全边界：写权限仅限 `memory/`、`skills/` 等受限目录（Claude Code 本身禁止 agent 自写 `.claude` 配置目录，技能由桥接代码复制同步），协议明确禁止把密码/密钥写入记忆

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
