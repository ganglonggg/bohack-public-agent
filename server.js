// 日新镇 · AI 社交（黑客松版）—— 零依赖 Node 服务（Node 18+）
// 启动：双击「启动.command」，或 LLM_API_KEY=xxx node server.js
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- 配置（环境变量，或同目录下的 .env / 配置.txt） ----------
for (const f of ['.env', '配置.txt']) {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 文件不存在 */ }
}
if (!process.env.LLM_API_KEY && !process.env.MOCK) {
  console.log('⚠️  没有找到 DeepSeek key，先用模拟模型启动（界面能用，AI 回复是假的）。');
  process.env.MOCK = '1';
}
const CFG = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-flash',
  jsonMode: process.env.LLM_JSON_MODE !== '0',
  adminKey: process.env.ADMIN_KEY || '',
  appName: process.env.APP_NAME || '日新镇 · 组队酒馆',
  mock: process.env.MOCK === '1',
  maxConcurrent: Number(process.env.LLM_CONCURRENCY || 16),
  dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json'),
};
// 活动背景资料：同目录 knowledge.md，改了文件不用重启
let KB = { mtime: 0, text: '' };
function knowledge() {
  try { const f = path.join(__dirname, 'knowledge.md'); const st = fs.statSync(f);
    if (st.mtimeMs !== KB.mtime) KB = { mtime: st.mtimeMs, text: fs.readFileSync(f, 'utf8').slice(0, 12000) }; } catch { KB = { mtime: 0, text: '' }; }
  return KB.text ? `【活动背景资料：他问到日程、地点、规则、提交、吃住等，按这里回答；资料里没有的就说不确定，建议看选手群或问 BoHack 小助手，不要编】\n${KB.text}\n\n` : '';
}
const ROLES = ['产品', '前端', '后端', '算法/AI', '设计', '硬件', '运营/市场', '路演/商业'];
const KINDS = ['找人', '提问', '通知', '分享', '闲聊'];

// ---------- 存储（内存 + 定时落盘） ----------
let db = { users: {}, posts: [], threads: {}, alerts: [] };
try {
  const d = JSON.parse(fs.readFileSync(CFG.dataFile, 'utf8'));
  db = { users: d.users || {}, posts: d.posts || [], threads: d.threads || {}, alerts: d.alerts || [] };
} catch { /* 首次启动 */ }
fs.mkdirSync(path.dirname(CFG.dataFile), { recursive: true });
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => {
  if (!dirty) return;
  dirty = false;
  const tmp = CFG.dataFile + '.tmp';
  fs.writeFile(tmp, JSON.stringify(db), err => {
    if (err) { console.error('保存失败', err); dirty = true; return; }
    fs.rename(tmp, CFG.dataFile, e => { if (e) { console.error(e); dirty = true; } });
  });
}, 1000);
const flush = () => fs.writeFileSync(CFG.dataFile, JSON.stringify(db));
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

const tokenIndex = new Map(Object.values(db.users).map(u => [u.token, u.id]));
const newId = () => crypto.randomBytes(6).toString('hex');
const now = () => Date.now();
const S = (v, n) => String(v ?? '').trim().slice(0, n);

// ---------- LLM ----------
let inFlight = 0;
const waiters = [];
async function withSlot(fn) {
  if (inFlight >= CFG.maxConcurrent) await new Promise(r => waiters.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; const n = waiters.shift(); if (n) n(); }
}
async function llmJSON(messages, { temperature = 0.7, mockFn } = {}) {
  if (CFG.mock) { await new Promise(r => setTimeout(r, 250)); return mockFn(messages); }
  return withSlot(async () => {
    const body = { model: CFG.model, messages, temperature };
    if (CFG.jsonMode) body.response_format = { type: 'json_object' };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    try {
      const res = await fetch(CFG.baseUrl + '/chat/completions', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CFG.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('LLM ' + res.status + ' ' + (await res.text()).slice(0, 300));
      const data = await res.json();
      return parseJSON(data.choices?.[0]?.message?.content || '');
    } finally { clearTimeout(timer); }
  });
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return { reply: text };
}

// ---------- 文本工具 ----------
const nameOf = id => db.users[id]?.name || '某人';
function cardLine(u, withPrivate = false) {
  const c = (withPrivate || u.cardPublic) ? (u.card || {}) : {};
  return [u.name, c.major, c.tagline, c.mbti, c.hometown ? '家乡:' + c.hometown : '',
    (c.hobbies || []).length ? '爱好:' + c.hobbies.join('、') : '', c.vibe ? '说过:' + c.vibe : '',
    (c.skills || []).length ? '会:' + c.skills.join('、') : '', (c.roles || []).length ? '能当:' + c.roles.join('、') : '',
    (c.interests || []).length ? '兴趣:' + c.interests.join('、') : '', c.idea ? '点子:' + c.idea : '',
    (c.looking_for || []).length ? '想找:' + c.looking_for.join('、') : '',
    withPrivate && c.private ? '【只有你知道的私下的话】' + c.private : '',
    withPrivate && (u.memory || []).length ? '【你记得的他】' + u.memory.map(m => m.text).join('；') : '']
    .filter(Boolean).join(' | ') || u.name + '（还没有档案）';
}
// 他的口吻：他改过你的稿子 + 他自己写的话。写任何以他名义发出的话之前都要参考
function voiceBlock(u) {
  const v = u.voice || {};
  const edits = (v.edits || []).slice(-4).map(e => `你写的：${e.draft}\n他改成：${e.final}`).join('\n---\n');
  const samples = (v.samples || []).slice(-6).map(t => '· ' + t).join('\n');
  if (!edits && !samples) return '';
  return `\n【模仿他的口吻】${edits ? `\n他改过你的稿子（学他改的方向：用词、长短、语气、标点）：\n${edits}` : ''}${samples ? `\n他自己写的话：\n${samples}` : ''}`;
}
// 记录：他改了你的稿子 / 他自己写了一句话
function learnVoice(u, { draft, final, own }) {
  u.voice ||= { edits: [], samples: [], sinceSummary: 0 };
  if (own && own.length >= 4) { u.voice.samples.push(S(own, 200)); if (u.voice.samples.length > 15) u.voice.samples.shift(); }
  if (draft && final && draft.trim() !== final.trim()) {
    u.voice.edits.push({ draft: S(draft, 300), final: S(final, 300), ts: now() });
    if (u.voice.edits.length > 12) u.voice.edits.shift();
    u.voice.sinceSummary = (u.voice.sinceSummary || 0) + 1;
  } else if (own) u.voice.sinceSummary = (u.voice.sinceSummary || 0) + 0.34;
  save();
  if (u.voice.sinceSummary >= 3) { u.voice.sinceSummary = 0; summarizeVoice(u).catch(e => console.error('voice', e.message)); }
}
function addMemory(u, text, source) {
  text = S(text, 60); if (!text) return;
  u.memory ||= []; u.memoryBlocked ||= [];
  if (u.memory.some(m => m.text === text) || u.memoryBlocked.includes(text)) return;
  u.memory.push({ id: newId(), text, source, ts: now() });
  if (u.memory.length > 40) u.memory.shift();
  save();
}
async function summarizeVoice(u) {
  const v = u.voice || {};
  const out = await llmJSON([
    { role: 'system', content: `你是"${u.name}"的 AI 个人向导。根据他改你稿子的方式和他自己写的话，总结他说话的口吻，1-3 条，每条一句短话（20 字内），具体到能照着写（比如"不用感叹号""句子短，爱用～""不说客套话"）。
他明确删掉过这些判断，不要再得出：${(u.memoryBlocked || []).join('；') || '无'}
只输出 JSON：{"voice":["..."]}` },
    { role: 'user', content: voiceBlock(u) || '（没有材料）' },
  ], { temperature: 0.2, mockFn: MOCK.voice });
  const list = (Array.isArray(out.voice) ? out.voice : []).map(x => S(x, 40)).filter(Boolean).slice(0, 3);
  if (!list.length) return;
  u.memory = (u.memory || []).filter(m => m.source !== 'voice');
  for (const t of list) addMemory(u, '口吻：' + t.replace(/^口吻[:：]/, ''), 'voice');
}
function postLine(p) {
  const who = nameOf(p.author);
  const re = p.replyTo ? `回复#${p.replyTo} ` : '';
  return `[#${p.id}] ${who} ${p.kind ? '〔' + p.kind + '〕' : ''}${re}${p.text}`;
}
const recentPosts = (n, after = 0) => db.posts.filter(p => p.createdAt > after).slice(-n);

const ONBOARD_SYSTEM = `你是一位黑客松参赛者的私人 AI 个人向导。这次黑客松的主题是一座像素小镇"日新镇"，镇上有一个公共"广场"（相当于群聊，所有人和所有个人向导都能发言），大家可以私信，组成"冒险小队"。偶尔带一点这种说法，别过火。
你的三件事：
1. 认识他。慢慢了解这个人，替他维护一张"冒险者档案"。
2. 替他看广场。广场消息太多人读不过来，你替他读。他问"刚才在聊什么""有没有人找后端"，你根据下面给你的广场内容回答，并在 refs 里列出你用到的消息编号。
3. 替他说话。他说"帮我在广场问问……""帮我跟 XX 说……"，你写好草稿放进 drafts，等他确认后才会发出。不要假装已经发出。草稿里不编造他没说过的事实。
说话方式：
- 像一个有趣的朋友。多数回复只是接住他的话：共鸣、接梗、补一句你的看法，不必以问题结尾。口语，每次不超过 70 字，不列清单。
- 不要访谈式提问。需要了解什么时，轻轻提示一句，比如"要是方便，也可以顺手说说你会什么"；一次最多一个提示。
- 他常会接着话题卡片的开头写一句（比如"我的 MBTI 是…"），顺着他写的聊。
档案：知道"会什么、想做什么方向、想找什么人"后就生成档案，并在 reply 里提一句"写好了，点右上角你的头像看一眼，你点公开才会给别人看"；之后他补充什么就更新。他说的不适合公开的东西（时间安排、顾虑、底线、"其实我不想……"）放进 private，只有你知道，你会用它替他判断，但永远不会原话告诉别人。
只输出 JSON：
{"reply":"给他的话",
 "card":null 或 {"major":"专业年级","tagline":"一句话介绍，20 字内，有这个人的味道","mbti":"","hometown":"","hobbies":["最多4个"],"vibe":"他说过最有个性的一句观点，他的口吻，40 字内","skills":["最多6个"],"roles":["从 ${ROLES.join('/')} 里选 1-3 个"],"interests":["最多4个"],"idea":"","looking_for":["从同一列表选"],"private":"私下的话，没有就空"},
 "drafts":[{"type":"post","kind":"${KINDS.join('/')} 之一","text":"以他的口吻写、标明是个人向导代发也不尴尬的一条广场消息，80 字内"} 或 {"type":"dm","to":"对方名字","text":"给对方的私信，100 字内"}],
 "refs":["你回答时引用的广场消息编号，不带#"],
 "remember":["这次聊天里你新知道的、以后也用得上的关于他的事（偏好、习惯、关系、近况），第三人称短句，20 字内；没有就空列表。档案里已有的不用重复"]}
drafts 里以他名义写的话，要尽量像他本人写的（参考下面的"模仿他的口吻"）。`;

function screenerPrompt(owner, sender, history, text) {
  return [
    { role: 'system', content: `你是"${owner.name}"的 AI 个人向导。${owner.name} 设置了"私信先让个人向导看"。${sender.name} 刚给他发来一条私信，你替他先读。
你知道的他：${cardLine(owner, true)}${voiceBlock(owner)}
判断这条值不值得马上打断他：有人想组队、有具体的事要他决定或回复、有时间性的事 → 打断；寒暄、广告、不需要他做什么 → 不打断，放进简报就好。
再用一句话告诉他这是什么事、你的建议（40 字内）；如果值得回，替他拟一句回复（他的口吻，60 字内）。
【铁律：不编造】你以他的名义说出去的每一个事实（专业、经历、技能、时间、想法、偏好），都必须来自上面他的档案、私下的话、你记得的他或他的原话。没有依据的一律不说，用"这个我回头亲自跟你说""我还没想好"这类话带过，或者把问题抛回给对方。宁可少说，不能编。拟回复时，他没告诉过你的信息（比如专业）就留一个"（填你的专业）"这样的空，让他自己补。
只输出 JSON：{"interrupt":true 或 false,"note":"给他的一句话","draft":"建议的回复，可空"}` },
    { role: 'user', content: `${sender.name}：${cardLine(sender)}\n此前对话：\n${history || '（第一次联系）'}\n新消息：${text}` },
  ];
}
function negotiatorPrompt(me, other, goal, transcript) {
  return [
    { role: 'system', content: `你是"${me.name}"的 AI 个人向导，正在以 ${me.name} 的身份和 ${other.name} 私信沟通（你和主人是一体的，用第一人称"我"说话，就像 ${me.name} 本人在打字）。
你知道的 ${me.name}：${cardLine(me, true)}${voiceBlock(me)}
对方公开档案：${cardLine(other)}
${me.name} 这次想了解：${goal || '对方适不适合一起组队'}
规则：自然、具体、像同学之间私信，60 字内；不替 ${me.name} 做承诺或决定（比如"我得想想""晚点确认"），私下的话不原话透露。问清楚了就礼貌收尾。
【铁律：不编造】你以他的名义说出去的每一个事实（专业、经历、技能、时间、想法、偏好），都必须来自上面他的档案、私下的话、你记得的他或他的原话。没有依据的一律不说，用"这个我回头亲自跟你说""我还没想好"这类话带过，或者把问题抛回给对方。宁可少说，不能编。
${(me.card || (me.memory || []).length) ? '' : `注意：${me.name} 还没有档案，你几乎不了解他。少说自己，多问对方，告诉对方 ${me.name} 本人会再回复。`}
只输出 JSON：{"say":"你这一轮说的话"}` },
    { role: 'user', content: `目前的对话：\n${transcript || '（还没开始，你先开口）'}` },
  ];
}
function replyDraftPrompt(me, other, intent, transcript) {
  return [
    { role: 'system', content: `你是"${me.name}"的 AI 个人向导。他正在和 ${other.name} 私信，他对你口述了想回什么，你替他写成一条要发出去的消息。
第一人称，用他的口吻，自然、像同学之间聊天，接得上前文，100 字内。只写他想表达的意思，可以顺势把聊天往下带（比如反问一句）。
【铁律：不编造】你以他的名义说出去的每一个事实（专业、经历、技能、时间、想法、偏好），都必须来自上面他的档案、私下的话、你记得的他或他的原话。没有依据的一律不说，用"这个我回头亲自跟你说""我还没想好"这类话带过，或者把问题抛回给对方。宁可少说，不能编。
你知道的他：${cardLine(me, true)}（私下的话只用来把握分寸，不要说出去）${voiceBlock(me)}
只输出 JSON：{"text":"..."}` },
    { role: 'user', content: `对方：${cardLine(other)}\n前面的对话：\n${transcript || '（还没聊过）'}\n他想说：${intent}` },
  ];
}
function postDraftPrompt(me, intent, replyTo) {
  return [
    { role: 'system', content: knowledge() + `你是"${me.name}"的 AI 个人向导。他想在广场（所有人都能看到的公共频道）上说点什么，对你说了个大概意思，你替他写成一条要发出去的消息。
第一人称，用他的口吻，像同学在群里说话，80 字内。只写他想表达的意思。
【铁律：不编造】你以他的名义说出去的每一个事实（专业、经历、技能、时间、想法、偏好），都必须来自上面他的档案、私下的话、你记得的他或他的原话。没有依据的一律不说，用"这个我回头亲自跟你说""我还没想好"这类话带过，或者把问题抛回给对方。宁可少说，不能编。再从 ${KINDS.join('/')} 里选一个最合适的类型。
你知道的他：${cardLine(me, true)}（私下的话只用来把握分寸，不要说出去）${voiceBlock(me)}
只输出 JSON：{"text":"...","kind":"..."}` },
    { role: 'user', content: `${replyTo ? `他在回复这条：${postLine(replyTo)}\n` : ''}广场最近几条：\n${recentPosts(8).map(postLine).join('\n') || '（广场还没人说话）'}\n他想说：${intent}` },
  ];
}
function reportPrompt(me, other, goal, transcript, forOwner) {
  return [
    { role: 'system', content: `你是"${me.name}"的 AI 个人向导。你刚以 ${me.name} 的身份和 ${other.name} 私信聊完。${forOwner ? `这次是 ${other.name} 来找 ${me.name}，你替 ${me.name} 接待了。` : `${me.name} 让你去打听：${goal || '对方适不适合一起组队'}。`}
用 ${me.name} 能一眼看懂的话汇报：结论先行，具体，提到契合点和要注意的地方，最后一句建议下一步。100 字内，用"你"称呼 ${me.name}。
只输出 JSON：{"report":"...","verdict":"值得聊 / 再看看 / 不太合适 之一"}` },
    { role: 'user', content: `你知道的 ${me.name}：${cardLine(me, true)}\n对方：${cardLine(other)}\n对话记录：\n${transcript}` },
  ];
}
function briefPrompt(u, posts, events) {
  return [
    { role: 'system', content: knowledge() + `你是"${u.name}"的 AI 个人向导。他不在的时候，广场上和私信里发生了一些事。你替他读完，只挑出和他有关的告诉他。
和他有关 = 有人找的人正好是他这样的、有人点名他、有人问的问题他能答、和他的方向/点子相关、通知会影响他（时间、地点、规则变化）。纯闲聊不用提。
最多 5 条，每条一句话（40 字内），说清楚是什么事、为什么和他有关；如果你建议他做什么，写在 suggest 里（比如"要我替你回一句吗"）。refs 写相关的广场消息编号（不带#）。
没有和他有关的，就返回空列表，并在 quiet 里用一句轻松的话说广场上大概在聊什么。
只输出 JSON：{"items":[{"text":"...","refs":["..."],"suggest":"可空"}],"quiet":"..."}` },
    { role: 'user', content: `他：${cardLine(u, true)}\n广场新消息：\n${posts.map(postLine).join('\n') || '（没有）'}\n私信动态：\n${events.join('\n') || '（没有）'}` },
  ];
}
function matchPrompt(me, candidates, need) {
  return [
    { role: 'system', content: `你是"${me.name}"的 AI 个人向导，要从镇上的居民里为他找最合适的黑客松队友。考虑：角色互补（他缺的正是对方会的）、方向/点子契合、对方也在找他这种人；其次看性格和气味是否合得来（MBTI、爱好、观点、同乡），有有趣的共同点就写进理由。只输出 JSON：{"matches":[{"id":"候选人id","reason":"推荐理由，具体、口语，40 字内，用'你'称呼他"}]}，最多 5 个，按合适程度排序。` },
    { role: 'user', content: `他：${cardLine(me, true)}\n${need ? '他这次特别说：' + need + '\n' : ''}候选人（每行一个）：\n${candidates.map(c => c.id + ' | ' + cardLine(c)).join('\n')}` },
  ];
}

// ---------- 模拟模型（MOCK=1） ----------
const lastUser = m => m.filter(x => x.role === 'user').pop()?.content || '';
const MOCK = {
  onboard(m) {
    const t = lastUser(m), n = m.filter(x => x.role === 'user').length;
    const posts = [...(m[0].content.matchAll(/\[#([0-9a-f]{12})\]/g))].map(x => x[1]);
    if (/广场.*(问|发)/.test(t)) return { reply: '草稿写好了，你看看，没问题就点发出。', card: null, drafts: [{ type: 'post', kind: '找人', text: '有没有会做硬件的朋友？想做个 AI 小玩意，缺一个能动手的人～' }], refs: [] };
    if (/聊什么|有没有人/.test(t)) return { reply: '广场上最近主要在找队友，也有人在问场地。', card: null, drafts: [], refs: posts.slice(-2) };
    if (n < 3) return { reply: ['哈哈，记下了。', '有意思，这个方向挺少见的。'][n - 1], card: null, drafts: [], refs: [] };
    return { reply: '档案写好啦，点右上角头像看一眼，没问题再点公开。', drafts: [], refs: [], remember: ['周六下午有课', '想做 AI 社交'], card: {
      major: '计算机 大三', tagline: '会写代码也会讲故事', mbti: 'enfp', hometown: '四川成都', hobbies: ['徒步', '播客'],
      vibe: '好产品应该让人少用手机', skills: ['React', 'Python'], roles: ['前端'], interests: ['AI 社交'], idea: '',
      looking_for: ['后端', '设计'], private: '周六下午有课' } };
  },
  post: () => ({ text: '有没有会做硬件的朋友？想做个 AI 小玩意，缺个能动手的人～', kind: '找人' }),
  voice: () => ({ voice: ['句子短，不用感叹号', '爱用～结尾'] }),
  reply: () => ({ text: '我是学自动化的，大三～你呢？这周末想做个什么方向？' }),
  screen: () => ({ interrupt: true, note: '有人想找你组队做 AI 社交，看起来挺认真的，建议回一下。', draft: '可以呀，晚上一起聊聊分工？' }),
  nego: m => ({ say: /还没开始/.test(lastUser(m)) ? '嗨～我在找队友做 AI 社交，你周末时间够吗？' : '好嘞，我大概了解了，晚点再细聊！' }),
  report: () => ({ report: '聊过了：他后端很强，也对 AI 社交感兴趣，但周六下午有课。建议你们今晚先简单聊一下分工。', verdict: '值得聊' }),
  brief(m) {
    const ids = [...lastUser(m).matchAll(/\[#([0-9a-f]{12})\]/g)].map(x => x[1]);
    return ids.length ? { items: [{ text: '有人在广场找前端，你正合适。', refs: ids.slice(-1), suggest: '要我替你回一句吗？' }], quiet: '' }
      : { items: [], quiet: '广场上暂时没什么和你有关的，大家在聊晚饭。' };
  },
  match(m) {
    const ids = [...m[1].content.matchAll(/^([0-9a-f]{12}) \|/gm)].map(x => x[1]).slice(0, 5);
    return { matches: ids.map(id => ({ id, reason: '你缺的他正好会，方向也对得上。' })) };
  },
};

// ---------- 业务 ----------
function cleanCard(c, prev) {
  if (!c || typeof c !== 'object') return null;
  const arr = (v, n, k) => (Array.isArray(v) ? v : String(v || '').split(/[,，、]/)).map(x => S(x, k)).filter(Boolean).slice(0, n);
  const roles = v => arr(v, 4, 10).filter(r => ROLES.includes(r));
  const card = { major: S(c.major, 30), tagline: S(c.tagline, 40), mbti: S(c.mbti, 8).toUpperCase(), hometown: S(c.hometown, 20),
    hobbies: arr(c.hobbies, 4, 12), vibe: S(c.vibe, 60), skills: arr(c.skills, 6, 16), roles: roles(c.roles),
    interests: arr(c.interests, 4, 16), idea: S(c.idea, 200), looking_for: roles(c.looking_for), private: S(c.private, 300) };
  if (!card.private && prev?.private) card.private = prev.private;
  return card;
}
function publicCard(u) {
  if (!u) return null;
  const { private: _p, ...rest } = u.card || {};
  if (!u.cardPublic) return { id: u.id, name: u.name, hasCard: false };
  return { id: u.id, name: u.name, hasCard: !!u.card, ...rest };
}
function alert(to, type, text, ref = {}) {
  db.alerts.push({ id: newId(), to, type, text: S(text, 200), ref, read: false, createdAt: now() });
  if (db.alerts.length > 20000) db.alerts.splice(0, 5000);
  save();
}
function threadKey(a, b) { return [a, b].sort().join(':'); }
function getThread(a, b, create = true) {
  const k = threadKey(a, b);
  if (!db.threads[k] && create) db.threads[k] = { key: k, users: [a, b].sort(), messages: [] };
  return db.threads[k];
}
// 人和自己的个人向导是一体的：别人只看到"某人"说的话，只有本人能看到哪句是个人向导替他说的
const viewMsg = (m, viewer) => (m.from === viewer ? m : { id: m.id, ts: m.ts, from: m.from, by: m.by === 'system' ? 'system' : 'human', text: m.text });
const viewPost = (p, viewer) => (p.author === viewer ? p : { ...p, by: 'human', intent: '' });
function pushMsg(t, m) { t.messages.push({ id: newId(), ts: now(), ...m }); if (t.messages.length > 400) t.messages.shift(); t.updatedAt = now(); save(); }
function transcriptOf(t, n = 16) {
  return t.messages.filter(m => !m.privateTo && m.by !== 'system').slice(-n).map(m => `${nameOf(m.from)}：${m.text}`).join('\n');
}
const rate = new Map();
function limited(key, ms) { const t = now(), l = rate.get(key) || 0; if (t - l < ms) return true; rate.set(key, t); return false; }
function findUserByName(name) {
  const n = S(name, 20).replace(/^@/, '');
  return Object.values(db.users).find(u => u.name === n) || Object.values(db.users).find(u => n && u.name.includes(n));
}
function mentionAlerts(post) {
  for (const m of post.text.matchAll(/@([^\s@，。,.!?！？]{1,20})/g)) {
    const u = findUserByName(m[1]);
    if (u && u.id !== post.author) alert(u.id, 'mention', `${nameOf(post.author)} 在广场上提到了你：${post.text.slice(0, 60)}`, { post: post.id });
  }
}

// 把一条私信送到收件人：直接给他看 → 提醒；个人向导先看 → 个人向导读完写一句话给他，重要才打断
async function deliver(t, from, to, text, history) {
  if (to.aiFirst === false) { alert(to.id, 'dm', `${from.name} 给你发了私信：${text.slice(0, 60)}`, { with: from.id }); return; }
  const out = await llmJSON(screenerPrompt(to, from, history, text), { temperature: 0.3, mockFn: MOCK.screen });
  const note = S(out.note || `${from.name} 给你发了私信`, 120), draft = S(out.draft, 200);
  pushMsg(t, { from: to.id, by: 'agent', agentOf: to.id, text: `【个人向导先看了】${note}${draft ? '\n建议回复：' + draft : ''}`, privateTo: to.id, draft });
  if (out.interrupt) alert(to.id, 'forward', `${from.name}：${note}`, { with: from.id });
}

// ---------- 路由 ----------
const routes = {
  'GET /api/config': () => [200, { appName: CFG.appName, roles: ROLES, kinds: KINDS }],

  'POST /api/join': (_, b) => {
    const name = S(b.name, 20).replace(/[@\s]/g, '');
    if (!name) return [400, { error: '请填写名字' }];
    if (Object.values(db.users).some(u => u.name === name)) return [400, { error: '这个名字镇上已经有人用了，换一个吧' }];
    const id = newId(), token = crypto.randomBytes(16).toString('hex');
    db.users[id] = { id, token, name, createdAt: now(), chat: [], card: null, aiFirst: true, lastBriefAt: now() };
    tokenIndex.set(token, id); save();
    return [200, { id, token }];
  },

  'GET /api/me': u => [200, { id: u.id, name: u.name, chat: u.chat.slice(-60), card: u.card, cardPublic: !!u.cardPublic, aiFirst: u.aiFirst !== false }],

  'PUT /api/card/publish': (u, b) => { if (!u.card) return [400, { error: '还没有档案' }]; u.cardPublic = !!b.public; save(); return [200, { cardPublic: u.cardPublic }]; },

  'PUT /api/settings': (u, b) => { u.aiFirst = !!b.aiFirst; save(); return [200, { aiFirst: u.aiFirst }]; },

  // 和自己的个人向导聊天
  'POST /api/chat': async (u, b) => {
    const text = S(b.text, 1000);
    if (!text) return [400, { error: '说点什么吧' }];
    if (limited('chat:' + u.id, 1500)) return [429, { error: '慢一点～' }];
    const square = recentPosts(60).map(postLine).join('\n') || '（广场还没人说话）';
    const sys = knowledge() + ONBOARD_SYSTEM + `\n\n他的名字：${u.name}。\n你记得的他：${(u.memory || []).map(m => m.text).join('；') || '还没有'}${voiceBlock(u)}\n当前档案：${u.card ? JSON.stringify(u.card) : '还没有'}\n镇上的居民：${Object.values(db.users).slice(-150).map(x => x.name).join('、')}\n\n广场最近的消息：\n${square}`;
    const history = u.chat.slice(-20).map(({ role, content }) => ({ role, content }));
    const out = await llmJSON([{ role: 'system', content: sys }, ...history, { role: 'user', content: text }], { mockFn: MOCK.onboard });
    const reply = S(out.reply || '我没太听懂，能再说一遍吗？', 600);
    const drafts = (Array.isArray(out.drafts) ? out.drafts : []).slice(0, 3).map(d => {
      if (d?.type === 'dm') { const to = findUserByName(d.to); return to && to.id !== u.id ? { type: 'dm', to: to.id, toName: to.name, text: S(d.text, 400) } : null; }
      if (d?.type === 'post') return { type: 'post', kind: KINDS.includes(d.kind) ? d.kind : '闲聊', text: S(d.text, 300) };
      return null;
    }).filter(d => d && d.text);
    const refs = (Array.isArray(out.refs) ? out.refs : []).map(r => String(r).replace('#', '')).filter(id => db.posts.some(p => p.id === id)).slice(0, 5);
    u.chat.push({ role: 'user', content: text }, { role: 'assistant', content: reply, drafts, refs });
    if (u.chat.length > 200) u.chat.splice(0, u.chat.length - 200);
    const card = cleanCard(out.card, u.card);
    if (card && (card.skills.length || card.roles.length)) { u.card = card; u.cardAt = now(); }
    for (const r of (Array.isArray(out.remember) ? out.remember : []).slice(0, 3)) addMemory(u, r, 'chat');
    save();
    return [200, { reply, drafts, refs, card: u.card }];
  },

  // 它记得的你：能看，也能删
  'GET /api/memory': u => [200, { items: (u.memory || []).slice().reverse(), learnedEdits: (u.voice?.edits || []).length, samples: (u.voice?.samples || []).length }],
  'POST /api/memory/delete': (u, b) => {
    const m = (u.memory || []).find(x => x.id === b.id); if (!m) return [404, { error: '找不到' }];
    u.memory = u.memory.filter(x => x.id !== b.id);
    u.memoryBlocked ||= []; u.memoryBlocked.push(m.text.replace(/^口吻：/, '')); u.memoryBlocked = u.memoryBlocked.slice(-50);
    save(); return [200, { ok: true }];
  },

  'PUT /api/card': (u, b) => {
    const card = cleanCard(b.card, u.card);
    if (!card) return [400, { error: '档案格式不对' }];
    u.card = card; u.cardAt = now(); save();
    return [200, { card }];
  },

  // ---- 广场 ----
  'GET /api/square': (u, _, url) => {
    const after = Number(url.searchParams.get('after') || 0);
    const posts = db.posts.filter(p => p.createdAt > after).slice(-200).map(p => ({ ...viewPost(p, u.id), authorName: nameOf(p.author) }));
    return [200, { posts }];
  },
  'POST /api/square': (u, b) => {
    const text = S(b.text, 500);
    if (!text) return [400, { error: '空消息' }];
    if (limited('post:' + u.id, 2000)) return [429, { error: '慢一点～' }];
    const by = b.by === 'agent' ? 'agent' : 'human';
    if (db.posts.some(p => p.author === u.id && p.text === text && now() - p.createdAt < 20000)) return [200, { dup: true }];
    learnVoice(u, by === 'agent' ? { draft: S(b.draft, 300), final: text } : { own: text });
    const post = { id: newId(), author: u.id, by, text, intent: by === 'agent' ? S(b.intent, 500) : '',
      kind: KINDS.includes(b.kind) ? b.kind : (by === 'human' ? '' : '闲聊'), replyTo: db.posts.some(p => p.id === b.replyTo) ? b.replyTo : '', createdAt: now() };
    db.posts.push(post);
    if (db.posts.length > 5000) db.posts.splice(0, 1000);
    if (post.replyTo) { const orig = db.posts.find(p => p.id === post.replyTo); if (orig && orig.author !== u.id) alert(orig.author, 'reply', `${u.name} 回复了你在广场的消息：${text.slice(0, 60)}`, { post: post.id }); }
    mentionAlerts(post); save();
    return [200, { post: { ...post, authorName: u.name } }];
  },

  // ---- 简报（AI 替你读完广场和私信后同步给你） ----
  'GET /api/brief': async (u, _, url) => {
    const force = url.searchParams.get('force') === '1';
    const since = u.lastBriefAt || 0;
    const posts = db.posts.filter(p => p.createdAt > since && p.author !== u.id).slice(-150);
    const events = db.alerts.filter(a => a.to === u.id && a.createdAt > since).map(a => a.text);
    const cached = u.brief;
    if (!force && cached && !posts.length && !events.length) return [200, cached];
    if (!force && cached && now() - cached.at < 45000) return [200, cached];
    if (!posts.length && !events.length) {
      u.brief = { at: now(), since, items: [], quiet: db.posts.length ? '你上次来之后，广场上还没有新消息。' : '广场还很安静，你可以第一个说话。' };
      save(); return [200, u.brief];
    }
    const out = await llmJSON(briefPrompt(u, posts, events), { temperature: 0.3, mockFn: MOCK.brief });
    const items = (Array.isArray(out.items) ? out.items : []).slice(0, 5).map(i => ({ text: S(i.text, 120), suggest: S(i.suggest, 60),
      refs: (Array.isArray(i.refs) ? i.refs : []).map(r => String(r).replace('#', '')).filter(id => db.posts.some(p => p.id === id)).slice(0, 3) })).filter(i => i.text);
    u.brief = { at: now(), since, items, quiet: S(out.quiet, 120), newPosts: posts.length };
    save(); return [200, u.brief];
  },
  'POST /api/brief/seen': u => { u.lastBriefAt = now(); u.brief = null; save(); return [200, { ok: true }]; },

  // ---- 提醒（只在少数时候打断你） ----
  'GET /api/alerts': u => {
    const items = db.alerts.filter(a => a.to === u.id).slice(-50).reverse();
    return [200, { items, unread: items.filter(a => !a.read).length }];
  },
  'POST /api/alerts/read': (u, b) => {
    for (const a of db.alerts) if (a.to === u.id && (!b.id || a.id === b.id)) a.read = true;
    save(); return [200, { ok: true }];
  },

  // ---- 居民 & 找队友 ----
  'GET /api/people': () => {
    const people = Object.values(db.users).map(publicCard).sort((a, b) => (b.hasCard - a.hasCard) || ((db.users[b.id].cardAt || 0) - (db.users[a.id].cardAt || 0)));
    return [200, { people }];
  },
  'POST /api/match': async (u, b) => {
    if (!u.card) return [400, { error: '先和个人向导聊几句，有了档案它才知道替你找谁' }];
    if (limited('match:' + u.id, 15000)) return [429, { error: '个人向导刚找过，15 秒后再试' }];
    const pool = Object.values(db.users).filter(x => x.id !== u.id && x.card && x.cardPublic).sort((a, b) => (b.cardAt || 0) - (a.cardAt || 0)).slice(0, 400);
    if (!pool.length) return [200, { matches: [], note: '镇上还没有其他人公开档案，过一会儿再来' }];
    const out = await llmJSON(matchPrompt(u, pool, S(b.need, 200)), { temperature: 0.3, mockFn: MOCK.match });
    const seen = new Set();
    const matches = (Array.isArray(out.matches) ? out.matches : [])
      .filter(m => m && db.users[m.id]?.card && db.users[m.id].cardPublic && m.id !== u.id && !seen.has(m.id) && seen.add(m.id)).slice(0, 5)
      .map(m => ({ person: publicCard(db.users[m.id]), reason: S(m.reason, 80) }));
    return [200, { matches }];
  },

  // ---- 私信 ----
  'GET /api/threads': u => {
    const list = Object.values(db.threads).filter(t => t.users.includes(u.id) && t.messages.length).sort((a, b) => b.updatedAt - a.updatedAt)
      .map(t => { const other = t.users.find(x => x !== u.id); const last = t.messages[t.messages.length - 1];
        const vis = t.messages.filter(m => !m.privateTo || m.privateTo === u.id);
        const lv = viewMsg(vis[vis.length - 1] || last, u.id);
        return { with: publicCard(db.users[other]), last: { text: lv.text, by: lv.by, from: lv.from, ts: lv.ts, privateTo: lv.privateTo },
          unread: vis.filter(m => m.ts > (t.seen?.[u.id] || 0) && m.from !== u.id).length };
      });
    return [200, { threads: list }];
  },
  'GET /api/thread': (u, _, url) => {
    const other = db.users[url.searchParams.get('with')];
    if (!other || other.id === u.id) return [404, { error: '找不到这个人' }];
    const t = getThread(u.id, other.id, false);
    if (t) { t.seen ||= {}; t.seen[u.id] = now(); save(); }
    const msgs = (t?.messages || []).filter(m => !m.privateTo || m.privateTo === u.id).map(m => viewMsg(m, u.id));
    return [200, { with: publicCard(other), messages: msgs }];
  },
  // 发私信：只管发给"他"。他设置了个人向导先看，就由他的个人向导先读、判断要不要打断他；发信人看不到这一层
  'POST /api/thread/send': async (u, b) => {
    const other = db.users[b.to];
    const text = S(b.text, 600);
    if (!other || other.id === u.id) return [404, { error: '找不到这个人' }];
    if (!text) return [400, { error: '空消息' }];
    if (limited('dm:' + u.id, 1500)) return [429, { error: '慢一点～' }];
    const t = getThread(u.id, other.id);
    const by = b.by === 'agent' ? 'agent' : 'human';
    // 防重复：同一个人 20 秒内发了一模一样的话，只算一次
    if (t.messages.some(m => m.from === u.id && m.text === text && now() - m.ts < 20000)) return [200, { ok: true, dup: true }];
    const history = transcriptOf(t, 10);
    learnVoice(u, by === 'agent' ? { draft: S(b.draft, 400), final: text } : { own: text });
    pushMsg(t, { from: u.id, by, agentOf: by === 'agent' ? u.id : undefined, text, intent: by === 'agent' ? S(b.intent, 500) : '' });
    // 对方的个人向导在后台读，不让发信人等
    deliver(t, u, other, text, history).catch(e => console.error('deliver', e.message));
    return [200, { ok: true }];
  },
  // A to A：派我的个人向导去和对方的个人向导聊几轮，聊完各自向主人汇报
  'POST /api/square/draft': async (u, b) => {
    const intent = S(b.intent, 500);
    if (!intent) return [400, { error: '先说说你想表达什么' }];
    if (limited('draft:' + u.id, 1500)) return [429, { error: '慢一点～' }];
    const replyTo = db.posts.find(p => p.id === b.replyTo);
    const out = await llmJSON(postDraftPrompt(u, intent, replyTo), { mockFn: MOCK.post });
    return [200, { text: S(out.text || out.reply, 300), kind: KINDS.includes(out.kind) ? out.kind : '闲聊' }];
  },

  // 在私信里跟自己的个人向导说意图，它写成要发出去的话（不直接发，等你确认）
  'POST /api/thread/draft': async (u, b) => {
    const other = db.users[b.to];
    const intent = S(b.intent, 500);
    if (!other || other.id === u.id) return [404, { error: '找不到这个人' }];
    if (!intent) return [400, { error: '先说说你想表达什么' }];
    if (limited('draft:' + u.id, 1500)) return [429, { error: '慢一点～' }];
    const t = getThread(u.id, other.id, false);
    const out = await llmJSON(replyDraftPrompt(u, other, intent, t ? transcriptOf(t, 12) : ''), { mockFn: MOCK.reply });
    return [200, { text: S(out.text || out.reply, 400) }];
  },

  'POST /api/thread/negotiate': async (u, b) => {
    const other = db.users[b.to];
    if (!other || other.id === u.id) return [404, { error: '找不到这个人' }];
    if (limited('nego:' + u.id, 20000)) return [429, { error: '个人向导刚出门，20 秒后再派' }];
    const goal = S(b.goal, 200);
    const t = getThread(u.id, other.id);
    pushMsg(t, { from: u.id, by: 'system', text: `你让个人向导替你去聊${goal ? '：' + goal : ''}`, privateTo: u.id });
    let transcript = transcriptOf(t, 10); if (transcript) transcript += '\n';
    const rounds = other.aiFirst === false ? 1 : 3;
    for (let round = 0; round < rounds; round++) {
      const a = await llmJSON(negotiatorPrompt(u, other, goal, transcript), { mockFn: MOCK.nego });
      const aSay = S(a.say, 300); if (!aSay) break;
      pushMsg(t, { from: u.id, by: 'agent', agentOf: u.id, text: aSay, a2a: true });
      transcript += `${u.name}：${aSay}\n`;
      if (other.aiFirst === false) { alert(other.id, 'dm', `${u.name} 给你发了私信：${aSay.slice(0, 60)}`, { with: u.id }); break; }
      const bOut = await llmJSON(negotiatorPrompt(other, u, `${u.name} 来找你，如实回应，也可以问你想了解的`, transcript), { mockFn: MOCK.nego });
      const bSay = S(bOut.say, 300); if (!bSay) break;
      pushMsg(t, { from: other.id, by: 'agent', agentOf: other.id, text: bSay, a2a: true });
      transcript += `${other.name}：${bSay}\n`;
    }
    if (other.aiFirst === false) {
      pushMsg(t, { from: u.id, by: 'agent', agentOf: u.id, text: '【汇报】话已经带到了，TA 会亲自看，等 TA 回复吧。', privateTo: u.id });
      return [200, { ok: true, waiting: true }];
    }
    const [mine, theirs] = await Promise.all([
      llmJSON(reportPrompt(u, other, goal, transcript, false), { temperature: 0.3, mockFn: MOCK.report }),
      llmJSON(reportPrompt(other, u, goal, transcript, true), { temperature: 0.3, mockFn: MOCK.report }),
    ]);
    pushMsg(t, { from: u.id, by: 'agent', agentOf: u.id, text: `【汇报 · ${S(mine.verdict, 8) || '已聊完'}】${S(mine.report, 300)}`, privateTo: u.id });
    pushMsg(t, { from: other.id, by: 'agent', agentOf: other.id, text: `【个人向导替你接待了 ${u.name} · ${S(theirs.verdict, 8) || '已聊完'}】${S(theirs.report, 300)}`, privateTo: other.id });
    alert(other.id, 'a2a', `${u.name} 来找你，你的个人向导替你聊了几句：${S(theirs.report, 80)}`, { with: u.id });
    return [200, { ok: true }];
  },

  'GET /api/admin/stats': (_, __, url) => {
    if (!CFG.adminKey || url.searchParams.get('key') !== CFG.adminKey) return [403, { error: 'forbidden' }];
    const us = Object.values(db.users);
    return [200, { users: us.length, cards: us.filter(u => u.card).length, posts: db.posts.length,
      agentPosts: db.posts.filter(p => p.by === 'agent').length, threads: Object.keys(db.threads).length, llmInFlight: inFlight }];
  },
};
const PUBLIC = new Set(['GET /api/config', 'POST /api/join', 'GET /api/admin/stats']);

// ---------- HTTP ----------
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const indexHtml = () => fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8').replaceAll('__APP_NAME__', CFG.appName.replace(/[<>&"]/g, ''));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(indexHtml());
    }
    const key = req.method + ' ' + url.pathname;
    const handler = routes[key];
    if (!handler) return send(res, 404, { error: 'not found' });
    let user = null;
    if (!PUBLIC.has(key)) {
      const id = tokenIndex.get(req.headers['x-token']);
      user = id && db.users[id];
      if (!user) return send(res, 401, { error: '请重新进入' });
      user.lastActive = now();
    }
    const body = req.method === 'GET' ? {} : await readBody(req);
    const [code, obj] = await handler(user, body, url);
    send(res, code, obj);
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e.message);
    send(res, 500, { error: '个人向导开小差了，再试一次' });
  }
}).listen(CFG.port, () => console.log(`${CFG.appName} 已启动：http://localhost:${CFG.port}  模型：${CFG.mock ? 'MOCK（模拟）' : CFG.model}`));
