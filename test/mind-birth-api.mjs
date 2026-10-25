// 出生仪式接口自测。
//
// ⚠️ 必须先 boot 再 import 任何 src 模块：config.js 在加载时就把 DATA_DIR 定死，
// 提前 import 会让 app 用错数据目录（表现为 OneBot 连接超时）。
import { bootApp } from './_harness.mjs';

const pass = [], fail = [];
const check = (cond, msg, detail = '') => {
  if (cond) { pass.push(msg); console.log('  ✓ ' + msg); }
  else { fail.push(msg); console.error(`  ✗ ${msg}${detail ? '\n      ' + detail : ''}`); }
};

const GOOD = {
  name: ['小鲸鱼', '蓝汐'],
  selfImage: '我叫{botName}，蓝色渐变长发，蓝瞳，头上有一撮呆毛，尾巴是鲸鱼的。',
  baseline: '我还没想清楚自己会成为什么样的人。这些只是起点，以后会变。',
  voice: ['句尾很少用句号']
};

const env = await bootApp({
  script: [{ content: JSON.stringify({ drafts: [GOOD, GOOD, GOOD] }) }]
});

const noSeed = await env.request('POST', '/api/mind/charter/draft', { body: {} });
check(noSeed.status === 400, `没给种子 → 400（实际 ${noSeed.status}）`);

const okRes = await env.request('POST', '/api/mind/charter/draft', {
  body: { seed: { keywords: ['鲸鱼少女', '蓝瞳'], vision: '成为一个会自我成长的伙伴' } }
});
check(okRes.status === 200, `正常生成 → 200（实际 ${okRes.status}）`);
check(Array.isArray(okRes.data?.drafts) && okRes.data.drafts.length === 3, '返回三组草案');
check(okRes.data.drafts[0].selfImage.includes('{botName}'), '草案里保留占位符');
check(Array.isArray(okRes.data.drafts[0].name), '带候选名字');

// 关键：草案**不写盘** —— 此时配置里的 charter 仍是默认值
const state = await env.request('GET', '/api/mind/state');
check(state.data.charter.selfImage.includes('{botName}'), '生成草案不会改动配置（写盘必须经主人确认）');
check(!state.data.charter.selfImage.includes('蓝色渐变'), '配置里没有草案内容');

// 脚本耗尽后模型返回默认文本 → 应当报错而不是写盘
const drained = await env.request('POST', '/api/mind/charter/draft', {
  body: { seed: { vision: '再来一组' } }
});
check(drained.status === 502, `模型答非所问 → 502（实际 ${drained.status}）`);

await env.teardown();

console.log(`\n出生仪式（接口）：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
