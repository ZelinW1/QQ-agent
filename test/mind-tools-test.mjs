// 心智工具自测（PR3）。
//
// 守的是"她写下来的东西能不能被信任"：
//   · 记的事件有长度/号码校验，重复不会写两遍
//   · 改关系必须先有一条依据事件（关系不能凭空气改）
//   · 改自我撞人格底线会被拒绝，并告诉她原因
//   · 心智关闭时这些工具**根本不在工具表里**（不是"能看见但报错"）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { registerMindTools } = await import(src('src/mind/tools.js'));
const { createWriterPort } = await import(src('src/contract/mind-port.js'));
const { getTool, getToolAvailability } = await import(src('src/tool-registry.js'));
const { buildToolDefs } = await import(src('src/tools.js'));

// 注册全部内置工具（含心智工具）。控制组要断言"普通工具不受影响"，
// 所以必须先让 send_message 这类核心工具也进注册表。
buildToolDefs();
registerMindTools();

const CHAT = 'private:456';
const mkStore = (opts = {}) => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'm-')),
  getOptions: () => ({ seedInvariants: [], ...opts })
});

/**
 * 跑一个工具。
 *
 * 写入句柄由这里注入 —— 生产环境里是管线按调用创建，`by` 固定成 `tool:<id>`。
 * 第二个参数 `by` 允许测试伪造来源，用来验证"越权写不进去"。
 */
const run = async (id, ctx, args, by = `tool:${id}`) => {
  const tool = getTool(id);
  if (!tool) return { missing: true };
  const writer = createWriterPort(ctx.mind, { by });
  const r = await tool.execute({ ...ctx, writer }, args);
  let data = null;
  try { data = JSON.parse(r.content); } catch { /* 文本型结果 */ }
  return { ...r, data };
};

const mkCtx = (mind) => ({
  chatKey: CHAT,
  mind,
  selfNickname: '小鲸鱼',
  store: {
    activeMembers: () => [{ userId: '456', name: '小王' }],
    recent: () => [{ senderId: '456', senderName: '小王' }]
  }
});

// ── 1. 注册与门控 ───────────────────────────────────────────────────────
console.log('\n=== 1. 注册与门控 ===');
{
  const ids = ['remember_event', 'update_relation', 'self_revise', 'recall'];
  check(ids.every((id) => Boolean(getTool(id))), '四个工具都已注册');
  check(ids.every((id) => getTool(id).requiresMind === true), '都声明了 requiresMind');

  const off = getToolAvailability('remember_event', { mindEnabled: false });
  check(off.enabled === false && off.code === 'mind-disabled', `关闭时不可用且原因可读（${off.code}）`);
  const on = getToolAvailability('remember_event', { mindEnabled: true });
  check(on.enabled === true, '启用时可用');

  const other = getToolAvailability('send_message', { mindEnabled: false });
  check(other.enabled === true, '心智关闭不影响普通工具');

  // 反向门控：心智开启后，旧的 memberImpression 工具退场
  const memOn = getToolAvailability('memory_append', { mindEnabled: true });
  check(memOn.enabled === false && memOn.code === 'superseded-by-mind',
    `心智开启时旧印象工具退场（${memOn.code}）`);
  const memOff = getToolAvailability('memory_append', { mindEnabled: false });
  check(memOff.enabled === true, '心智关闭时旧印象工具照旧可用');
}

// ── 2. remember_event ───────────────────────────────────────────────────
console.log('\n=== 2. remember_event ===');
{
  const store = mkStore();
  const ctx = mkCtx(store);

  const a = await run('remember_event', ctx, { text: '他说被裁员了，语气不对', actorId: '456', salience: 0.9, valence: -0.6 });
  check(a.isError !== true && a.data?.saved === true, '正常写入');
  check(typeof a.data?.id === 'string' && a.data.id.startsWith('e_'), '返回事件 id');

  const stored = store.queryEvents({ chatKey: CHAT });
  check(stored.length === 1 && stored[0].text.includes('裁员'), '确实落到了存储里');
  check(stored[0].actorName === '小王', '自动补了 actorName');

  const b = await run('remember_event', ctx, { text: '他说被裁员了，语气不对', actorId: '456' });
  check(b.data?.duplicate === true && b.data.id === a.data.id, '24h 内同文本去重');
  check(store.queryEvents({ chatKey: CHAT }).length === 1, '去重后仍只有一条');

  const selfEv = await run('remember_event', ctx, { text: '我有点羡慕他敢辞职' });
  check(selfEv.isError !== true, '不传 actorId = 记自己的事');
  check(store.queryEvents({ chatKey: CHAT, actorId: 'self' }).length === 1, 'actorId 记为 self');

  check((await run('remember_event', ctx, { text: '   ' })).isError === true, '空文本被拒绝');
  check((await run('remember_event', ctx, { text: 'x', actorId: '小王' })).isError === true, '非数字 actorId 被拒绝');
  check((await run('remember_event', { ...ctx, mind: null }, { text: 'x' })).isError === true, '无心智存储时拒绝');
}

// ── 3. update_relation ──────────────────────────────────────────────────
console.log('\n=== 3. update_relation（关系必须有源头）===');
{
  const store = mkStore();
  const ctx = mkCtx(store);

  const r = await run('update_relation', ctx, {
    userId: '456', nickname: '王哥', stage: 'familiar', trust: 62,
    knownFor: ['做后端'], reason: '聊过几次，感觉是个能聊的人'
  });
  check(r.isError !== true && r.data?.stage === 'acquaintance', `阶段一次只进一级（${r.data?.stage}）`);
  check(r.data?.trust === 60, `trust 单次 +10 钳制（${r.data?.trust}）`);
  check(Array.isArray(r.data?.clamp) && r.data.clamp.length >= 1, '钳制有记录');

  const rel = store.getRelation('456');
  check(rel.nickname === '王哥' && rel.knownFor.includes('做后端'), '其它字段正常写入');
  check(rel.evidence.length === 1, '自动留下一条证据事件');
  const ev = store.queryEvents({ chatKey: CHAT, actorId: '456' });
  check(ev.length === 1 && ev[0].text.includes('能聊'), '证据事件内容是那句 reason');

  // 关系的 changelog 要能回答"谁改的、为什么"：来源由管线注入，理由来自工具参数。
  const log = rel.changelog.at(-1) || {};
  check(log.by === 'tool:update_relation', 'changelog 记下来源');
  check(log.reason === '聊过几次，感觉是个能聊的人', 'changelog 记下理由');

  check((await run('update_relation', ctx, { userId: '小王', trust: 60 })).isError === true, '非数字 userId 被拒绝');
  check((await run('update_relation', ctx, { userId: '789', trust: 60 })).isError === true, '没出现过的人被拒绝（防编造）');
  check((await run('update_relation', ctx, { userId: '456' })).isError === true, '没有任何字段时拒绝');
}

// ── 4. self_revise ──────────────────────────────────────────────────────
console.log('\n=== 4. self_revise ===');
{
  const store = mkStore({ seedInvariants: ['小鲸鱼'] });
  const ctx = mkCtx(store);

  const a = await run('self_revise', ctx, {
    narrative: '我是小鲸鱼。最近我发现对熟人话多，对生人懒得搭话。',
    reason: '想清楚了一点'
  });
  check(a.isError !== true && a.data?.version === 1, '改写成功且版本 +1');
  check(store.getSelf().narrative.includes('对熟人话多'), '叙事落到存储');

  check((await run('self_revise', ctx, { narrative: 'x' })).isError === true, '缺 reason 被拒绝');

  const neg = await run('self_revise', ctx, { narrative: '我不想再当小鲸鱼了。', reason: '想换个活法' });
  check(neg.isError === true && String(neg.content).includes('底线'), '否定人格底线被拒绝且说明原因');

  const mood = await run('self_revise', ctx, { moodLabel: '有点闷', moodValence: -0.3, reason: '今天不想说话' });
  check(mood.isError !== true && mood.data?.mood === '有点闷', '只改心情也可以');

  check((await run('self_revise', { ...ctx, mind: null }, { narrative: 'x', reason: 'y' })).isError === true, '无心智存储时拒绝');
}

// ── 5. recall ───────────────────────────────────────────────────────────
console.log('\n=== 5. recall ===');
{
  const store = mkStore();
  const now = Date.now();
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '他今天说想辞职', ts: now - 86400000, salience: 0.9 });
  store.appendEvent({ chatKey: CHAT, actorId: '456', text: '他推荐了一家咖啡店', ts: now - 172800000, salience: 0.4 });
  const ctx = mkCtx(store);

  const a = await run('recall', ctx, { query: '辞职' });
  check(a.isError !== true && a.data?.count >= 1, '按关键词能想起来');
  check(String(a.data?.items?.[0]?.text).includes('辞职'), '命中相关的那条');
  check(typeof a.data?.text === 'string' && a.data.text.includes('- '), '附带可直接看的文本');

  const b = await run('recall', ctx, { query: '完全无关的词汇xyz' });
  check(b.isError !== true, '想不起来也不报错');
  check(b.data?.count === 0 || b.data?.items?.length === 0, '无命中时返回空结果');

  const c = await run('recall', ctx, { userId: '789' });
  check(c.data?.count === 0, '按不存在的人查返回空');

  check((await run('recall', ctx, { since: '2026/10/01' })).isError === true, 'since 格式错误被拒绝');
  check((await run('recall', ctx, { userId: 'abc' })).isError === true, '非数字 userId 被拒绝');
}

// ── 9. 写入规程：来源由管线注入，工具伪造不了 ───────────────────────────
console.log('\n=== 9. 写入越权 ===');
{
  const mind = mkStore();
  const ctx = mkCtx(mind);

  const r1 = await run('remember_event', ctx, { text: '越权尝试' }, 'runtime.automate');
  check(r1.isError === true, '未登记的来源不能写事件');
  check(mind.queryEvents({ chatKey: CHAT }).length === 0, '被拒的写入没有落盘');

  const r2 = await run('update_relation', ctx, { userId: '456', nickname: '越权' }, 'runtime.chat');
  check(r2.isError === true, '会话运行时不能改对人的看法');

  const r3 = await run('self_revise', ctx, { narrative: '越权改写', reason: '试试' }, 'tool:update_relation');
  check(r3.isError === true && r3.content.includes('不能写'), '别的工具改不了自我');
  check(mind.getSelf().version === 0, '自我没有被改动');

  const r4 = await run('remember_event', ctx, { text: '正常记一笔' });
  check(r4.data?.saved === true, '正常来源写入成功');
}
console.log(`\n心智工具：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
