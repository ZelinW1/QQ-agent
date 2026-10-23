// 心智注入的运行期端到端（PR2）。
//
// 与 mind-inject-test 的分工：
//   · mind-inject-test —— 渲染与采集的纯逻辑（可喂夹具）
//   · 本文件          —— 真实链路：配置文件 → app 启动 → 私聊消息进来 →
//                        orchestrator 采集 → 最终发给模型的 messages 里有没有那三段
//
// 必须走真实链路的原因：渲染对了不等于接上了。"采集了但没传下去"这类断线，
// 纯函数测试永远发现不了。
//
// ⚠️ 一次 bootApp（同进程第二次 createApp 会因模块级单例残留连不上 OneBot）。
// 运行：node test/mind-e2e-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const PRIVATE = 'private:777';
const GROUP = '456';

const env = await bootApp({
  config: {
    allow: { groups: [GROUP], private: ['777'] },
    store: { contextSliderPos: 100, historyCount: 40 },
    wakeDelayMs: 300,
    mind: { enabled: true, scope: 'private', autoEventsInPrompt: 3, minEventSalience: 0.2 }
  }
});
const { llm, onebotWs, dataDir } = env;

// ── 预置心智数据（模拟"她已经活了一段时间"）────────────────────────────
const mindDir = path.join(dataDir, 'mind');
fs.mkdirSync(path.join(mindDir, 'relations'), { recursive: true });
fs.mkdirSync(path.join(mindDir, 'events', 'private_777'), { recursive: true });

fs.writeFileSync(path.join(mindDir, 'self.json'), JSON.stringify({
  version: 1,
  updatedAt: Date.now(),
  narrative: '我是小鲸鱼。最近在学着分辨谁值得认真对待。',
  mood: { label: '有点烦', valence: -0.3, since: Date.now() },
  preoccupations: ['想问问那家伙辞职的事'],
  changelog: [{ at: Date.now(), by: 'reflection', reason: '初始' }]
}), 'utf8');

fs.writeFileSync(path.join(mindDir, 'relations', '777.json'), JSON.stringify({
  userId: '777', names: ['小王'], stage: 'familiar', trust: 62, warmth: 70,
  nickname: '王哥', knownFor: ['做后端', '爱喝美式'], tender: ['别问裁员的事'],
  openLoops: [{ text: '问他后来怎么样了', since: Date.now() }],
  recentSummary: '聊到他被裁员', lastInteractedAt: Date.now(),
  confidence: 0.8, evidence: ['e_seed'], contexts: {}, updatedAt: Date.now()
}), 'utf8');

const monthKey = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
const now = Date.now();
fs.writeFileSync(
  path.join(mindDir, 'events', 'private_777', `${monthKey(new Date(now))}.jsonl`),
  `${JSON.stringify({
    id: 'e_seed_1', ts: now - 2 * 3600000, chatKey: PRIVATE, actorId: '777', actorName: '小王',
    kind: 'interaction', text: '他说被裁员了，语气不太对', valence: -0.6, salience: 0.9,
    tags: ['工作'], refs: {}, compacted: false, summaryOf: []
  })}\n`,
  'utf8'
);

const lastReq = () => llm.state.requests.at(-1);
const userTextOf = (req) => String(req?.messages?.[1]?.content ?? '');
const settle = () => sleep(800);

// ── 1. 私聊：三段都进提示词 ─────────────────────────────────────────────
await check('私聊消息：提示词里出现【关于我自己】【与在场者的关系】【最近想起的事】', async () => {
  const before = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 5001, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '小王' },
    message: [{ type: 'text', data: { text: '在吗' } }]
  });
  await waitFor(() => llm.state.requests.length > before, 8000, '私聊触发 LLM 请求');
  const text = userTextOf(lastReq());
  assert.ok(text.includes('【关于我自己】'), '缺【关于我自己】');
  assert.ok(text.includes('我是小鲸鱼'), '缺自我叙事正文');
  assert.ok(text.includes('【与在场者的关系】'), '缺【与在场者的关系】');
  assert.ok(text.includes('王哥') && text.includes('QQ:777'), '缺关系正文');
  assert.ok(text.includes('【最近想起的事】'), '缺【最近想起的事】');
  assert.ok(text.includes('被裁员'), '缺事件正文');
});
await settle();

// ── 2. 顺序：稳定簇在前，易变段在后 ─────────────────────────────────────
await check('段序正确：自我/关系在已读之前，最近想起在未读之前', async () => {
  const text = userTextOf(lastReq());
  const iSelf = text.indexOf('【关于我自己】');
  const iRel = text.indexOf('【与在场者的关系】');
  const iRecent = text.indexOf('【最近想起的事】');
  // 从自我段之后再找【已读信息】：引导说明里也会提到段名，直接 indexOf 会命中正文。
  // 首次对话没有历史时，该段的正文是"暂无历史记录"，所以只按段头定位。
  const iRead = text.indexOf('【已读信息】', iSelf);
  const iUnread = text.indexOf('【未读信息】以下', iRecent);
  assert.ok(iSelf > 0 && iRel > iSelf, '自我应在关系之前');
  assert.ok(iRead > iSelf && iRead > iRel, '稳定簇应在已读信息之前');
  assert.ok(iRecent > iRead, '最近想起应在已读之后');
  assert.ok(iUnread > iRecent, '最近想起应在未读之前');
});
await settle();

// ── 3. 群聊：scope=private 时完全不注入 ─────────────────────────────────
await check('群聊消息：不注入心智段（M1 只做私聊）', async () => {
  const before = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: Number(GROUP), user_id: 111, self_id: 888,
    message_id: 5002, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 111, card: '张三', nickname: '张三' },
    message: [{ type: 'text', data: { text: '@覆盖Bot 在吗' } }]
  });
  await waitFor(() => llm.state.requests.length > before, 8000, '群聊触发 LLM 请求');
  const text = userTextOf(lastReq());
  assert.ok(!text.includes('【关于我自己】'), '群聊不应有自我段');
  assert.ok(!text.includes('【与在场者的关系】'), '群聊不应有关系段');
  assert.ok(!text.includes('【最近想起的事】'), '群聊不应有回忆段');
});
await settle();

// ── 4. 自我改了 → 下次运行生效（没有缓存旧值）──────────────────────────
await check('改写自我后，下一次私聊的提示词跟着变', async () => {
  const selfFile = path.join(mindDir, 'self.json');
  const self = JSON.parse(fs.readFileSync(selfFile, 'utf8'));
  self.version = 2;
  self.narrative = '我是小鲸鱼。我想明白了一件事：不必对每个人都一样热络。';
  self.updatedAt = Date.now();
  fs.writeFileSync(selfFile, JSON.stringify(self), 'utf8');

  const before = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 5003, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '小王' },
    message: [{ type: 'text', data: { text: '在想什么' } }]
  });
  await waitFor(() => llm.state.requests.length > before, 8000, '第二次私聊请求');
  const text = userTextOf(lastReq());
  assert.ok(text.includes('不必对每个人都一样热络'), '新的自我叙事应立刻生效（说明没有缓存旧值）');
  assert.ok(!text.includes('最近在学着分辨谁值得认真对待'), '旧叙事不应残留');
});
await settle();

// ── 5. 关闭开关 → 下一轮不再注入 ────────────────────────────────────────
await check('运行期关闭 mind.enabled 后，提示词不再有段（无需重启）', async () => {
  const w = await env.request('POST', '/api/config', { body: { mind: { enabled: false } } });
  assert.equal(w.status, 200, `关闭 mind 应 200，实际 ${w.status}`);

  const before = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 5004, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '小王' },
    message: [{ type: 'text', data: { text: '睡了吗' } }]
  });
  await waitFor(() => llm.state.requests.length > before, 8000, '第三次私聊请求');
  const text = userTextOf(lastReq());
  assert.ok(!text.includes('【关于我自己】'), '关闭后不应再有自我段');
  assert.ok(!text.includes('【最近想起的事】'), '关闭后不应再有回忆段');
});
await settle();

await env.teardown();

console.log(`\n心智注入（运行期）：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('\n失败明细：');
  for (const f of fail) console.log(`  ✗ ${f}`);
  process.exit(1);
}
