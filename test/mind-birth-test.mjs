// 出生仪式自测：提示词、校验、解析、整条链路、接口。
//
// 这一层最该被盯住，因为身份是"一次性"的：草案写坏了可以改，
// 但"她一开始是谁"反复重来，她就不再有一个稳定的起点。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-birth-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { buildBirthPrompt, validateDraft, parseBirthDrafts } = await import(src('src/mind/birth.js'));
const { Orchestrator } = await import(src('src/orchestrator.js'));
const { updateConfig } = await import(src('src/config.js'));

const GOOD = {
  name: ['小鲸鱼', '蓝汐'],
  selfImage: '我叫{botName}，蓝色渐变长发，蓝瞳，头上有一撮呆毛，尾巴是鲸鱼的。',
  baseline: '我还没想清楚自己会成为什么样的人，现在只是有点好奇地活着。这些只是起点，以后会变。',
  voice: ['句尾很少用句号', '被夸会先否认']
};

// ── 1. 提示词 ───────────────────────────────────────────────────────────
console.log('\n=== 1. 提示词 ===');
{
  const m = buildBirthPrompt({
    botName: '小鲸鱼',
    keywords: ['鲸鱼少女', '蓝色渐变长发', '蓝瞳'],
    vision: '成为一个会自我成长、有自己思想的伙伴'
  });
  check(m.length === 2 && m[0].role === 'system', 'system + user 两条');
  const sys = m[0].content;
  check(sys.includes('第一人称'), '要求第一人称');
  check(sys.includes('不要写行为规矩'), '明确不写规矩（规矩是主人的事）');
  check(sys.includes('不用 markdown'), '禁止 markdown');
  check(sys.includes('{botName}'), '要求用 {botName} 占位');
  check(sys.includes('起点'), '要求留出"只是起点"的余地');
  check(!sys.includes('请扮演') && !/^\s*你是/.test(sys), '不把"扮演某个角色"当作任务（只写"她一开始是谁"）');

  const user = m[1].content;
  check(user.includes('鲸鱼少女') && user.includes('蓝色渐变长发'), '关键词进了 user');
  check(user.includes('自我成长'), '愿景进了 user');
  check(user.includes('小鲸鱼'), '带上现有名字');
}

// ── 2. 校验 ─────────────────────────────────────────────────────────────
console.log('\n=== 2. 草案校验 ===');
{
  check(validateDraft(GOOD) === null, '合格草案通过');

  check(validateDraft({ ...GOOD, selfImage: '短' }) !== null, '自我形象太短被拒');
  check(validateDraft({ ...GOOD, selfImage: '蓝色渐变长发，蓝瞳。' }) !== null, '不是第一人称被拒');
  check(validateDraft({ ...GOOD, baseline: '我**很**特别' }) !== null, 'markdown 被拒');
  check(validateDraft({ ...GOOD, baseline: '我在扮演一个角色' }) !== null, '扮演说法被拒');
  check(validateDraft({ ...GOOD, name: [] }) !== null, '没有名字被拒');
  check(validateDraft({ ...GOOD, name: ['鲸'] }) !== null, '名字太短被拒');
  check(validateDraft(null) !== null, 'null 被拒');
}

// ── 3. 解析 ─────────────────────────────────────────────────────────────
console.log('\n=== 3. 解析（坏的逐条丢弃，不整批放弃）===');
{
  const good = JSON.stringify({ drafts: [GOOD, { ...GOOD, selfImage: '短' }, { ...GOOD, baseline: '我**特别**' }] });
  const r = parseBirthDrafts(good);
  check(r.ok === true && r.drafts.length === 1, `三组里只有一组合格（保留 ${r.drafts.length}）`);
  check(r.rejected.length === 2, '两组被拒并记录原因');
  check(r.rejected.every((x) => typeof x.reason === 'string' && x.reason), '拒绝原因可读');

  const fenced = parseBirthDrafts('```json\n' + good + '\n```');
  check(fenced.ok === true, '代码块包裹也能解析');

  check(parseBirthDrafts('我想了想').ok === false, '纯文本 → 失败');
  check(parseBirthDrafts('{"drafts":[]}').ok === false, '空草案 → 失败');
  const allBad = parseBirthDrafts(JSON.stringify({ drafts: [{ name: '鲸' }] }));
  check(allBad.ok === false && allBad.rejected.length === 1, '全部不合格 → 失败但有原因');
}

// ── 4. 整条链路（注入模型）──────────────────────────────────────────────
console.log('\n=== 4. draftCharter ===');
{
  const orch = Object.create(Orchestrator.prototype);
  const sent = [];
  const r = await orch.draftCharter(
    { keywords: '鲸鱼少女, 蓝瞳', vision: '成为有自己思想的伙伴' },
    { chat: async (messages) => { sent.push(messages); return { message: { content: JSON.stringify({ drafts: [GOOD, GOOD, GOOD] }) }, usage: { prompt_tokens: 500 } }; } }
  );
  check(r.ok === true && r.drafts.length === 3, '产出三组');
  check(sent.length === 1, '只调一次模型');
  check(sent[0][1].content.includes('蓝瞳'), '关键词被带进请求');
  check(r.usage?.prompt_tokens === 500, '带回用量（可统计成本）');

  const bad = await orch.draftCharter({ vision: 'x' }, { chat: async () => ({ message: { content: '没有 JSON' } }) });
  check(bad.ok === false, '模型乱答时失败');
}

// ── 5. 接口见 mind-birth-api.mjs ────────────────────────────────────────
// 接口测试必须**先 boot 再 import src**（数据目录在 config 模块加载时就定死了），
// 所以拆成独立进程，不在这里做。

console.log(`\n出生仪式：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
