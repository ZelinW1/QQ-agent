// 动作注册表 v2：配置化体力 + 扩展行动 + 被拦动作的可见性。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-actions-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { actionsWithCosts, availableActions, blockedActions } = await import(src('src/mind/actions.js'));
const { extensionActions } = await import(src('src/mind/extensions.js'));
const { buildGlobalDecisionPrompt } = await import(src('src/mind/tick.js'));
const { registerTool, unregisterTool } = await import(src('src/tool-registry.js'));
const { updateConfig, getConfig } = await import(src('src/config.js'));

// ── 1. 内置动作的成本读配置 ─────────────────────────────────────────────
console.log('\n=== 1. 体力成本读配置 ===');
{
  const base = actionsWithCosts({});
  const send = base.find((a) => a.id === 'send_proactive');
  check(send.energy === 25, `默认成本不变（${send.energy}）`);

  const cheap = actionsWithCosts({ energy: { cost: { send_proactive: 10 } } });
  check(cheap.find((a) => a.id === 'send_proactive').energy === 10, '配置可覆盖单个动作成本');

  const state = { energy: 10, todayProactive: 0, maxProactive: 8, minProactiveGapMs: 0, lastProactiveAt: 0 };
  check(availableActions(state, cheap).some((a) => a.id === 'send_proactive'),
    '体力 10 时，成本降到 10 的动作变得可做');
  check(!availableActions(state, base).some((a) => a.id === 'send_proactive'),
    '默认成本 25 时同样体力做不了');
}

// ── 2. 被拦下的动作带原因 ───────────────────────────────────────────────
console.log('\n=== 2. 被拦动作 ===');
{
  const state = { energy: 0, todayProactive: 0, maxProactive: 8, minProactiveGapMs: 0, lastProactiveAt: 0 };
  const blocked = blockedActions(state, actionsWithCosts({}));
  check(blocked.length >= 3, `低体力时能看到多条被拦（${blocked.length}）`);
  check(blocked.every((b) => typeof b.reason === 'string' && b.reason.length > 0), '每条都有原因');
  check(blocked.some((b) => b.reason === '体力不够'), '原因是人话（体力不够）');
}

// ── 3. 扩展行动：显式声明 + 默认关 + 配置覆盖 ───────────────────────────
console.log('\n=== 3. 扩展行动 ===');
{
  const tools = [
    { id: 'plain_tool', name: '普通工具', description: '辅助能力' },
    { id: 'qzone_post', name: '发动态', mindAction: { label: '发条动态', energy: 15 } },
    { id: 'profile', name: '改资料', mindAction: { label: '更新资料', energy: 8, defaultEnabled: true } }
  ];

  const off = extensionActions({ tools, cfg: {} });
  check(!off.some((a) => a.id === 'plain_tool'), '没声明 mindAction 的工具永远不会成为行动');
  check(!off.some((a) => a.id === 'qzone_post'), '声明了但默认关 → 不出现');
  check(off.some((a) => a.id === 'profile' && a.energy === 8), '清单默认开 → 出现，成本取自清单');

  const on = extensionActions({ tools, cfg: { overrides: { qzone_post: { enabled: true, label: '发条空间动态', energy: 12 } } } });
  const q = on.find((a) => a.id === 'qzone_post');
  check(Boolean(q), '配置开启后出现');
  check(q.label === '发条空间动态' && q.energy === 12, 'label/energy 可被配置覆盖');
  check(q.external === true && q.toolId === 'qzone_post', '带 external/toolId 标记');

  // 技能卸载 = 工具不在列表里 → 行动自动消失
  const removed = extensionActions({ tools: tools.filter((t) => t.id !== 'profile'), cfg: {} });
  check(!removed.some((a) => a.id === 'profile'), '工具消失后行动一起消失');
}

// ── 4. 菜单里能看到"现在做不了" ─────────────────────────────────────────
console.log('\n=== 4. 提示词里的被拦项 ===');
{
  const msgs = buildGlobalDecisionPrompt({
    botName: '澄',
    state: { energy: 100, todayProactive: 0 },
    roster: [{ name: '王哥', hoursSince: 3, unread: 0 }],
    candidates: [{ name: '王哥', text: '已经 3 小时没联系了' }],
    actions: [{ id: 'send_proactive', label: '主动找她说句话', energy: 25 }],
    blocked: [{ action: { id: 'organize', label: '整理一下记忆' }, reason: '还没攒下多少事' }]
  });
  const user = msgs[1].content;
  check(user.includes('现在做不了的'), '提示词有被拦段');
  check(user.includes('整理一下记忆') && user.includes('还没攒下多少事'), '被拦项带名字和原因');
}

// ── 5. 编排器：扩展行动真的进了菜单并能执行 ────────────────────────────
console.log('\n=== 5. 编排器接入 ===');
{
  const { MindStore } = await import(src('src/mind/store.js'));
  const { Orchestrator } = await import(src('src/orchestrator.js'));

  let executed = 0;
  registerTool({
    id: 'qzone_post',
    name: '发动态',
    description: '发一条空间动态',
    category: 'system',
    mindAction: { label: '发条动态', energy: 12 },
    execute: async () => { executed += 1; return { content: '已发布' }; }
  });

  updateConfig({
    api: { model: 'm', baseUrl: 'http://127.0.0.1:1/v1' },
    mind: {
      enabled: true,
      actions: { overrides: { qzone_post: { enabled: true, energy: 12 } } },
      tick: { enabled: true, mode: 'global', intervalMs: 600000, jitter: 0, proactiveIdleMs: 3600000, idleLookbackMin: 1, minProactiveGapMs: 0, suppressAfterProactiveMs: 0 },
      energy: { max: 100, recoverPerHour: 0, floor: 0 }
    }
  });
  check(getConfig().mind.actions.overrides.qzone_post.enabled === true, '配置已写入');

  const now = Date.now();
  const mind = new MindStore({ root: fs.mkdtempSync(path.join(dataDir, 'g-')), getOptions: () => ({}) });
  const store = {
    listChats: () => ['private:111'],
    unreadCount: () => 0,
    getChatMeta: () => ({ lastTs: now - 5 * 3600000, unread: 0, lastText: '在吗' }),
    recent: () => []
  };
  const orch = new Orchestrator({ store, memory: {}, stickers: {}, sender: {}, sessions: {}, onebot: {}, mind });
  orch.paused = false; orch.aborted = false;

  const replies = [
    { tool_calls: [{ id: 'x1', function: { name: 'qzone_post', arguments: '{"reason":"想发点什么"}' } }] },
    { tool_calls: [{ id: 'x2', function: { name: 'finish', arguments: '{"reason":"够了"}' } }] }
  ];
  let seenTools = [];
  const r = await orch.tickOnce({
    now,
    chat: async (messages, tools) => { seenTools = tools || []; return { message: replies.shift() }; }
  });

  check(seenTools.some((t) => t.function?.name === 'qzone_post'), '扩展行动出现在工具表里');
  check(seenTools.some((t) => t.function?.name === 'finish'), 'finish 也在');
  check(executed === 1, '扩展工具被真正执行');
  check(mind.listActions({ limit: 3 }).some((a) => a.action === 'qzone_post'), '行动写进了 actions.jsonl');
  check(r.results?.[0]?.action === 'qzone_post', '结果里记录了扩展行动');

  unregisterTool('qzone_post');
}

console.log(`\n动作注册表 v2：通过 ${pass}，失败 ${fail}`);
if (fail) process.exit(1);
