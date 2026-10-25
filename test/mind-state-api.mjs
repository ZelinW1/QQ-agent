// GET /api/mind/state 的接口自测（GUI 的数据源）。
//
// 守的是"界面能如实显示"：身份来源模式、她说自己是谁、关系、体力、作息、
// 以及**响应里不能有密钥**。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const env = await bootApp({
  config: {
    allow: { groups: ['456'], private: ['777'] },
    // harness 的基础配置里带 roleText（旧模式），这里显式清空以验证 charter 模式
    persona: { roleText: '' },
    mind: { enabled: true, scope: 'private', sleep: { enabled: false } }
  }
});
const { dataDir } = env;

// ── 预置一份"她活了一阵子"的状态 ───────────────────────────────────────
const mindDir = path.join(dataDir, 'mind');
fs.mkdirSync(path.join(mindDir, 'relations'), { recursive: true });
fs.mkdirSync(path.join(mindDir, 'events', 'private_777'), { recursive: true });

const now = Date.now();
fs.writeFileSync(path.join(mindDir, 'self.json'), JSON.stringify({
  version: 3,
  updatedAt: now,
  narrative: '我是小鲸鱼。最近我发现自己对熟人话多。',
  mood: { label: '有点闷', valence: -0.3 },
  preoccupations: ['想问裁员的事'],
  changelog: []
}), 'utf8');

fs.writeFileSync(path.join(mindDir, 'relations', '777.json'), JSON.stringify({
  userId: '777', names: ['小王'], stage: 'familiar', trust: 62, warmth: 70,
  nickname: '王哥', knownFor: ['做后端'], tender: ['别问裁员'],
  openLoops: [{ text: '他后来怎么样了' }], recentSummary: '聊到裁员',
  confidence: 0.8, evidence: ['e_seed'], contexts: {}, updatedAt: now
}), 'utf8');

const monthKey = `${new Date(now).getFullYear()}-${String(new Date(now).getMonth() + 1).padStart(2, '0')}`;
fs.writeFileSync(
  path.join(mindDir, 'events', 'private_777', `${monthKey}.jsonl`),
  `${JSON.stringify({ id: 'e_seed', ts: now - 3600000, chatKey: 'private:777', actorId: '777', actorName: '小王', kind: 'interaction', text: '他说组里在裁人', valence: -0.5, salience: 0.9, tags: [], refs: {}, compacted: false, summaryOf: [] })}\n`,
  'utf8'
);

fs.writeFileSync(path.join(mindDir, 'tick.json'), JSON.stringify({
  energy: 77, energyAt: now, nextTickAt: 0, today: '2026-10-25',
  todayProactive: 1, todayDecisions: 3, todayReflections: 1,
  lastInteractionAt: now, lastReflectAt: now - 7200000, lastReflectAttemptAt: now - 7200000,
  snoozes: {}, sleep: { state: 'awake', since: 0, nightKey: '', stayUps: 0 }, notes: []
}), 'utf8');

// ── 1. 基本形状 ─────────────────────────────────────────────────────────
await check('GET /api/mind/state 返回完整状态', async () => {
  const r = await env.request('GET', '/api/mind/state');
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.ok, true);
  assert.equal(d.available, true);
  assert.equal(d.enabled, true);
  assert.equal(d.scope, 'private');
  assert.ok(String(d.botName || '').length > 0, '带上她的名字（编辑身份时可直接改）');
});

await check('身份来源模式：默认 charter（roleText 为空）', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.mode, 'charter');
  assert.ok(d.charterResolved.selfImage.length > 20, 'charter 里有默认身份');
  // 槽位原文保留模板（供编辑），渲染后的那份把 {botName} 换成了实际名字（供预览）
  assert.ok(d.charter.selfImage.includes('{botName}'), '原始槽位保留占位符');
  assert.ok(!d.charterResolved.selfImage.includes('{botName}'), '渲染后不应残留占位符');
  assert.ok(d.charterResolved.selfImage.includes('覆盖Bot'), '名字来自 botName');
  assert.ok(d.charter.hardRules.length >= 3, 'charter 带硬规矩');
  assert.ok(Array.isArray(d.charter.voice) && d.charter.voice.length >= 1, 'charter 带说话习惯');
  assert.ok(d.charter.scenario.private.length > 0, 'charter 带私聊场合');
  assert.equal(d.roleTextChars, 0);
});

await check('自我：版本、叙事、心情、挂心的事', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.self.version, 3);
  assert.ok(d.self.narrative.includes('小鲸鱼'));
  assert.equal(d.self.mood.label, '有点闷');
  assert.deepEqual(d.self.preoccupations, ['想问裁员的事']);
});

await check('关系档案：昵称、阶段、信任、雷点、未完结', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.relations.length, 1);
  const rel = d.relations[0];
  assert.equal(rel.userId, '777');
  assert.equal(rel.nickname, '王哥');
  assert.equal(rel.stage, 'familiar');
  assert.equal(rel.trust, 62);
  assert.deepEqual(rel.tender, ['别问裁员']);
  assert.deepEqual(rel.openLoops, ['他后来怎么样了']);
});

await check('节律：体力与当日计数', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.tick.energy, 77);
  assert.equal(d.tick.todayProactive, 1);
  assert.equal(d.tick.todayDecisions, 3);
  assert.equal(d.tick.todayReflections, 1);
  assert.equal(d.tick.sleep.state, 'awake');
});

await check('作息：开关关闭时 asleep=false，窗口为空，但配置仍回传', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.sleep.enabled, false);
  assert.equal(d.sleep.asleep, false);
  assert.equal(d.sleep.config.startHour, 23, '回传入睡时刻（UI 才能就地改）');
  assert.ok(d.sleep.config.jitterMin >= 0, '回传抖动');
  assert.ok(typeof d.sleep.reason === 'string', '回传"为什么是这个状态"');
});

await check('反思状态：阈值 / 冷却 / 今日次数都可见', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  const r = d.reflect;
  assert.ok(r && typeof r === 'object', '有 reflect 状态');
  for (const k of ['unreflected', 'need', 'usedToday', 'dailyCap', 'canReflect']) {
    assert.ok(k in r, `reflect 缺少字段 ${k}`);
  }
  assert.ok(r.need >= 1, '阈值是正数');
});

await check('手动反思接口：指定会话时跑一次；没有会话时 400 并说明原因', async () => {
  // 没有指定会话、也没有任何聊天记录 → 明确 400（而不是 500 或静默）
  const none = await env.request('POST', '/api/mind/reflect', { body: {} });
  assert.equal(none.status, 400);
  assert.ok(String(none.data.error || '').includes('会话'), '错误要说明缺什么');

  // 指定会话 → 真跑一次（模型是 mock，会答非所问，因此 ok=false 但接口 200）
  const r = await env.request('POST', '/api/mind/reflect', { body: { chatKey: 'private:777' } });
  assert.equal(r.status, 200);
  assert.equal(typeof r.data.ok, 'boolean');
  if (!r.data.ok) assert.ok(String(r.data.reason || '').length > 0, '失败要给原因');
});

await check('计数：事件与关系', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.ok(d.counts.events >= 1, `事件数应 ≥1，实际 ${d.counts.events}`);
  assert.equal(d.counts.relations, 1);
});

// ── 4. 新增的两个数据源 ─────────────────────────────────────────────────
await check('记忆流：返回事件时间线（从新到旧）', async () => {
  const r = await env.request('GET', '/api/mind/events?limit=5');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.events), 'events 是数组');
  assert.ok(r.data.events.length >= 1, '有事件');
  const e = r.data.events[0];
  assert.ok(typeof e.text === 'string' && typeof e.ts === 'number', '事件有正文与时间');
  assert.ok(typeof e.salience === 'number', '带重要度');

  // 按人筛选（服务端过滤，不是客户端截断）
  const byActor = await env.request('GET', '/api/mind/events?actor=777&limit=5');
  assert.ok(byActor.data.events.every((x) => x.actorId === '777'), '按人筛选只返回该人的事件');
  const none = await env.request('GET', '/api/mind/events?actor=999&limit=5');
  assert.equal(none.data.events.length, 0, '没有这个人的事件时返回空');
});

await check('会话配置：读 / 写 / 清除', async () => {
  const g = await env.request('GET', '/api/chat-profiles');
  assert.equal(g.status, 200);
  assert.ok(g.data.profiles && typeof g.data.profiles === 'object', '返回 profiles 映射');

  const w = await env.request('POST', '/api/chat-profiles', {
    body: { chatKey: 'private:777', patch: { persona: { participation: 'high' } } }
  });
  assert.equal(w.status, 200);
  assert.equal(w.data.profiles['private:777'].persona.participation, 'high', '覆盖已写入');

  const c = await env.request('POST', '/api/chat-profiles', {
    body: { chatKey: 'private:777', clear: true }
  });
  assert.equal(c.data.profiles['private:777'], undefined, '清除后键消失（不是留下空对象）');
});

await check('会话配置：缺 chatKey → 400', async () => {
  const r = await env.request('POST', '/api/chat-profiles', { body: {} });
  assert.equal(r.status, 400);
});

await check('节律参数与默认值都回传（UI 才能"恢复默认"）', async () => {
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.ok(d.energy && typeof d.energy.max === 'number', '回传体力参数');
  assert.ok(d.tickConfig && typeof d.tickConfig.intervalMs === 'number', '回传心跳参数');
  assert.ok(d.reflectConfig && typeof d.reflectConfig.reflectAfterEvents === 'number', '回传反思参数');
  assert.ok(d.defaults?.energy && d.defaults?.tick && d.defaults?.sleep && d.defaults?.reflect, '回传默认值');
});

await check('心跳日志：内存最近心跳 + 落盘行动 + 文件体积', async () => {
  const d = (await env.request('GET', '/api/mind/tick-log?limit=20')).data;
  assert.equal(d.ok, true);
  assert.ok(Array.isArray(d.recentTicks), 'recentTicks 是数组');
  assert.ok(Array.isArray(d.actions), 'actions 是数组');
  assert.ok(d.sizes && typeof d.sizes.total === 'number', '有文件体积');
});

await check('清空日志：只清日志文件，不动记忆', async () => {
  const before = (await env.request('GET', '/api/mind/state')).data;
  const r = await env.request('POST', '/api/mind/logs/clear', { body: { scope: 'all' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const after = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(after.self.version, before.self.version, '自我没被清');
  assert.equal(after.relations.length, before.relations.length, '关系没被清');
  assert.ok(after.counts.events >= 1, '事件没被清');
  const log = (await env.request('GET', '/api/mind/tick-log')).data;
  assert.equal(log.actions.length, 0, '行动日志已清空');
});

await check('主人手动修改自我：留痕 by=owner，她仍可继续改写', async () => {
  const before = (await env.request('GET', '/api/mind/state')).data;
  const r = await env.request('POST', '/api/mind/self/edit', {
    body: { narrative: '我是小鲸鱼。这是主人手动改过的一句。', moodLabel: '平静' }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const after = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(after.self.version, before.self.version + 1, '版本 +1');
  assert.ok(after.self.narrative.includes('主人手动改过'), '内容已更新');
  assert.ok(!String(r.data.error || '').length, '没有错误');
});

await check('主人手动修改关系：数值钳制 + 留痕 owner:manual', async () => {
  const r = await env.request('POST', '/api/mind/relation/edit', {
    body: { userId: '777', patch: { nickname: '王哥', trust: 90, warmth: 90, stage: 'close' } }
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  // 存储层钳制：阶段一次一级、trust 单次 ±10
  const d = (await env.request('GET', '/api/mind/state')).data;
  const rel = d.relations.find((x) => x.userId === '777');
  assert.ok(rel.trust <= 90, 'trust 有值');
  assert.ok(['familiar', 'close'].includes(rel.stage), `阶段被钳制（${rel.stage}）`);
});

await check('手动编辑的入参校验', async () => {
  const badUser = await env.request('POST', '/api/mind/relation/edit', { body: { userId: 'abc', patch: { trust: 50 } } });
  assert.equal(badUser.status, 400);
  const empty = await env.request('POST', '/api/mind/relation/edit', { body: { userId: '777', patch: {} } });
  assert.equal(empty.status, 400);
  const noBody = await env.request('POST', '/api/mind/self/edit', { body: {} });
  assert.equal(noBody.status, 400);
});

// ── 5. 安全性 ───────────────────────────────────────────────────────────
await check('响应里不含任何密钥字段', async () => {
  const r = await env.request('GET', '/api/mind/state');
  for (const banned of ['apiKey', 'accessToken', 'baseUrl', 'Bearer ']) {
    assert.ok(!r.text.includes(banned), `响应不应包含 ${banned}`);
  }
});

// ── 3. 切换身份来源 ─────────────────────────────────────────────────────
await check('设置 roleText 后，模式切到 roleText（UI 要如实显示）', async () => {
  const w = await env.request('POST', '/api/config', { body: { persona: { roleText: '你是测试机。' } } });
  assert.equal(w.status, 200);
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.mode, 'roleText');
  assert.ok(d.roleTextChars > 0);
  // 恢复
  await env.request('POST', '/api/config', { body: { persona: { roleText: '' } } });
});

await check('关闭 mind 后 enabled=false，但仍能读到她的状态（只读不隐藏）', async () => {
  const before = (await env.request('GET', '/api/mind/state')).data;
  await env.request('POST', '/api/config', { body: { mind: { enabled: false } } });
  const d = (await env.request('GET', '/api/mind/state')).data;
  assert.equal(d.enabled, false);
  assert.equal(d.self.version, before.self.version, '关闭后仍能读到自我（版本不变）');
});

await env.teardown();

console.log(`\n心智状态接口：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
