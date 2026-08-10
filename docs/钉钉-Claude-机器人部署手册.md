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
npm install dingtalk-stream dotenv cross-spawn cron-parser
```

## 步骤 2：写入 `.env` 与 `.gitignore`

`.env`（前两项待步骤 7 从钉钉后台取得后填入）：

```bash
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=

ALLOWED_TOOLS=Read,Grep,Glob,WebSearch,WebFetch,Write(./memory/**),Edit(./memory/**),Write(./skills/**),Edit(./skills/**),Write(./schedules/**),Edit(./schedules/**)   # owner 可用工具（含记忆/技能落盘）
NON_OWNER_TOOLS=WebSearch,WebFetch                # 其他成员可用工具
CLAUDE_MODEL=                                     # 留空=默认；可填 haiku/sonnet/opus
CLAUDE_TIMEOUT_MS=300000
CLAUDE_EFFORT=          # 思考深度 low/medium/high/xhigh/max，留空=默认
FFMPEG_BIN=             # 语音转写用；建议填绝对路径如 /opt/homebrew/bin/ffmpeg
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

## 步骤 2b：写入 Agent 工作区（长期记忆 + 技能沉淀）

```bash
mkdir -p workspace/memory workspace/skills
```

写入 `workspace/CLAUDE.md` 与 `workspace/memory/MEMORY.md`——内容从本仓库对应文件原样复制（[workspace/CLAUDE.md](../workspace/CLAUDE.md)、[workspace/memory/MEMORY.md](../workspace/memory/MEMORY.md)；git clone 部署则已自带）。作用：机器人获得跨会话长期记忆（对它说「记住…」自动落盘）与技能自动沉淀（说「存成技能」自动生成 SKILL.md，桥接会同步到 .claude/skills 供后续会话加载）。

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
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
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
// 空闲超时：只要 Claude 还在输出就不计时；静默超过该时长才判定卡死
const CLAUDE_IDLE_TIMEOUT_MS = Number(process.env.CLAUDE_IDLE_TIMEOUT_MS || 600_000);
// 绝对上限：无论多活跃，超过该时长也终止（兜底防失控）
// 注意：v1.3.0 起 CLAUDE_TIMEOUT_MS 的语义从「硬超时」改为「绝对上限」。
// 老配置里常见的 300000（5 分钟）会让长任务必然被杀，这里自动纠正并告警。
let CLAUDE_MAX_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 3_600_000);
if (CLAUDE_MAX_MS < CLAUDE_IDLE_TIMEOUT_MS) {
  console.error(
    `[config] CLAUDE_TIMEOUT_MS=${CLAUDE_MAX_MS}ms 小于空闲超时 ${CLAUDE_IDLE_TIMEOUT_MS}ms，` +
      `这是 v1.3.0 之前的旧语义残留，长任务会被误杀；已自动提升为 ${CLAUDE_IDLE_TIMEOUT_MS * 6}ms。` +
      `请在 .env 中改为 3600000 以消除此警告。`
  );
  CLAUDE_MAX_MS = CLAUDE_IDLE_TIMEOUT_MS * 6;
}
let CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';
// 思考深度：low/medium/high/xhigh/max，留空=CLI 默认
let CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || '';

// 模型短名 → 全名（也允许直接写全名）
export const MODEL_ALIASES = {
  fable: 'claude-fable-5',
  opus: 'claude-opus-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5-20251001',
};
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export function getRuntimeConfig() {
  return { model: CLAUDE_MODEL, effort: CLAUDE_EFFORT };
}

// 只改 .env 里的这两行，其余内容与注释原样保留
function patchEnvFile(updates) {
  const envPath = path.resolve(__dirname, '..', '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const [key, val] of Object.entries(updates)) {
      const i = lines.findIndex((l) => l.startsWith(`${key}=`));
      // 保留行尾注释
      const comment = i >= 0 ? (lines[i].match(/\s+#.*$/)?.[0] ?? '') : '';
      const line = `${key}=${val}${comment}`;
      if (i >= 0) lines[i] = line;
      else lines.push(line);
    }
    fs.writeFileSync(envPath, lines.join('\n'));
  } catch (e) {
    console.error('[config] 回写 .env 失败:', e?.message ?? e);
  }
}

/**
 * 运行时切换模型/思考档。立即生效（下一次调用即用新值），并回写 .env 让重启后保持。
 * 返回 { model, effort } 或抛错（取值非法时）。
 */
export function setRuntimeConfig({ model, effort } = {}) {
  const updates = {};
  if (model !== undefined && model !== null && model !== '') {
    const resolved = MODEL_ALIASES[String(model).toLowerCase()] ?? String(model).trim();
    if (!/^[a-zA-Z0-9._-]+$/.test(resolved)) throw new Error(`模型名不合法：${model}`);
    CLAUDE_MODEL = resolved;
    updates.CLAUDE_MODEL = resolved;
  }
  if (effort !== undefined && effort !== null && effort !== '') {
    const e = String(effort).toLowerCase().trim();
    if (!EFFORT_LEVELS.includes(e)) throw new Error(`思考档不合法：${effort}（可选 ${EFFORT_LEVELS.join('/')}）`);
    CLAUDE_EFFORT = e;
    updates.CLAUDE_EFFORT = e;
  }
  if (Object.keys(updates).length) patchEnvFile(updates);
  return getRuntimeConfig();
}
// 飞书文档/多维表格工具开关（默认开；仅 owner 生效，权限由飞书后台 scope 决定）
const FEISHU_TOOLS = process.env.FEISHU_TOOLS !== 'false';

const sessions = loadSessions(); // { [chatId]: sessionId }

// 运行中的 claude 子进程：chatId → child，供 /cancel 终止
const running = new Map();
export function isRunning(chatId) {
  return running.has(chatId);
}
export function cancelRun(chatId) {
  const child = running.get(chatId);
  if (!child) return false;
  child.__cancelled = true;
  try {
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
  } catch { /* 已退出 */ }
  running.delete(chatId);
  return true;
}

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
    `- 模型: ${CLAUDE_MODEL || '（CLI 默认）'}`,
    `- 思考深度: ${CLAUDE_EFFORT || '（CLI 默认）'}`,
    `- 允许工具: ${tools || '（无）'}`,
  ].join('\n');
}

// Claude 被禁止自写 .claude 目录，agent 沉淀的技能先落 workspace/skills，
// 每次调用前由桥接同步到 .claude/skills 供 CLI 自动加载
function syncSkills() {
  const src = path.join(WORKSPACE_DIR, 'skills');
  const dest = path.join(WORKSPACE_DIR, '.claude', 'skills');
  try {
    if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
  } catch (e) {
    console.error('[skills-sync]', e?.message ?? e);
  }
}

// 模型对自身身份的自述不可靠（无头模式无人告知它跑在哪个模型上，它会凭训练记忆瞎猜）。
// 由桥接把真实配置写进工作区，CLAUDE.md 用 @runtime.md 引入，问到时以此为准。
function writeRuntimeInfo(chatId) {
  try {
    // 定时任务用的是 sched: 前缀的伪会话，不是真实飞书会话，不写入
    const realChat = typeof chatId === 'string' && !chatId.startsWith('sched:') ? chatId : null;
    fs.writeFileSync(
      path.join(WORKSPACE_DIR, 'runtime.md'),
      [
        '# 当前运行配置（桥接自动生成，权威来源）',
        '',
        `- 模型：${CLAUDE_MODEL || '（未指定，走 claude CLI 默认）'}`,
        `- 思考深度 effort：${CLAUDE_EFFORT || '（未指定，走 CLI 默认）'}`,
        `- 当前会话 chat_id：${realChat ?? '（本次为定时任务，无会话）'}`,
        '',
        '用户问「你用什么模型/什么档位」时，**以本文件为准**，不要凭自身记忆推测。',
        '创建定时任务时，`chat_id` 直接用上面这个值。',
      ].join('\n') + '\n'
    );
  } catch (e) {
    console.error('[runtime-info]', e?.message ?? e);
  }
}

/**
 * 运行 claude 无头模式。onProgress 提供时走 stream-json 实时解析：
 * - 中间消息 = assistant 事件的 text 块；最终答案 = result 事件的 result 字段。
 * - 最终答案会先以 assistant 事件出现一次再以 result 出现，因此 assistant 文本
 *   先暂存，被下一条 assistant 文本顶替时才作为中间进度推送；result 到达时丢弃
 *   暂存，只把 result 作为最终返回——保证最终答案只发一次。
 */
export function runClaude(chatId, prompt, isOwner = false, extraTools = [], onProgress = null) {
  syncSkills();
  writeRuntimeInfo(chatId);
  // 提示词走 stdin：--allowedTools 等可变参数选项会吞掉后置的位置参数
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (sessions[chatId]) args.push('--resume', sessions[chatId]);
  const tools = [
    isOwner ? ALLOWED_TOOLS : NON_OWNER_TOOLS,
    ...extraTools,
    isOwner && FEISHU_TOOLS ? 'mcp__feishu' : '',
  ]
    .filter(Boolean)
    .join(',');
  if (tools) args.push('--allowedTools', tools);
  if (CLAUDE_MODEL) args.push('--model', CLAUDE_MODEL);
  if (CLAUDE_EFFORT) args.push('--effort', CLAUDE_EFFORT);
  // 飞书文档/多维表格工具：只用应用自己的租户凭据，且仅 owner 可用
  if (isOwner && FEISHU_TOOLS) {
    args.push('--mcp-config', JSON.stringify({
      mcpServers: {
        feishu: {
          type: 'stdio',
          command: process.execPath,
          args: [path.join(__dirname, 'mcp-feishu.js')],
          env: {
            FEISHU_APP_ID: process.env.FEISHU_APP_ID ?? '',
            FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET ?? '',
            FEISHU_DOMAIN: process.env.FEISHU_DOMAIN ?? '',
          },
        },
      },
    }));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: WORKSPACE_DIR,
      env: process.env,
    });
    running.set(chatId, child);
    let stderr = '';
    let pending = ''; // 暂存的 assistant 文本（可能是中间进度，也可能是最终答案）
    let finalText = null;
    let finalErr = null;
    let timedOut = null;
    let lastActivity = Date.now();
    const startedAt = Date.now();
    // 活动式超时：有输出就续命，静默过久或总时长超上限才终止
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      const total = Date.now() - startedAt;
      if (idle > CLAUDE_IDLE_TIMEOUT_MS) timedOut = `静默 ${Math.round(idle / 60000)} 分钟无输出`;
      else if (total > CLAUDE_MAX_MS) timedOut = `总时长超过 ${Math.round(CLAUDE_MAX_MS / 60000)} 分钟上限`;
      if (timedOut) {
        clearInterval(timer);
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 15_000);

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      lastActivity = Date.now(); // 有输出即续命
      if (!line.trim()) return;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        return; // 非 JSON 行（罕见）忽略
      }
      if (d.type === 'assistant') {
        const text = (d.message?.content ?? [])
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (!text) return;
        if (pending && onProgress) {
          Promise.resolve(onProgress(pending)).catch((e) =>
            console.error('[progress]', e?.message ?? e)
          );
        }
        pending = text;
      } else if (d.type === 'result') {
        if (d.session_id) {
          sessions[chatId] = d.session_id;
          saveSessions(sessions);
        }
        if (d.is_error) {
          finalErr = new Error(String(d.result ?? 'unknown error').slice(0, 500));
        } else {
          finalText = String(d.result ?? pending ?? '');
        }
        pending = ''; // 暂存的就是最终答案，丢弃避免重复
      }
    });

    child.stderr.on('data', (d) => { stderr += d; lastActivity = Date.now(); });
    child.on('error', (e) => {
      clearInterval(timer);
      running.delete(chatId);
      reject(new Error(`claude CLI 启动失败: ${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(timer);
      running.delete(chatId);
      if (child.__cancelled) {
        const err = new Error('CANCELLED');
        err.cancelled = true;
        return reject(err);
      }
      if (timedOut) return reject(new Error(`claude CLI 超时（${timedOut}）`));
      if (finalErr) return reject(finalErr);
      if (finalText !== null) return resolve(finalText);
      if (pending) return resolve(pending); // 异常缺失 result 时兜底
      reject(new Error(`claude CLI 失败(code ${code}): ${stderr.slice(0, 500)}`));
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

> **定时任务**：本仓库的 `src/scheduler.js` 也需一并写入（从仓库原样复制），并在 `src/index.js` 末尾接线；机器人把任务定义写进 `workspace/schedules/*.json`，桥接到点执行——**不要给机器人 Bash 权限**。
