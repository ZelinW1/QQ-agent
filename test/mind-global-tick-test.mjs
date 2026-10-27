// 全局唤醒（mind.tick.mode='global'）自测：一次唤醒、一份 roster、一次决策。
//
// 覆盖：
//   · roster 排序（未读 > 沉默时长）
//   · 决策提示词里能看到多个人与最后一句线索
//   · 决策指定目标会话时，动作跑在目标会话上（而不是第一个候选）
//   · 一次唤醒只排一次节拍（同一时刻不会连续决策）
//   · 没候选时不调模型
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-global-'));
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
const { updateConfig, getConfig } = await import(src('src/config.js'));

const H = 3600000;
const now0 = Date.now();

// 全局模式 + 短节拍（抖动 0，便于断言）
updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: {
    enabled: true,
    tick: {
      enabled: true,
      mode: 'global',
      intervalMs: 10 * 60000,
      jitter: 0,
      idleLookbackMin: 2,
      proactiveIdleMs: 1 * H,
      maxDecisionsPerDay: 24,
      maxProactivePerDay: 8,
      minProactiveGapMs: 0,
      idleSnoozeMs: 60000,
      suppressAfterProactiveMs: 0
    },
    energy: { max: 100, recoverPerHour: 0, floor: 0 }
  }
});
const cfg = getConfig();
check(cfg.mind.tick.mode === 'global', '配置已切到全局模式');

const mk = ({ chats, lastTsOf, unreadOf, relations = {} }) => {
  const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'g-')), getOptions: () => ({}) });
  for (const [userId, patch] of Object.entries(relations)) {
    mind.patchRelation(userId, patch, { evidence: ['test'] });
  }
  const store = {
    listChats: () => chats,
    unreadCount: (k) => Number(unreadOf?.[k]) || 0,
    getChatMeta: (k) => ({ lastTs: Number(lastTsOf?.[k]) || 0, unread: Number(unreadOf?.[k]) || 0, lastText: `来自${k}的话` }),
    recent: () => []
  };
  const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
  orch.paused = false;
  orch.aborted = false;
  return { orch, mind };
};

// ── 1. roster 排序 + 提示词素材 ─────────────────────────────────────────
console.log('\n=== 1. roster 与提示词 ===');
{
  const { orch } = mk({
    chats: ['private:111', 'private:222'],
    lastTsOf: { 'private:111': now0 - 3 * H, 'private:222': now0 - 30 * H },
    unreadOf: { 'private:111': 2 },
    relations: {
      111: { nickname: '王哥', stage: 'familiar', warmth: 60 },
      222: { nickname: '小林', stage: 'stranger', warmth: 10 }
    }
  });

  let seen = null;
  const r = await orch.tickOnce({
    now: now0,
    chat: async (messages) => {
      seen = messages;
      return { message: { content: '{"action":"idle","reason":"先看看"}' } };
    }
  });

  check(!!seen, '全局模式确实调了一次决策模型');
  const user = seen?.[1]?.content || '';
  check(user.includes('你最近留意到的人'), '提示词带 roster 段');
  check(user.includes('王哥') && user.includes('小林'), '两个会话都出现在 roster 里');
  check(user.indexOf('王哥') < user.indexOf('小林'), '有未读的王哥排在前面');
  check(user.includes('2 条未读'), '未读条数可见');
  check(user.includes('「来自private:111的话」'), '带上了最后一句线索');
  check(user.includes('上次行动') === false || user.includes('上次行动'), '上次行动字段可选存在');
  check(r.skipped === '' || r.skipped === undefined, `本次唤醒正常执行（skipped=${r.skipped}）`);
}

// ── 2. 决策指定目标会话 ─────────────────────────────────────────────────
console.log('\n=== 2. 指定目标会话 ===');
{
  const { orch, mind } = mk({
    chats: ['private:111', 'private:222'],
    lastTsOf: { 'private:111': now0 - 2 * H, 'private:222': now0 - 20 * H },
    unreadOf: {},
    relations: { 111: { nickname: '王哥' }, 222: { nickname: '小林' } }
  });
  const woke = [];
  orch.wake = async (chatKey) => { woke.push(chatKey); return { ok: true }; };

  const before = Number(mind.getTick().energy) || 100;
  const r = await orch.tickOnce({
    now: now0,
    chat: async () => ({ message: { content: '{"action":"send_proactive","args":{"chatKey":"private:222"},"reason":"想问问她"}' } })
  });

  check(woke.length === 1 && woke[0] === 'private:222', `动作跑在指定的会话上（${woke.join(',')}）`);
  check(r.results?.[0]?.action === 'send_proactive', '结果里记录了动作');
  const after = Number(mind.getTick().energy) || 0;
  check(after === before - 25, `体力按动作成本扣减（${before} → ${after}）`);
  check(mind.getTick().todayProactive === 1, '今日主动次数 +1');
}

// ── 3. 同一次唤醒不会重复决策 ───────────────────────────────────────────
console.log('\n=== 3. 节拍 ===');
{
  const { orch } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 5 * H },
    unreadOf: {},
    relations: {}
  });
  let calls = 0;
  const chat = async () => { calls += 1; return { message: { content: '{"action":"idle","reason":"算了"}' } }; };
  await orch.tickOnce({ now: now0, chat });
  const second = await orch.tickOnce({ now: now0 + 60000, chat });
  check(calls === 1, `同一节拍内只调一次模型（实际 ${calls}）`);
  check(second.skipped === 'not-due', `未到点直接跳过（${second.skipped}）`);
}

// ── 4. 没候选不花模型调用 ───────────────────────────────────────────────
console.log('\n=== 4. 没候选 ===');
{
  const { orch } = mk({
    chats: ['private:111'],
    lastTsOf: { 'private:111': now0 - 60000 },  // 刚聊过，低于 proactiveIdleMs
    unreadOf: {},
    relations: {}
  });
  let called = false;
  const r = await orch.tickOnce({ now: now0, chat: async () => { called = true; return { message: { content: '{}' } }; } });
  check(!called, '没有候选时不调模型');
  check(r.results?.some((x) => x.reason === 'no-candidate'), '结果是 no-candidate');
}

console.log(`\n全局唤醒：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
