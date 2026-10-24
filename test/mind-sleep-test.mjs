// 作息（睡眠）自测。
//
// 守三件事：
//   1. 窗口每夜有抖动，但同一夜内稳定（否则每次心跳的入睡时间都在变）
//   2. 睡着时：不决策、不进消息；醒来时：积压当一批处理
//   3. 她可以"再撑一会儿"，但有次数上限
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-sleep-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { resolveSleepWindow, classifySleep, describeWindow } = await import(src('src/mind/sleep.js'));
const { MindStore } = await import(src('src/mind/store.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { availableActions } = await import(src('src/mind/actions.js'));
const { updateConfig } = await import(src('src/config.js'));

const MIN = 60000;
const H = 3600000;
const at = (d, h, m = 0) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0).getTime();
const day = new Date(2026, 9, 25);

const CFG = {
  enabled: true,
  startHour: 23, startMinute: 30,
  endHour: 8, endMinute: 0,
  jitterMin: 40,
  graceMs: 15 * MIN,
  stayUpMs: 30 * MIN,
  maxStayUp: 2,
  wakeOnBacklog: true
};

// ── 1. 窗口解析 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 入睡窗口 ===');
{
  const w1 = resolveSleepWindow(at(day, 23, 45), CFG);
  const w2 = resolveSleepWindow(at(day, 23, 50), CFG);
  check(w1.nightKey === w2.nightKey, '同一晚 nightKey 一致');
  check(w1.startAt === w2.startAt && w1.endAt === w2.endAt, '同一晚反复计算结果稳定（不能每次心跳都换）');

  const wPrevNight = resolveSleepWindow(at(new Date(2026, 9, 24), 23, 45), CFG);
  const w3 = resolveSleepWindow(at(day, 2, 0), CFG);
  check(w3.nightKey === wPrevNight.nightKey, '凌晨 2 点属于前一晚（Oct 25 02:00 → Oct 24 那晚）');
  check(w3.startAt === wPrevNight.startAt, '凌晨时段复用的是同一晚的窗口');

  const nextDay = new Date(2026, 9, 26);
  const w4 = resolveSleepWindow(at(nextDay, 23, 45), CFG);
  check(w4.nightKey !== w1.nightKey, '换晚 nightKey 变');
  check(w4.startAt !== w1.startAt || w4.endAt !== w1.endAt, '换晚后的时间有抖动差异');

  check(w1.endAt > w1.startAt, '窗口跨午夜（endAt 在次日）');
  const startOffsetMin = Math.round((w1.startAt - w1.startAtBase) / MIN);
  check(Math.abs(startOffsetMin) <= 40, `入睡抖动在 ±40 分钟内（${startOffsetMin}）`);
  check(describeWindow(w1).includes('–'), `可读时间段（${describeWindow(w1)}）`);
}

// ── 2. 状态判定 ─────────────────────────────────────────────────────────
console.log('\n=== 2. 该不该睡 ===');
{
  const w = resolveSleepWindow(at(day, 23, 45), CFG);
  const base = { window: w, cfg: CFG, state: { nightKey: w.nightKey, stayUps: 0 } };

  check(classifySleep({ ...base, now: at(day, 21, 0), quietForMs: Infinity }).asleep === false, '21:00 还没到点');
  check(classifySleep({ ...base, now: w.startAt + MIN, quietForMs: Infinity }).asleep === true, '入睡点后、很安静 → 睡着');
  check(classifySleep({ ...base, now: w.startAt + MIN, quietForMs: 60000 }).asleep === false, '刚还在聊天 → 先不睡（安静宽限）');
  // 凌晨 1:30 用的是**前一晚**的窗口，所以这里要用那一晚的 window 来判断
  const wPrev = resolveSleepWindow(at(day, 1, 30), CFG);
  const inNight = classifySleep({
    window: wPrev, cfg: CFG, state: { nightKey: wPrev.nightKey, stayUps: 0 },
    now: at(day, 1, 30), quietForMs: Infinity
  });
  check(inNight.asleep === true, '凌晨 1:30 睡着');
  check(classifySleep({ ...base, now: at(day, 9, 0), quietForMs: Infinity }).asleep === false, '早上 9:00 已经醒了');

  const stayed = { ...base, state: { nightKey: w.nightKey, stayUps: 1 }, now: w.startAt + 10 * MIN, quietForMs: Infinity };
  check(classifySleep(stayed).asleep === false, '选择再撑一次 → 延后 30 分钟');

  const exhausted = { ...base, state: { nightKey: w.nightKey, stayUps: 5 }, now: w.startAt + 10 * MIN, quietForMs: Infinity };
  check(classifySleep(exhausted).asleep === false, '"再撑"次数不会让她永远不睡');

  const disabled = classifySleep({ ...base, cfg: { ...CFG, enabled: false }, now: w.startAt + MIN, quietForMs: Infinity });
  check(disabled.asleep === false, '关闭作息 → 永远醒着');

  const otherNight = classifySleep({ ...base, now: at(day, 23, 40), quietForMs: Infinity, state: { nightKey: '2000-01-01', stayUps: 9 } });
  check(otherNight.asleep === true, '换夜后旧的"再撑"计数不生效');
}

// ── 3. 菜单里的"再撑一会儿" ─────────────────────────────────────────────
console.log('\n=== 3. 再撑一会儿 ===');
{
  const inWin = availableActions({ energy: 100, inSleepWindow: 1, stayUps: 0, maxStayUp: 2, now: Date.now() });
  check(inWin.some((a) => a.id === 'stay_up'), '入睡窗口内可以选择再撑');

  const outWin = availableActions({ energy: 100, inSleepWindow: 0, stayUps: 0, maxStayUp: 2, now: Date.now() });
  check(!outWin.some((a) => a.id === 'stay_up'), '不在窗口时没有这个选项');

  const used = availableActions({ energy: 100, inSleepWindow: 1, stayUps: 2, maxStayUp: 2, now: Date.now() });
  check(!used.some((a) => a.id === 'stay_up'), '撑到上限后菜单里消失');
}

// ── 4. 编排器：睡着 / 醒来 / 看不见消息 ─────────────────────────────────
console.log('\n=== 4. 编排器行为 ===');
{
  updateConfig({
    api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
    mind: { enabled: true, tick: { enabled: true }, sleep: CFG }
  });

  const mkOrch = ({ unread = 0, lastTs = 0 } = {}) => {
    const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 's-')), getOptions: () => ({}) });
    const store = {
      listChats: () => ['private:456'],
      unreadCount: () => unread,
      getChatMeta: () => ({ lastTs }),
      recent: () => []
    };
    const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
    orch.paused = false;
    orch.aborted = false;
    return { orch, mind };
  };

  // 4a. 入睡：心跳不再决策
  {
    const { orch, mind } = mkOrch({ lastTs: at(day, 20, 0) });
    orch.lastActivityAt = at(day, 20, 0);
    let called = false;
    const r = await orch.tickOnce({ now: at(day, 23, 45), chat: async () => { called = true; return { message: { content: '{"action":"idle"}' } }; } });
    check(r.skipped === 'asleep', '入夜后心跳直接返回 asleep');
    check(!called, '睡着时不调决策模型');
    check(orch.asleep === true, '状态记为睡着');
    check((mind.getTick().sleep || {}).state === 'asleep', '睡着状态已持久化');
  }

  // 4b. 睡眠期间收到的消息：不唤醒
  {
    const { orch } = mkOrch();
    orch.asleep = true;
    let scheduled = 0;
    orch.scheduleWake = () => { scheduled++; };
    orch.onIncoming('private:456');
    check(scheduled === 0, '睡着时收到消息不唤醒（只入库）');
  }

  // 4c. 醒来：把积压当一批处理
  {
    const { orch, mind } = mkOrch({ unread: 3 });
    orch.lastActivityAt = at(day, 20, 0);
    await orch.tickOnce({ now: at(day, 23, 45), chat: async () => ({ message: { content: '{"action":"idle"}' } }) });
    const wasAsleep = orch.asleep;
    let scheduled = [];
    orch.scheduleWake = (chatKey) => { scheduled.push(chatKey); };
    const r = await orch.tickOnce({ now: at(day, 9, 0), chat: async () => ({ message: { content: '{"action":"idle"}' } }) });
    check(wasAsleep === true, '先确实睡着了');
    check(orch.asleep === false, '早上的心跳把她叫醒');
    check(scheduled.includes('private:456'), '醒来时给有未读的会话排了处理');
    check((mind.getTick().sleep || {}).state === 'awake', '醒来状态已持久化');
    check(r.skipped !== 'asleep', '醒来这一轮继续走正常流程');
  }

  // 4d. 再撑一会儿：延长入睡，且计入上限
  {
    const { orch, mind } = mkOrch({ lastTs: at(day, 23, 0) });
    // 她刚刚还在说话（5 分钟前）→ 在安静宽限内，还没睡着，于是会被问"睡 or 再待一会儿"
    orch.lastActivityAt = at(day, 23, 35);
    const r = await orch.tickOnce({
      now: at(day, 23, 40),
      chat: async () => ({ message: { content: '{"action":"stay_up","reason":"还想再待一会儿"}' } })
    });
    check(r.results.some((x) => x.action === 'stay_up'), '她选择了再撑一会儿');
    check((mind.getTick().sleep || {}).stayUps === 1, '撑的次数 +1');
  }

  // 4e. 关闭作息 → 行为回到原来
  {
    updateConfig({ mind: { sleep: { enabled: false } } });
    const { orch } = mkOrch({ lastTs: at(day, 20, 0) });
    orch.lastActivityAt = at(day, 20, 0);
    let called = false;
    const r = await orch.tickOnce({ now: at(day, 23, 45), chat: async () => { called = true; return { message: { content: '{"action":"idle"}' } }; } });
    check(orch.asleep === false, '关闭后不会睡着');
    check(r.skipped !== 'asleep', '关闭后心跳照常');
    updateConfig({ mind: { sleep: CFG } });
  }
}

console.log(`\n作息：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
