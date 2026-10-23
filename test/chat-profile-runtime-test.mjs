// 会话级配置的**运行期**端到端回归。
//
// 与 chat-profile-test.mjs 的分工：
//   · chat-profile-test.mjs  —— 解析器纯函数层（喂夹具配置，不启服务）
//   · 本文件                 —— 真实链路：配置文件 → app 启动 → 消息进来 →
//                               orchestrator 解析快照 → 工具集/提示词实际被影响
//
// 为什么值得单独一套：解析器正确 ≠ 接得对。"profile 解析对了，但 orchestrator
// 没把它传下去"这类断线，纯函数测试**永远发现不了** —— 而它正是本次重构要防的
// "改了但没生效"。所以这里必须断言**最终发给模型的 tools 数组**。
//
// ⚠️ 一次 bootApp：同进程第二次 createApp 会因模块级单例（skillManager /
//    插件注册表）残留而连不上 OneBot。两个群靠不同 group_id 区分，不重复启动。
// 运行：node test/chat-profile-runtime-test.mjs
import assert from 'node:assert/strict';
import { bootApp, sleep, waitFor } from './_harness.mjs';

const pass = [], fail = [];
async function check(name, fn) {
  try { await fn(); pass.push(name); console.log(`  ✓ ${name}`); }
  catch (e) { fail.push(name); console.error(`  ✗ ${name}\n      ${e.message}`); }
}

const GROUP_A = '456';
const GROUP_B = '789';

const env = await bootApp({
  config: {
    // 两个群都要放行（否则 B 群消息会被白名单挡在入口）
    allow: { groups: [GROUP_A, GROUP_B], private: ['777'] },
    // 联网开着（下面让 A 群单独关掉它）
    webSearch: { enabled: true },
    store: { contextSliderPos: 100, historyCount: 80 },
    wakeDelayMs: 300,
    // A 群关掉 web 分类 + 关联网；B 群不配 → 全局口径
    chatProfiles: {
      [`group:${GROUP_A}`]: {
        tools: { categories: { web: false } },
        webSearch: { enabled: false }
      }
    }
  }
});
const { llm, pushGroupMsg, teardown, app } = env;

/** 取最近一条发给模型的请求。 */
const lastReq = () => llm.state.requests.at(-1);
/** 该请求里模型可用的工具名集合。 */
const toolNamesOf = (req) => new Set((req?.tools || []).map((t) => t.function?.name).filter(Boolean));
const settle = () => sleep(800);

let reqCountBefore = 0;

// ── 1. A 群（关联网）→ web 类工具必须不在工具表里 ──────────────────────
await check('A 群：分会话关掉 web 分类后，模型工具表里没有 web_search / web_fetch', async () => {
  reqCountBefore = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot A群测试一句', 88001, { group_id: Number(GROUP_A) });
  await waitFor(() => llm.state.requests.length > reqCountBefore, 8000, 'A 群 LLM 请求');
  const names = toolNamesOf(lastReq());
  assert.ok(names.size > 0, `应至少有一个工具，实际 ${names.size}`);
  assert.ok(!names.has('web_search'), `A 群不应有 web_search，实际有：${[...names].join(',')}`);
  assert.ok(!names.has('web_fetch'), 'A 群不应有 web_fetch');
  // 非 web 的工具仍应在（证明不是"整个工具表为空"这种假通过）
  assert.ok(names.has('send_message'), 'send_message 仍应在（区分"被精确关掉"与"全没了"）');
});
await settle();

// ── 2. 跨会话隔离：B 群不受 A 群覆盖影响 ───────────────────────────────
await check('B 群：没有覆盖 → web_search 仍可用（跨会话隔离）', async () => {
  const before = llm.state.requests.length;
  pushGroupMsg(112, '李四', '@覆盖Bot B群测试一句', 88002, { group_id: Number(GROUP_B) });
  await waitFor(() => llm.state.requests.length > before, 8000, 'B 群 LLM 请求');
  const names = toolNamesOf(lastReq());
  assert.ok(names.has('web_search'), `B 群应仍有 web_search，实际：${[...names].join(',')}`);
});
await settle();

// ── 3. 视觉/联网派生量进了提示词（与工具闸门同源）────────────────────
await check('A 群：系统提示的联网/看图行与工具闸门同一口径（不再自相矛盾）', async () => {
  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot A群第二句', 88003, { group_id: Number(GROUP_A) });
  await waitFor(() => llm.state.requests.length > before, 8000, 'A 群第二次 LLM 请求');
  const req = lastReq();
  const sys = String(req.messages[0].content);
  const names = toolNamesOf(req);
  // A 群联网关着 → 提示词必须说"没有联网能力"，且工具表里也没有 web_search。
  // 这两条以前是两处各自判断（prompt 读 api.vision/webSearch，工具闸门读 orchestrator
  // 算的 visionEnabled/searchEnabled），会互相矛盾。
  assert.ok(sys.includes('你没有联网能力'), 'A 群系统提示应声明没有联网能力');
  assert.ok(!names.has('web_search'), 'A 群工具表也不该有 web_search（口径一致）');
});
await settle();

// ── 4. 运行期改配置 → 下一次运行生效（不缓存旧值）──────────────────────
await check('运行期放开 A 群联网 → 下一次运行的提示词与工具表都恢复', async () => {
  const w = await env.request('POST', '/api/config', {
    body: { chatProfiles: { __replace__: {} } }
  });
  assert.equal(w.status, 200, `清掉覆盖应 200，实际 ${w.status}`);
  const before = llm.state.requests.length;
  pushGroupMsg(111, '张三', '@覆盖Bot A群第三句', 88004, { group_id: Number(GROUP_A) });
  await waitFor(() => llm.state.requests.length > before, 8000, 'A 群第三次 LLM 请求');
  const req = lastReq();
  const names = toolNamesOf(req);
  assert.ok(names.has('web_search'),
    `清掉覆盖后 web_search 应恢复（若仍缺失 = 快照被缓存成了旧值），实际：${[...names].join(',')}`);
  const sys = String(req.messages[0].content);
  assert.ok(!sys.includes('你没有联网能力'), '系统提示也应恢复"有联网"口径');
});
await settle();

// ── 5. 会话记录里带上下文档位（跑过就该有痕迹）────────────────────────
await check('会话记录留下 contextTier / contextLimit（分会话判定可追溯）', async () => {
  const list = app.sessions.listSummaries(50);
  assert.ok(list.length > 0, '应有会话记录');
  const withTier = list.filter((s) => Number.isFinite(Number(s.contextTier ?? NaN)) || s.trigger);
  assert.ok(withTier.length > 0, '会话摘要应带触发信息');
});

await teardown();

console.log(`\n会话级配置（运行期）：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) {
  console.log('\n失败明细：');
  for (const f of fail) console.log(`  ✗ ${f}`);
  process.exit(1);
}
