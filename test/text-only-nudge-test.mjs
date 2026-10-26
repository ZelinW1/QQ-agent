// 回归：模型把回复写在正文里、没有调用任何工具时，必须纠正一次而不是静默丢话。
//
// 真实故障：聊天中出现"思考 / 不发送 <内容>"作为最后一步，之后就再没有回复。
// 根因是正文按设计不会发到 QQ，而循环在"没有原生工具调用"时直接 break。
// 修复：当这一轮一条都没发出去、正文非空时，注入一次系统提醒并再给一轮机会。
import assert from 'node:assert/strict';
import { bootApp, sleep } from './_harness.mjs';

const env = await bootApp({ config: { wakeDelayMs: 200 } });
const { app, pushGroupMsg, llm, onebotHttp } = env;

const pass = [], fail = [];
const check = (name, fn) => {
  try { fn(); pass.push(name); console.log(`  ✓ ${name}`); } catch (e) {
    fail.push(name);
    console.error(`  ✗ ${name}\n      ${e.message}`);
  }
};

// 场景 1：第一轮只写正文 → 应被纠正；第二轮调用 send_message → 消息真的发出去
{
  llm.state.script.length = 0;
  llm.state.script.push(
    { content: '在的，怎么了？' },
    { toolCalls: [{ name: 'send_message', args: { messages: ['在的，怎么了？'] } }] }
  );
  const before = onebotHttp.state.sends.length;
  pushGroupMsg(111, '张三', '@覆盖Bot 在吗', 9901);
  await sleep(2500);

  const sends = onebotHttp.state.sends.slice(before);
  const texts = sends.flatMap((s) => (s.body?.message || []).filter((x) => x.type === 'text').map((x) => x.data.text));
  check('正文里的回复被纠正后真的发出去了', () => {
    assert.ok(texts.includes('在的，怎么了？'), `实际发送：${JSON.stringify(texts)}`);
  });
  check('确实发生了两次模型调用（正文 + 纠正后）', () => {
    assert.ok(llm.state.requests.length >= 2, `请求数 ${llm.state.requests.length}`);
  });
  check('纠正时注入了系统提醒', () => {
    const all = JSON.stringify(llm.state.requests.map((r) => r.messages));
    assert.ok(all.includes('系统提醒') && all.includes('没有调用任何工具'), '请求里没有看到纠正提醒');
  });
}

// 场景 2：第一轮只写正文 → 纠正后仍然只写正文 → 允许静默结束（不无限催）
{
  llm.state.script.length = 0;
  llm.state.script.push({ content: '算了，不说了。' }, { content: '真的不说了。' });
  const before = onebotHttp.state.sends.length;
  const reqBefore = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot 睡了吗', 9902);
  await sleep(2500);
  const sends = onebotHttp.state.sends.slice(before);
  check('纠正一次后仍未调用工具 → 不发送，也不会无限重试', () => {
    assert.equal(sends.length, 0, `不应发送，实际 ${JSON.stringify(sends.map((s) => s.body?.message))}`);
    assert.ok(llm.state.requests.length - reqBefore <= 3,
      `最多再要一轮，实际多发了 ${llm.state.requests.length - reqBefore} 次请求`);
  });
}

await env.teardown();
console.log(`\n正文未发送纠正：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
