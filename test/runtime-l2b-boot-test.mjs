// L2b 全局反思与启动对账自测。
//
// 这两件事都属于"平时看不见、坏起来很久才发现"的机制：
//   L2b —— 跨会话反思（产出笔记，不碰自我）；
//   对账 —— 启动时把上一台机器/上一次崩溃留下的旧状态收拾干净。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2b-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { createRuntimePort } = await import(src('src/contract/mind-port.js'));
const { updateConfig } = await import(src('src/config.js'));

const H = 3600000;
const NOW = Date.now();

updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: {
    enabled: true,
    integrate: { enabled: true, maxPerDay: 2, minNotes: 3, cooldownMs: 0, l2b: { maxPerDay: 1, cooldownMs: 0, afterChatReflections: 3 } }
  }
});

const mkStore = () => new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 's-')), getOptions: () => ({}) });
const mkOrch = (store) => {
  const orch = new Orchestrator({
    store: { listChats: () => [], getChatMeta: () => ({}), recent: () => [] },
    memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind: store,
    automationDir: fs.mkdtempSync(path.join(dataDir, 'a-'))
  });
  orch.paused = false;
  orch.aborted = false;
  return orch;
};
const seedChatReflections = (store, n = 3) => {
  for (let i = 0; i < n; i++) {
    store.appendReflection({ scope: 'chat', chatKey: 'private:1', at: NOW - (n - i) * H, ok: true, produced: { selfNotes: 1 } });
  }
};

// ── 1. L2b：产出笔记，不改自我 ──────────────────────────────────────────
console.log('\n=== 1. L2b ===');
{
  const store = mkStore();
  const orch = mkOrch(store);
  seedChatReflections(store, 3);
  store.reviseSelf({ narrative: '我是小鲸鱼。' }, { reason: '出生' });
  const before = store.getSelf().version;

  const fakeChat = async () => ({
    message: { content: JSON.stringify({ notes: ['我好像在不同人面前不太一样', '其实我挺怕被讨厌'], summary: '一句话' }) },
    usage: { total_tokens: 300 }
  });
  const r = await orch.runGlobalReflection({ chat: fakeChat });
  check(r.ok === true && r.notes === 2, '产出两条跨会话观察');
  check(store.getSelf().version === before, 'L2b 不改自我（那是 L4 的事）');
  check(store.getSelf().selfNotes.some((n) => String(n.text).includes('不同人面前')), '笔记写进 selfNotes');
  const logs = store.listReflections({ limit: 10 }).filter((x) => x.kind === 'l2b');
  check(logs.length === 1 && logs[0].scope === 'global', '落一条 scope=global / kind=l2b 的反思记录');
  check(logs[0].summary === '一句话', '小结进日志');
  const tick = store.getTick();
  check(tick.todayGlobalReflects === 1 && tick.lastGlobalReflectAt > 0, '账本记下这次 L2b');

  const again = await orch.runGlobalReflection({ chat: fakeChat });
  check(again.ok === false && again.reason === 'quota', 'L2b 有自己的每日额度');
}

// ── 2. 反思不够时不跑 ───────────────────────────────────────────────────
console.log('\n=== 2. 门槛 ===');
{
  const store = mkStore();
  const orch = mkOrch(store);
  seedChatReflections(store, 1);
  const r = await orch.runGlobalReflection({ chat: async () => ({ message: { content: '{}' } }) });
  check(r.ok === false && r.reason === 'not-enough', '会话反思不够 3 条时不做 L2b');
}

// ── 3. 触发顺序：先 L2b，后 L4 ──────────────────────────────────────────
console.log('\n=== 3. 触发 ===');
{
  const store = mkStore();
  const orch = mkOrch(store);
  seedChatReflections(store, 3);
  let l2b = 0; let l4 = 0;
  orch.runGlobalReflection = async () => { l2b++; return { ok: true }; };
  orch.runIntegrate = async () => { l4++; return { ok: true }; };
  orch.maybeIntegrateGlobal();
  await new Promise((r) => setTimeout(r, 10));
  check(l2b === 1 && l4 === 0, '会话反思攒够时先做 L2b，不急着改自我');
}

// ── 4. 启动对账 ─────────────────────────────────────────────────────────
console.log('\n=== 4. 启动对账 ===');
{
  const store = mkStore();
  const orch = mkOrch(store);
  // 一条早就过期的观察（窗口过太久，判不准了）
  store.appendObservation({ chatKey: 'private:1', action: 'send_proactive', expect: '会回', at: NOW - 20 * 86400000, windowMs: 72 * H });
  // 冲动时刻严重过期（像停机了一周）
  store.updateTick({ impulseAt: NOW - 10 * 86400000 });
  // 存储版本缺失（旧数据）
  check(store.getStoreVersion() === 0, '旧数据没有存储版本');

  const out = await orch.bootReconcile({ now: NOW });
  check(out.voided === 1, `过期观测被作废（${out.voided}）`);
  const obs = store.listObservations({ limit: 5 })[0];
  check(obs.verdict === 'void', '作废后不再挂在待复查队列');
  check(out.impulseResampled === true, '过期冲动被重抽');
  check(Number(store.getTick().impulseAt) >= NOW - 1000, '重抽后不会仍停在十天前');
  check(store.getStoreVersion() === 2, '写上存储版本');
  check(store.listMoments({ limit: 3 }).some((m) => m.runtime === 'boot'), '落一条 boot moment');

  const again = await orch.bootReconcile({ now: NOW });
  check(again.skipped === true, '同一进程只对账一次');
}

// ── 5. 按停机时长对账 ───────────────────────────────────────────────────
console.log('\n=== 5. 停机对账 ===');
{
  const store = mkStore();
  const orch = mkOrch(store);
  const downtime = 2 * 86400000;
  // 上一次启动是两天前
  store.writeBootRecord({ at: NOW - downtime, downtimeMs: 0 });
  // 停机期间就到期的一条观测：补判只会是编的 → 作废
  store.appendObservation({ chatKey: 'private:1', action: 'send_proactive', expect: '会回', at: NOW - 4 * 86400000, windowMs: 24 * H });
  store.appendObservation({ chatKey: 'private:2', action: 'send_proactive', expect: '会回', at: NOW - 1 * 86400000, windowMs: 72 * H });

  // 节律：停机前学的均值 12h
  store.updateTick({
    actionStats: { send_proactive: { ok: 3, fail: 1, lastAt: NOW - downtime, meanIntervalMs: 12 * H, nextRipeAt: NOW + 12 * H } }
  });

  const out = await orch.bootReconcile({ now: NOW });
  check(out.downtimeMs >= downtime - 1000, `对账算出停机时长（${Math.round(out.downtimeMs / H)} 小时）`);
  check(out.voided === 1, `只作废"停机前就已到期"的那条（${out.voided}）`);
  const rows = store.listObservations({ limit: 10 });
  check(rows.find((o) => o.chatKey === 'private:2')?.verdict === 'pending', '停机期间才到期的那条先留着（还能判）');
  check(out.statsDecayed === 1, '停机超过 6 小时 → 节律向默认值衰减');
  const mean = Number(store.getTick().actionStats.send_proactive.meanIntervalMs);
  check(mean < 12 * H && mean > 4 * H, `12h 的均值衰减到默认与旧值之间（${Math.round(mean / H)}h）`);
  const saved = store.readBootRecord();
  check(Number(saved.downtimeMs) >= downtime - 1000, 'boot 记录里存下停机时长（下次可追溯）');
}
console.log(`\nL2b 与对账：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
