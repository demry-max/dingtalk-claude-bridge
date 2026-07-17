import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { runClaude, resetSession, sessionInfo, WORKSPACE_DIR } from './claude.js';
import { loadOwner, saveOwner } from './store.js';

const CLIENT_ID = process.env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = process.env.DINGTALK_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('缺少 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET，请检查 .env');
  process.exit(1);
}

// ---- 钉钉 API access token（下载文件用） ----
let tokenCache = { v: null, exp: 0 };
async function accessToken() {
  if (tokenCache.v && Date.now() < tokenCache.exp) return tokenCache.v;
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
  });
  const d = await res.json();
  if (!d.accessToken) throw new Error(`获取 accessToken 失败: ${JSON.stringify(d).slice(0, 200)}`);
  tokenCache = { v: d.accessToken, exp: Date.now() + (Number(d.expireIn || 7200) - 300) * 1000 };
  return tokenCache.v;
}

async function downloadFile(robotCode, downloadCode, dest) {
  const res = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
    method: 'POST',
    headers: {
      'x-acs-dingtalk-access-token': await accessToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ robotCode, downloadCode }),
  });
  const d = await res.json();
  if (!d.downloadUrl) throw new Error(`获取下载链接失败: ${JSON.stringify(d).slice(0, 200)}`);
  const bin = await fetch(d.downloadUrl);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await bin.arrayBuffer()));
  return dest;
}

// ---- 回复：sessionWebhook markdown，失败降级纯文本 ----
async function reply(sessionWebhook, text) {
  const chunk = text.slice(0, 18000);
  const post = (body) =>
    fetch(sessionWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  try {
    const r = await post({ msgtype: 'markdown', markdown: { title: 'Claude', text: chunk } });
    if (r.errcode && r.errcode !== 0) throw new Error(r.errmsg || `errcode ${r.errcode}`);
  } catch (e) {
    console.error('[reply] markdown failed, fallback to text:', e?.message ?? e);
    await post({ msgtype: 'text', text: { content: chunk } });
  }
}

// ---- 消息去重 + 每会话串行队列 ----
const seen = new Set();
function isDuplicate(id) {
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 1000) for (const k of seen) { seen.delete(k); if (seen.size <= 500) break; }
  return false;
}
const chatQueues = new Map();
function enqueue(chatId, task) {
  const next = (chatQueues.get(chatId) ?? Promise.resolve()).then(task).catch((e) => console.error('[queue]', e));
  chatQueues.set(chatId, next);
}

// ---- 消息 → 提示词（文本/图片/语音/文件/富文本） ----
async function buildPrompt(data) {
  const type = data.msgtype;
  const incomingDir = path.join(WORKSPACE_DIR, 'incoming', data.msgId || String(Date.now()));
  const rel = (p) => `./${path.relative(WORKSPACE_DIR, p)}`;

  switch (type) {
    case 'text':
      return { prompt: (data.text?.content ?? '').trim(), attachments: [] };

    case 'picture': {
      const p = await downloadFile(data.robotCode, data.content.downloadCode, path.join(incomingDir, 'image.png'));
      return {
        prompt: `用户发来一张图片，已保存为 ${rel(p)}。请用 Read 工具查看图片内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'audio': {
      // 钉钉语音消息自带 recognition 转写
      const stt = (data.content?.recognition ?? '').trim();
      if (stt) return { prompt: `（用户发来一条语音，转写内容如下）\n${stt}`, attachments: [] };
      return { prompt: null, attachments: [], unsupported: '这条语音没有携带转写文本，请重发或改发文字。' };
    }

    case 'file': {
      const name = data.content?.fileName || 'file.bin';
      const p = await downloadFile(data.robotCode, data.content.downloadCode, path.join(incomingDir, path.basename(name)));
      return {
        prompt: `用户发来一个文件「${name}」，已保存为 ${rel(p)}。请用 Read 工具查看文件内容，然后回应用户。`,
        attachments: [p],
      };
    }

    case 'richText': {
      const parts = [];
      const attachments = [];
      for (const node of data.content?.richText ?? []) {
        if (node.text) parts.push(node.text);
        else if (node.type === 'picture' && node.downloadCode) {
          try {
            attachments.push(
              await downloadFile(data.robotCode, node.downloadCode, path.join(incomingDir, `img-${attachments.length}.png`))
            );
          } catch (e) {
            console.error('[richText-img]', e?.message ?? e);
          }
        }
      }
      let prompt = parts.join('').trim();
      if (attachments.length) {
        prompt += `\n\n（消息附带 ${attachments.length} 张图片，已保存为：${attachments.map(rel).join('、')}。请用 Read 工具查看后一并回应。）`;
      }
      return { prompt, attachments };
    }

    default:
      return { prompt: null, attachments: [], unsupported: `暂不支持「${type}」类型消息。` };
  }
}

async function handleMessage(data) {
  const senderId = data.senderStaffId;
  const chatId = data.conversationId;
  const webhook = data.sessionWebhook;
  if (!senderId || !webhook) return;
  if (data.msgId && isDuplicate(data.msgId)) return;
  const isP2p = data.conversationType === '1'; // 群聊(2)天然只收 @机器人 的消息

  // ---- owner：首个单聊者自动认领 ----
  let owner = loadOwner();
  if (!owner && isP2p) {
    owner = senderId;
    saveOwner(owner);
    console.log(`[owner] 已锁定 owner staffId = ${owner}`);
    await reply(webhook, `✅ 已将你登记为本机器人 owner。\n直接发消息即可对话；发送 **/new** 开启新会话，**/status** 查看会话状态。`);
    return;
  }
  const isOwner = senderId === owner;

  let built;
  try {
    built = await buildPrompt(data);
  } catch (e) {
    console.error('[buildPrompt]', e);
    await reply(webhook, `⚠️ 处理该消息失败：${e?.message ?? e}`);
    return;
  }
  if (built.unsupported) {
    await reply(webhook, built.unsupported);
    return;
  }
  const text = built.prompt?.trim();
  if (!text) return;

  if (text === '/new') {
    resetSession(chatId);
    await reply(webhook, '🆕 已重置，下一条消息将开启全新 Claude 会话。');
    return;
  }
  if (text === '/status') {
    await reply(webhook, sessionInfo(chatId, isOwner));
    return;
  }

  const extraTools = built.attachments.length ? ['Read(./incoming/**)'] : [];

  enqueue(chatId, async () => {
    console.log(`[msg] ${isOwner ? 'owner' : senderId} @ ${isP2p ? 'p2p' : 'group'} [${data.msgtype}]: ${text.slice(0, 80)}`);
    try {
      const answer = await runClaude(chatId, text, isOwner, extraTools);
      await reply(webhook, answer || '（Claude 返回了空回复）');
    } catch (e) {
      console.error('[claude]', e);
      const msg = String(e.message ?? e);
      const friendly = msg.includes('401') || /re-?authenticate/i.test(msg)
        ? '⚠️ 主机上的 Claude 登录已过期。请在主机终端运行 `claude /login` 重新登录后再试。'
        : `⚠️ Claude 调用失败：${msg}`;
      await reply(webhook, friendly);
    }
  });
}

const client = new DWClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
  // 先 ack，避免钉钉重投
  client.socketCallBackResponse(res.headers.messageId, { status: 'SUCCESS' });
  try {
    await handleMessage(JSON.parse(res.data));
  } catch (e) {
    console.error('[handle]', e);
  }
});

console.log('启动钉钉 Stream 长连接…');
client.connect();
