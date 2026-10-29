// 叙事与月度兜底自测（B4）。
//
// 叙事记的是"这段时间我过成了什么样"（按周/里程碑），
// 月度兜底保证"即使没人吵架，她也会按月变一次"，同时是 selfNotes 不被挤掉的保险。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-narrative-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { MindStore } = await import(src('src/mind/store.js'));
const { buildNarrativePrompt, parseNarrativeOutput } = await import(src('src/mind/narrative.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { createRuntimePort } = await import(src('src/contract/mind-port.js'));
const { updateConfig } = await import(src('src/config.js'));

const mkStore = () => new MindStore({
  root: fs.mkdtempSync(path.join(dataDir, 'n-')),
  getOptions: () => ({ seedInvariants: [] })
});

updateConfig({
  api: { model: 'test-model', baseUrl: 'http://127.0.0.1:1/v1' },
  mind: { enabled: true, narrative: { enabled: true, everyMs: 7 * 24 * 3600 * 1000, minMaterials: 1 } }
});

const DAY = 24 * 3600 * 1000;

// ── 1. 存储 ─────────────────────────────────────────────────────────────
console.log('\n=== 1. 叙事存储 ===');
{
  const store = mkStore();
  const r1 = store.appendNarrative({ text: '这周我过得挺安静的。', period: { from: 1, to: 2 }, materials: { reflections: ['r1'], strong: ['conflict@3'] } });
  check(r1.ok === true && r1.narrative.id.startsWith('nr_'), '写入一段叙事');
  check(r1.narrative.source === 'integrate.global', '来源默认是全局整合');
  store.appendNarrative({ text: '第二段。' });
  check(store.listNarratives({ limit: 5 }).length === 2, '可以有多段');
  check(store.latestNarrative().text === '第二段。', 'latestNarrative 取最后一段');
  check(store.appendNarrative({ text: '  ' }).ok === false, '空叙事被拒绝');
}

// ── 2. 材料与解析 ───────────────────────────────────────────────────────
console.log('\n=== 2. 叙事材料与解析 ===');
{
  const messages = buildNarrativePrompt({
    botName: '小鲸鱼',
    self: { narrative: '我是小鲸鱼。', mood: { label: '平静' } },
    period: { from: Date.now() - 7 * DAY, to: Date.now() },
    reflections: [{ at: Date.now() - DAY, produced: { selfNotes: 2 } }],
    strong: [{ kind: 'conflict', at: Date.now() - 2 * DAY }],
    previous: '上一段：我开始敢说不了。'
  });
  check(messages.length === 2 && messages[0].role === 'system', 'system + user 两条');
  check(messages[1].content.includes('上一段：我开始敢说不了'), '带上上一段叙事（保持延续）');
  check(messages[1].content.includes('一次冲突'), '强事件用可读的话描述');
  check(messages[0].content.includes('像写给自己看的日记'), '语气是日记而不是报告');

  const ok = parseNarrativeOutput('{"narrative":"这段时间……","title":"安静的一周"}');
  check(ok.ok === true && ok.empty === false && ok.data.title === '安静的一周', '正常解析');
  check(parseNarrativeOutput('{"narrative":"  "}').empty === true, '空正文算"没什么可写"');
  check(parseNarrativeOutput('随便写了点').ok === false, '非 JSON 解析失败');
}

// ── 3. runNarrative 全链路 ──────────────────────────────────────────────
console.log('\n=== 3. runNarrative 全链路 ===');
{
  const store = mkStore();
  store.appendReflection({ scope: 'global', at: Date.now() - DAY, ok: true, produced: { selfNotes: 1 } });
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.narrating = false;

  let seen = null;
  const fakeChat = async (messages) => {
    seen = messages;
    return { message: { content: JSON.stringify({ narrative: '这周我想清楚了一件事。', title: '一周' }) }, usage: { prompt_tokens: 500 } };
  };
  const r = await orch.runNarrative({ chat: fakeChat });
  check(r.ok === true && Boolean(r.narrative), '写出了叙事');
  check(seen && seen[0].role === 'system', '确实调了模型');
  check(store.latestNarrative().text.includes('想清楚'), '落盘');
  check(store.getTick().lastNarrativeAt > 0, '记录上次叙事时间');

  const logs = store.listReflections({ limit: 5 }).filter((x) => x.kind === 'narrative');
  check(logs.length === 1 && logs[0].title === '一周', '标题进反思日志（不塞进叙事正文）');
  check(logs[0].usage?.prompt_tokens === 500, '日志记录用量');
}

// ── 4. 材料门槛与强制 ───────────────────────────────────────────────────
console.log('\n=== 4. 材料门槛 ===');
{
  const store = mkStore();
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.narrating = false;
  const fakeChat = async () => ({ message: { content: '{"narrative":"硬写也要写"}' } });

  const noMat = await orch.runNarrative({ chat: fakeChat });
  check(noMat.ok === false && noMat.reason === 'no-material', '没有材料就不写');
  const forced = await orch.runNarrative({ chat: fakeChat, force: true });
  check(forced.ok === true, 'force 可以硬写（手动重写用）');
}

// ── 5. 触发：满一周 / 有强事件 ──────────────────────────────────────────
console.log('\n=== 5. 叙事触发 ===');
{
  const store = mkStore();
  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.narrating = false;
  let calls = 0;
  orch.runNarrative = async () => { calls++; return { ok: true }; };

  store.updateTick({ lastNarrativeAt: Date.now() - 2 * DAY });
  orch.maybeNarrative();
  check(calls === 0, '不到一周、也没强事件 → 不写');

  store.updateTick({ lastNarrativeAt: Date.now() - 8 * DAY });
  orch.maybeNarrative();
  check(calls === 1, '满一周 → 写');

  const store2 = mkStore();
  const orch2 = Object.create(Orchestrator.prototype);
  orch2.mind = store2;
  orch2.mindPort = createRuntimePort(orch2.mind, {});
  orch2.narrating = false;
  let calls2 = 0;
  orch2.runNarrative = async () => { calls2++; return { ok: true }; };
  store2.appendEvent({ chatKey: 'private:1', text: '我们绝交吧' });
  orch2.maybeNarrative();
  check(calls2 === 1, '出现强事件 → 不等一周也写');
}

// ── 6. 月度兜底 ─────────────────────────────────────────────────────────
console.log('\n=== 6. 月度兜底 ===');
{
  const store = mkStore();
  store.appendSelfNotes(['一条念头', '两条念头'], { by: 'integrate.chat' });
  store.reviseSelf({ narrative: '我是小鲸鱼。' }, { reason: '出生' });
  // 关键点：判断用的是"上次真正整合的时间"，不是 self.updatedAt。
  // self.updatedAt 每写一条笔记都会变 —— 用它判断，只要她还在反思就永远到不了一个月。
  const self = store.getSelf();
  const file = path.join(store.root, 'self.json');
  fs.writeFileSync(file, JSON.stringify({ ...self, updatedAt: Date.now() }), 'utf8');
  store.updateTick({ lastIntegrateAt: Date.now() - 40 * DAY });

  const orch = Object.create(Orchestrator.prototype);
  orch.mind = store;
  orch.mindPort = createRuntimePort(orch.mind, {});
  orch.integrating = false;
  let forced = null;
  let integratingAtCall = null;
  orch.runIntegrate = async (opts) => {
    // 关键回归：调用时 integrating 必须是 false。
    // 以前 maybeMonthlySelf 自己先置 true，又被 runIntegrate 的重入检查挡回去 ——
    // 月度兜底 100% 走不通，而且只会打一行日志。
    integratingAtCall = orch.integrating;
    forced = opts;
    return { ok: true };
  };

  orch.maybeMonthlySelf();
  await new Promise((r) => setTimeout(r, 5));
  check(forced && forced.force === true, '超过一个月 → 强制整合一次（不占额度）');
  check(integratingAtCall === false, '调用时没有把自己挡在重入检查外面');
}

// ── 7. selfNotes 淘汰保护 ───────────────────────────────────────────────
console.log('\n=== 7. 笔记淘汰 ===');
{
  const store = mkStore();
  // 先塞 20 条并全部标记消化，再塞新的：应该先挤掉已消化的
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(store.appendSelfNotes([`旧念头 ${i}`]).self.selfNotes.at(-1).id);
  store.markSelfNotesDigested(ids.slice(0, 10));
  for (let i = 0; i < 5; i++) store.appendSelfNotes([`新念头 ${i}`]);

  const self = store.getSelf();
  check(self.selfNotes.length === 20, `上限仍是 20（实际 ${self.selfNotes.length}）`);
  const fresh = self.selfNotes.filter((n) => !Number(n.digestedAt));
  check(fresh.length >= 5, '未消化的新念头都还在');
  check(self.selfNotes.some((n) => String(n.text).includes('旧念头 19')), '最新的旧念头也还在');
  check(!self.selfNotes.some((n) => String(n.text) === '旧念头 0'), '最旧的已消化条目先被挤掉');
  check((self.selfNotesDropped || 0) === 0, '这次没有丢未消化条目');
}

console.log(`\n叙事与月度兜底：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
