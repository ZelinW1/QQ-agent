// 反思层自测（PR4）。
//
// 守的是"她写下来的判断能不能被信任"：
//   · 没有证据的关系改动丢弃
//   · 证据不在本次事件里 → 丢弃（防幻觉、也防提示注入）
//   · 事件里没出现过的人 → 丢弃
//   · 一次跨两级 → 由存储层钳制
//   · 压缩少于两条 / summary 为空 → 丢弃
//   · 输出不是 JSON → 整轮放弃，一条不写
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-reflect-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { buildReflectPrompt, parseReflectOutput, applyReflection } = await import(src('src/mind/reflect.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { createRuntimePort } = await import(src('src/contract/mind-port.js'));

const mkStore = (opts = {}) => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'm-')),
  getOptions: () => ({ seedInvariants: [], ...opts })
});

const CHAT = 'private:456';
const NOW = Date.now();

const mkEvents = (store) => {
  const a = store.appendEvent({ chatKey: CHAT, actorId: '456', actorName: '小王', text: '他说他们组在裁人，有点慌', ts: NOW - 3600000, salience: 0.9 });
  const b = store.appendEvent({ chatKey: CHAT, actorId: '456', actorName: '小王', text: '他帮我看出了配置问题', ts: NOW - 7200000, salience: 0.7 });
  const c = store.appendEvent({ chatKey: CHAT, actorId: '456', actorName: '小王', text: '他说最近靠美式续命', ts: NOW - 10800000, salience: 0.5 });
  return [a.event, b.event, c.event];
};

// ── 1. 提示词 ───────────────────────────────────────────────────────────
console.log('\n=== 1. 反思提示词 ===');
{
  const store = mkStore();
  const events = mkEvents(store);
  const messages = buildReflectPrompt({
    botName: '小鲸鱼',
    self: { narrative: '我是小鲸鱼。', mood: { label: '有点闷' }, preoccupations: ['想问裁员的事'] },
    relations: [store.patchRelation('456', { nickname: '王哥', stage: 'acquaintance' }, { evidence: [events[0].id] }).relation],
    events
  });

  check(messages.length === 2 && messages[0].role === 'system', '产出 system + user 两条');
  const sys = messages[0].content;
  check(sys.includes('你是小鲸鱼'), '用她自己的身份开场（不是"记忆整理模块"）');
  check(sys.includes('evidence'), '写明必须有证据');
  check(sys.includes('不要提到这些事里没出现过的人'), '禁止编造人物');
  check(sys.includes('一次最多移动一级'), '写明阶段级差');
  check(!/扮演|角色扮演|人设/.test(sys), '不含扮演类词汇');

  const user = messages[1].content;
  for (const ev of events) check(user.includes(ev.id), `事件 id 露出（${ev.id}）`);
  check(user.includes('我是小鲸鱼'), '带她的自我描述');
  check(user.includes('心情：有点闷'), '带心情');
  check(user.includes('王哥'), '带现有关系');
  check(user.includes('想问裁员的事'), '带挂心的事');
}

// ── 2. 解析 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. 解析输出 ===');
{
  const ok = parseReflectOutput('{"self":{"narrative":"我想明白了一点"}}');
  check(ok.ok === true && ok.empty === false, '正常 JSON 解析成功');

  const fenced = parseReflectOutput('```json\n{"compact":[{"from":["a","b"],"summary":"x"}]}\n```');
  check(fenced.ok === true && fenced.empty === false, '代码块包裹也能解析');

  const emptyObj = parseReflectOutput('{}');
  check(emptyObj.ok === true && emptyObj.empty === true, '空对象 = 想不出什么（成功但无改动）');

  const nulls = parseReflectOutput('{"self":{"narrative":null},"relations":[]}');
  check(nulls.ok === true && nulls.empty === true, '全空字段也算无改动');

  check(parseReflectOutput('我想了想，觉得没什么').ok === false, '纯文本 → 解析失败');
  check(parseReflectOutput('').ok === false, '空输出 → 解析失败');
  check(parseReflectOutput('{"self":').ok === false, '半截 JSON → 解析失败');
}

// ── 3. 应用护栏 ─────────────────────────────────────────────────────────
console.log('\n=== 3. 应用护栏 ===');
{
  const store = mkStore();
  const events = mkEvents(store);

  const r1 = applyReflection({
    store, chatKey: CHAT, inputEvents: events, now: NOW,
    output: {
      relations: [
        { userId: '456', patch: { trust: 70 }, evidence: [], confidence: 0.8 },            // 无证据
        { userId: '456', patch: { trust: 70 }, evidence: ['e_fake'], confidence: 0.8 },     // 证据是编的
        { userId: '789', patch: { trust: 70 }, evidence: [events[0].id] },                  // 人不在事件里
        { userId: '456', patch: {}, evidence: [events[0].id] }                             // 空 patch
      ]
    }
  });
  check(r1.applied.relations.length === 0, '四条全被拒绝');
  check(r1.rejected.length === 4, `拒绝原因逐条记录（${r1.rejected.length}）`);
  check(r1.rejected.some((x) => x.reason.includes('没有有效证据')), '无证据的原因可读');
  check(r1.rejected.some((x) => x.reason.includes('没有这个人')), '编造人物的原因可读');

  const r2 = applyReflection({
    store, chatKey: CHAT, inputEvents: events, now: NOW,
    output: {
      relations: [
        { userId: '456', patch: { stage: 'close', trust: 75, nickname: '王哥' }, evidence: [events[0].id], confidence: 0.8 }
      ]
    }
  });
  check(r2.applied.relations.length === 1, '有证据的关系被应用');
  check(r2.applied.relations[0].stage === 'acquaintance', `跨级被钳制为一级（${r2.applied.relations[0].stage}）`);
  const rel = store.getRelation('456');
  check(rel.trust === 60, `trust 单次 +10 钳制（${rel.trust}）`);
  check(rel.evidence.includes(events[0].id), '证据写入关系');

  const r3 = applyReflection({
    store, chatKey: CHAT, inputEvents: events, now: NOW,
    output: {
      compact: [
        { from: [events[1].id], summary: '只有一条' },                    // 少于两条
        { from: [events[1].id, events[2].id], summary: '' },              // 空摘要
        { from: ['e_fake', events[1].id], summary: '含编造 id' }          // 有效 id 不足两条
      ]
    }
  });
  check(r3.applied.compacted === 0 && r3.rejected.length === 3, '三条压缩全被拒绝');
}

// ── 4. 应用成功路径 ─────────────────────────────────────────────────────
console.log('\n=== 4. 应用成功：自我 / 关系 / 压缩 ===');
{
  const store = mkStore();
  const events = mkEvents(store);

  const r = applyReflection({
    store, chatKey: CHAT, inputEvents: events, now: NOW,
    output: {
      self: { narrative: '我是小鲸鱼。我发现自己对王哥比对别人上心一点。', mood: { label: '有点闷', valence: -0.3 } },
      relations: [{ userId: '456', patch: { stage: 'acquaintance', nickname: '王哥' }, evidence: [events[0].id], confidence: 0.7 }],
      compact: [{ from: [events[1].id, events[2].id], summary: '他帮我看过配置，也聊过靠美式续命' }],
      notes: '好像有点在意他过得怎么样'
    }
  });

  // 会话级反思不再改写自我：它只留"自我笔记"，等全局整合消化。
  check(r.applied.self === false && r.applied.selfNotes >= 1, '只留笔记，不改自我');
  check(r.applied.relations.length === 1, '关系被更新');
  check(r.applied.compacted === 2, '两条被压缩');
  check(Boolean(r.applied.summaryId), '生成了摘要事件');

  const self = store.getSelf();
  check(self.version === 0, '自我版本不变');
  check(!self.narrative.includes('上心一点'), '叙事没被会话反思改写');
  check(self.selfNotes.some((n) => String(n.text).includes('上心一点')), '叙事内容进了自我笔记');
  check(self.selfNotes.some((n) => String(n.text).includes('心情像：有点闷')), '心情也变成一条笔记');
  check(self.changelog.length === 0, '没留下 changelog（自我没被改写）');

  const live = store.queryEvents({ chatKey: CHAT });
  check(live.length === 2, `原始两条已压缩、剩 1 条未压缩 + 摘要（${live.length}）`);
  check(live.some((e) => (e.summaryOf || []).length === 2), '摘要带溯源');
}

// ── 5. 底层不变量的护栏 ─────────────────────────────────────────────────
console.log('\n=== 5. 人格底线不会被反思绕过 ===');
{
  const store = mkStore({ seedInvariants: ['小鲸鱼'] });
  const events = mkEvents(store);
  store.reviseSelf({ narrative: '我是小鲸鱼。' }, { reason: '初始' });

  const r = applyReflection({
    store, chatKey: CHAT, inputEvents: events, now: NOW,
    output: { self: { narrative: '我不想再当小鲸鱼了。' } }
  });
  check(r.applied.self === false, '反思改不了自我');
  check(r.applied.selfNotes >= 1, '只留下一条笔记');
  check(store.getSelf().narrative === '我是小鲸鱼。', '叙事未被改动');
  // 底线本身仍由 reviseSelf 把守（见存储层测试）；会话反思现在连尝试的机会都没有。
}

// ── 6. 整条 reflectForChat（注入模型调用）──────────────────────────────
console.log('\n=== 6. reflectForChat 全链路 ===');
{
  const store = mkStore();
  const events = mkEvents(store);
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});

  let seen = null;
  const fakeChat = async (messages) => {
    seen = messages;
    return {
      message: {
        content: JSON.stringify({
          self: { narrative: '我是小鲸鱼。最近我有点在意王哥的状态。' },
          relations: [{ userId: '456', patch: { stage: 'acquaintance', warmth: 60 }, evidence: [events[0].id], confidence: 0.7 }],
          compact: [{ from: [events[1].id, events[2].id], summary: '他帮过我的忙，也聊过一些琐事' }],
          notes: '以后多留意他'
        })
      },
      usage: { prompt_tokens: 1200, completion_tokens: 200 }
    };
  };

  const r = await orch.reflectForChat(CHAT, { chat: fakeChat });
  check(r.ok === true && r.empty === false, '反思成功');
  check(seen && seen[0].role === 'system', '确实调用了模型（拿到了 messages）');
  check(store.getSelf().version === 0, '自我不被会话级反思改写');
  check(store.getSelf().selfNotes.length >= 1, '留下了自我笔记');
  check(store.getRelation('456').stage === 'acquaintance', '关系更新');

  const tick = store.getTick();
  const newest = Math.max(...events.map((e) => Number(e.ts)));
  check(tick.lastReflectAt === newest, `lastReflectAt = 最新事件时间（不是 now）`);
  check((tick.todayReflections || 0) === 1, '当日反思计数 +1');
  check(tick.lastReflectAttemptAt > 0, '记录尝试时间');

  const logs = store.listReflections({ limit: 5 });
  check(logs.length === 1 && logs[0].ok === true, '写入一条成功的反思日志');
  check(logs[0].produced?.compacted === 2, '日志记录产出');
  check(logs[0].usage?.prompt_tokens === 1200, '日志记录用量（可统计成本）');
}

// ── 6b. 积压超过单批上限：先反思最早的，不许静默丢 ──────────────────────
console.log('\n=== 6b. 大批积压 ===');
{
  const store = mkStore();
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});

  // 65 条：超过默认单批 60 条
  const base = Date.now() - 65 * 60000;
  for (let i = 0; i < 65; i++) {
    store.appendEvent({ chatKey: CHAT, actorId: '456', text: `第 ${i} 条`, ts: base + i * 60000 });
  }
  const config = await import(src('src/config.js'));
  config.updateConfig({ mind: { reflectMaxEvents: 60, reflectMaxEvents2: undefined, reflectAfterEvents: 8 } });

  let seen = null;
  const fakeChat = async (messages) => {
    seen = messages;
    return { message: { content: '{"relations":[]}' } };
  };
  await orch.reflectForChat(CHAT, { chat: fakeChat });
  const prompt = String(seen?.[1]?.content || '');
  check(prompt.includes('第 0 条'), '第一批包含最早的事件');
  check(!prompt.includes('第 64 条'), '第一批不包含最新的事件（说明取的是最早一批）');
  const tick = store.getTick();
  check(tick.lastReflectAt === base + 59 * 60000, 'lastReflectAt 停在第一批的末尾');

  await orch.reflectForChat(CHAT, { chat: fakeChat });
  const prompt2 = String(seen?.[1]?.content || '');
  check(prompt2.includes('第 60 条'), '第二批接着处理剩下的');
  check(prompt2.includes('第 64 条'), '第二批包含最新的事件');
  check(store.queryEvents({ chatKey: CHAT }).every((e) => Number(e.ts) <= store.getTick().lastReflectAt), '没有事件被跳过');
}
// ── 7. 解析失败：一条都不写，但记下尝试时间 ─────────────────────────────
console.log('\n=== 7. 解析失败的处理 ===');
{
  const store = mkStore();
  const events = mkEvents(store);
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});

  const before = store.getTick().lastReflectAt;
  const r = await orch.reflectForChat(CHAT, { chat: async () => ({ message: { content: '我想了想，没什么可说的' } }) });
  check(r.ok === false, '返回失败');
  const tick = store.getTick();
  check(tick.lastReflectAt === before, '失败不前移 lastReflectAt（事件不丢）');
  check(tick.lastReflectAttemptAt > 0, '前移尝试时间（冷却挡住重试）');
  check(store.getSelf().version === 0, '一条都没写');
  const logs = store.listReflections({ limit: 5 });
  check(logs.length === 1 && logs[0].ok === false, '记录了失败原因');

  const empty = await orch.reflectForChat(CHAT, { chat: async () => ({ message: { content: '{"self":{"narrative":null}}' } }) });
  check(empty.ok === true && empty.empty === true, '"想不出什么"算成功（避免反复重试）');
}

// ── 8. 接线检查（防止"写好了但没接上"）────────────────────────────────
console.log('\n=== 8. 接线检查 ===');
{
  const srcText = fs.readFileSync(path.join(ROOT, 'src/orchestrator.js'), 'utf8');
  check(/this\.#maybeReflect\(chatKey\);/.test(srcText), '运行结束后确实调用了 #maybeReflect');
  check(/#maybeReflect\(chatKey\) \{/.test(srcText), '#maybeReflect 已定义');
  check(/this\.reflectForChat\(chatKey\)/.test(srcText), '#maybeReflect 会触发 reflectForChat');
  // 失败时推进尝试时间这件事已经移进领域服务（R14：运行时不留 store 直连）
  const svcText = fs.readFileSync(path.join(ROOT, 'src/mind/service.js'), 'utf8');
  check(svcText.includes('lastReflectAttemptAt'), '失败时记录尝试时间（领域服务）');
}

console.log(`\n心智反思：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
