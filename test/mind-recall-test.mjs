// 记忆检索自测（PR1）。
//
// 检索决定"她此刻想起什么"，进而决定提示词里出现哪些往事。
// 这里必须全部是纯函数断言：同一输入必须得到同一输出，
// 否则同一句话在两轮里注入不同记忆，行为会显得精神分裂。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { tokenize, scoreEvent, selectRecall, formatRecallForPrompt } = await import(src('src/mind/recall.js'));

const NOW = Date.now();
const DAY = 86400000;
const ev = (over = {}) => ({
  id: 'e_1', ts: NOW, chatKey: 'private:456', actorId: '456', actorName: '小王',
  kind: 'interaction', text: '随便一句', valence: 0, salience: 0.5,
  compacted: false, ...over
});

// ── 1. 分词 ─────────────────────────────────────────────────────────────
console.log('\n=== 1. 分词（中文二元 + 拉丁词）===');
{
  const t = tokenize('今天天气不错');
  check(t.has('天气') && t.has('不错'), '中文切成二元词');
  check(t.has('今天') && t.has('天天'), '相邻二元覆盖完整');

  const e = tokenize('Hello WORLD 你好');
  check(e.has('hello') && e.has('world'), '拉丁词转小写且保留');
  check(e.has('你好'), '中英混排都能切');

  check(tokenize('').size === 0 && tokenize(null).size === 0, '空输入返回空集合');
  check(tokenize('啊').has('啊'), '单字成词');
}

// ── 2. 打分：时近性 / 显著度 / 相关性 ───────────────────────────────────
console.log('\n=== 2. 打分：各分量方向正确 ===');
{
  const fresh = scoreEvent(ev({ ts: NOW }), { now: NOW });
  const old = scoreEvent(ev({ ts: NOW - 90 * DAY }), { now: NOW });
  check(fresh > old, `新的事比旧的事分高（${fresh.toFixed(3)} > ${old.toFixed(3)}）`);

  const hot = scoreEvent(ev({ salience: 0.9 }), { now: NOW });
  const cold = scoreEvent(ev({ salience: 0.1 }), { now: NOW });
  check(hot > cold, '显著度高的事分更高');

  const related = scoreEvent(ev({ text: '他今天说被裁员了' }), {
    now: NOW, queryTokens: tokenize('裁员')
  });
  const unrelated = scoreEvent(ev({ text: '他今天吃了碗面' }), {
    now: NOW, queryTokens: tokenize('裁员')
  });
  check(related > unrelated, `相关的事分更高（${related.toFixed(3)} > ${unrelated.toFixed(3)}）`);

  const unresolved = scoreEvent(ev(), { now: NOW, unresolvedIds: new Set(['e_1']) });
  const plain = scoreEvent(ev(), { now: NOW });
  check(unresolved > plain, '未完结的事有加分');

  check(scoreEvent(null) === 0, '空事件返回 0');
}

// ── 3. 选择：过滤、上限、可复现 ─────────────────────────────────────────
console.log('\n=== 3. 选择：过滤 / 上限 / 可复现 ===');
{
  const events = [
    ev({ id: 'e_a', ts: NOW - 1 * DAY, text: '裁员的事', salience: 0.9 }),
    ev({ id: 'e_b', ts: NOW - 2 * DAY, text: '吃饭的事', salience: 0.3 }),
    ev({ id: 'e_c', ts: NOW - 3 * DAY, text: '测试版本', salience: 0.6 }),
    ev({ id: 'e_d', ts: NOW - 4 * DAY, text: '别人的事', actorId: '789', salience: 0.5 }),
    ev({ id: 'e_e', ts: NOW - 5 * DAY, text: '已压缩的事', compacted: true, salience: 1 })
  ];

  const top = selectRecall(events, { now: NOW, limit: 2 });
  check(top.length === 2, 'limit 生效');
  check(!top.some((x) => x.id === 'e_e'), '已压缩的事件不参与检索');

  const forUser = selectRecall(events, { now: NOW, userId: '456', limit: 10 });
  check(forUser.every((x) => String(x.actorId) === '456' || String(x.actorId) === 'self'),
    'userId 过滤只留这个人与她自己');

  const capped = selectRecall([
    ev({ id: 'e_1' }), ev({ id: 'e_2' }), ev({ id: 'e_3' }), ev({ id: 'e_4' }),
    ev({ id: 'e_9', actorId: '789' })
  ], { now: NOW, limit: 4, maxPerActor: 2 });
  const from456 = capped.filter((x) => x.actorId === '456').length;
  check(from456 <= 2, `同一主体最多 2 条（实际 ${from456}）`);
  check(capped.some((x) => x.actorId === '789'), '单人刷屏时其它人仍能进入');

  const a = selectRecall(events, { now: NOW, limit: 3 }).map((x) => x.id);
  const b = selectRecall(events, { now: NOW, limit: 3 }).map((x) => x.id);
  check(JSON.stringify(a) === JSON.stringify(b), '同一输入两次结果完全一致');

  check(selectRecall([], { now: NOW }).length === 0, '空输入返回空数组');
  check(selectRecall(null, { now: NOW }).length === 0, 'null 输入不抛错');
}

// ── 4. 渲染 ─────────────────────────────────────────────────────────────
console.log('\n=== 4. 渲染：格式与预算 ===');
{
  const fixedTs = new Date(2026, 9, 24, 10, 30, 0, 0).getTime();
  const text = formatRecallForPrompt([
    { id: 'e_1', ts: fixedTs, text: '他说被裁员了' },
    { id: 'e_2', ts: fixedTs - DAY, text: '他答应帮我测试' }
  ]);
  const lines = text.split('\n');
  check(lines.length === 2, '一条事件一行');
  check(/^- 10-24 10:30 他说被裁员了$/.test(lines[0]), `首行格式正确（${lines[0]}）`);
  check(lines[1].includes('他答应帮我测试'), '第二条内容正确');

  const longText = '很长的记忆'.repeat(50);
  const capped = formatRecallForPrompt([
    { id: 'e_1', ts: fixedTs, text: longText },
    { id: 'e_2', ts: fixedTs, text: longText },
    { id: 'e_3', ts: fixedTs, text: longText }
  ], { maxChars: 200 });
  check(capped.length <= 200, `总长受 maxChars 约束（${capped.length}）`);
  check(capped.split('\n').length < 3, '超预算时丢弃后面的条目而不是截断半行');

  check(formatRecallForPrompt([]) === '', '空数组渲染为空串');
  check(formatRecallForPrompt([{ id: 'x', ts: fixedTs, text: '   ' }]) === '', '空文本被跳过');
}

console.log(`\n心智检索：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
