# 钉钉 ⇆ Claude 机器人部署手册

> **给 Claude 的指令**：按步骤 0→9 顺序执行，源码原样写入不要改动。人工动作只有两个：步骤 0 登录 Claude、步骤 7 在钉钉后台建应用取凭据。
>
> **效果**：钉钉单聊/群 @机器人 → 本机 Claude Code 回答（文本/图片/语音/文件/图文均可），会话持久续聊。走钉钉 Stream 模式长连接，无需公网服务器。前置：macOS 或 Windows、Node ≥ 18。

## 步骤 0：安装/更新 Claude Code CLI 并登录

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

然后**必须执行**登录引导：运行 `claude /login`，终端会自动弹出登录链接/二维码——**把登录链接原样呈现给用户，让用户在浏览器完成授权**（用 Claude 订阅账号登录，机器人之后就用这个登录态，不消耗 API Key）。用户确认登录完成后再继续；若机器此前已登录，向用户确认沿用当前账号即可。

## 步骤 1：初始化项目

```bash
mkdir -p ~/dingtalk-claude-bridge/src ~/dingtalk-claude-bridge/scripts/windows ~/dingtalk-claude-bridge/workspace
cd ~/dingtalk-claude-bridge
npm init -y
npm pkg set type=module scripts.start="node src/index.js"
npm install dingtalk-stream dotenv cross-spawn
```

## 步骤 2：写入 `.env` 与 `.gitignore`

`.env`（前两项待步骤 7 从钉钉后台取得后填入）：

```bash
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=

ALLOWED_TOOLS=Read,Grep,Glob,WebSearch,WebFetch   # owner 可用工具
NON_OWNER_TOOLS=WebSearch,WebFetch                # 其他成员可用工具
CLAUDE_MODEL=                                     # 留空=默认；可填 haiku/sonnet/opus
CLAUDE_TIMEOUT_MS=300000
```

`.gitignore`：

```
node_modules/
.env
data/
workspace/
bridge.log
.DS_Store
```

## 步骤 3：写入 `src/store.js`

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const OWNER_FILE = path.join(DATA_DIR, 'owner.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function loadOwner() {
  return readJson(OWNER_FILE, {}).open_id ?? null;
}

export function saveOwner(openId) {
  fs.writeFileSync(OWNER_FILE, JSON.stringify({ open_id: openId }, null, 2));
}

export function loadSessions() {
  return readJson(SESSIONS_FILE, {});
}

export function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}
```

## 步骤 4：写入 `src/claude.js`

```js
import spawn from 'cross-spawn'; // Windows 下 claude 是 .cmd，原生 spawn 会 EINVAL
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions, saveSessions } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
export const WORKSPACE_DIR =
  process.env.WORKSPACE_DIR || path.resolve(__dirname, '..', 'workspace');
const ALLOWED_TOOLS =
  process.env.ALLOWED_TOOLS ?? 'Read,Grep,Glob,WebSearch,WebFetch';
// 非 owner（同事/群成员）不给本机文件工具，只允许联网检索
const NON_OWNER_TOOLS = process.env.NON_OWNER_TOOLS ?? 'WebSearch,WebFetch';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 300_000);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';

const sessions = loadSessions(); // { [chatId]: sessionId }

export function resetSession(chatId) {
  delete sessions[chatId];
  saveSessions(sessions);
}

export function sessionInfo(chatId, isOwner = false) {
  const sid = sessions[chatId];
  const tools = isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS;
  return [
    `**会话状态**`,
    `- Claude session: ${sid ? `\`${sid}\`` : '（无，下一条消息将新建）'}`,
    `- 工作目录: \`${WORKSPACE_DIR}\``,
    `- 你的身份: ${isOwner ? 'owner' : '普通成员'}`,
    `- 允许工具: ${tools || '（无）'}`,
  ].join('\n');
}

export function runClaude(chatId, prompt, isOwner = false, extraTools = []) {
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'json'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS, ...extraTools]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI 超时（${CLAUDE_TIMEOUT_MS / 1000}s）`));
    }, CLAUDE_TIMEOUT_MS);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout) {
        return reject(
          new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`)
        );
      }
      try {
        const out = JSON.parse(stdout);
        if (out.session_id) {
          sessions[chatId] = out.session_id;
          saveSessions(sessions);
        }
        if (out.is_error) {
          return reject(new Error(String(out.result ?? 'unknown error').slice(0, 500)));
        }
        resolve(out.result ?? '');
      } catch {
        // 非 JSON 输出时原样返回
        resolve(String(stdout).trim());
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
```

## 步骤 5：写入 `src/index.js`

从仓库 [src/index.js](../src/index.js) 原样复制（钉钉 Stream 长连接、消息解析、文件下载、sessionWebhook 回复、owner 鉴权、去重与串行队列）。若无法访问仓库，向用户索取该文件内容。

## 步骤 6：验证 claude CLI

```bash
cd ~/dingtalk-claude-bridge/workspace && claude -p --output-format json --model haiku "只回复两个字：正常"
```

预期 JSON 中 `result` 为「正常」。若报 401，回到步骤 0 重新登录。

## 步骤 7：钉钉后台建应用（人工，约 3 分钟）

引导用户到 [open.dingtalk.com](https://open.dingtalk.com/) → 应用开发 → 创建**企业内部应用**：

1. 应用能力 → 添加「**机器人**」，消息接收模式选「**Stream 模式**」（不用填回调地址）
2. 凭证与基础信息：复制 **Client ID / Client Secret**，填入 `.env`
3. 版本管理与发布 → **发布应用**

## 步骤 8：启动并验证

```bash
cd ~/dingtalk-claude-bridge && npm start
```

让用户在钉钉搜索机器人名字发「你好」（群聊则把机器人加进群后 @ 它）。**第一个单聊者自动登记为 owner**。收到回复即部署完成。

## 步骤 9：常驻自启

与 [feishu-claude-bridge 手册步骤 11](https://github.com/demry-max/feishu-claude-bridge/blob/main/docs/%E9%A3%9E%E4%B9%A6-Claude-%E6%9C%BA%E5%99%A8%E4%BA%BA%E6%9E%B6%E8%AE%BE%E6%96%B9%E6%A1%88.md) 完全相同：macOS 用 launchd（`examples/launchd.example.plist` 模板，路径与 Label 换成 dingtalk-claude-bridge），Windows 用 `scripts/windows/install-startup.ps1` 启动项脚本。

---

## 附录：使用与排查

| 项目 | 说明 |
|------|------|
| 用法 | 单聊直接对话；群里 @机器人；图片/语音/文件均可；`/new` 开新会话；`/status` 查状态 |
| 权限分级 | 首个单聊者 = owner（本机只读工具 + 联网）；其他人仅 WebSearch/WebFetch；改 `.env` 调整 |
| 语音 | 依赖钉钉自动转写（消息自带 recognition 字段），无需 ffmpeg |
| 无响应 | 查启动日志；确认后台机器人是 Stream 模式且应用已发布 |
| 下载图片/文件报权限错 | 后台「权限管理」搜索开通机器人消息相关权限后重新发布 |
| 提示登录过期 | 主机终端 `claude /login`；根治：`claude setup-token` 长期令牌写入 `.env` 的 `CLAUDE_CODE_OAUTH_TOKEN=` |
| 安全红线 | `.env` 不入库不外发；不给无人值守机器人开 Write/Bash；不用 `--dangerously-skip-permissions` |
