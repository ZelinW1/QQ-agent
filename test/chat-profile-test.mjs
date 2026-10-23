// 会话级配置快照（chat-profile）自测。
//
// 这一套守的是本次重构的核心承诺：**一处解析 + 跨会话隔离**。
// 它不是"跑通就行"的冒烟测试，而是把几条设计约束固化成断言：
//   · 阶段 1 等价性：没有任何分会话覆盖时，快照必须与全局配置逐字段相等
//     （重构的第一目标是零行为变更，这条是它的证据）
//   · 一处解析：解析器是纯函数，喂什么配置得什么结果，不受全局状态影响
//   · 跨会话隔离：A 群的覆盖绝不影响 B 群（用户要的"每个会话独享一套配置"）
//   · 密钥不进快照：快照会进运行期上下文/可能回传 UI，apiKey 必须在白名单外
//   · 派生量统一：visionEnabled 只算一次，且与工具闸门口径一致
//     （这条修的是"模型不支持图片、提示词却说能看图"的现存隐患）
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 动态 import 在 Windows 上必须给 file:// URL —— 直接传盘符路径会
// ERR_UNSUPPORTED_ESM_URL_SCHEME（'d:' 不是受支持的 scheme）。
const srcUrl = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { DEFAULT_CONFIG, deepMerge } = await import(srcUrl('src/config.js'));
const {
  buildChatProfileFrom, CHAT_PROFILE_PATHS, CHAT_PROFILE_VERSION, chatProfileFingerprint
} = await import(srcUrl('src/chat-profile.js'));
const { getToolAvailability, registerTool, clearRegistry } = await import(srcUrl('src/tool-registry.js'));

/** 造一份与 DEFAULT_CONFIG 同形的夹具配置（深合并，避免污染默认值）。 */
const fixture = (patch = {}) => deepMerge(DEFAULT_CONFIG, patch);

const A = 'group:111';
const B = 'group:222';

// ── 1. 等价性：无覆盖时快照 == 全局 ─────────────────────────────────────
console.log('\n=== 1. 无覆盖：快照与全局一致（阶段 1 零行为变更的证据）===');
{
  const cfg = fixture({
    api: { model: 'm-1', provider: 'p-1', vision: true },
    persona: { botName: '小鲸鱼', roleText: '全局角色' },
    tools: { enabled: true, categories: { web: true }, overrides: { web_search: true } },
    webSearch: { enabled: true }
  });
  const p = buildChatProfileFrom(cfg, A);

  check(p.version === CHAT_PROFILE_VERSION, `快照带结构版本号（${p.version}）`);
  check(p.chatKey === A, 'chatKey 原样带回');
  check(p.persona.roleText === '全局角色', 'persona 来自全局');
  check(p.tools.enabled === true && p.tools.categories.web === true, 'tools 来自全局');
  check(p.api.model === 'm-1' && p.api.provider === 'p-1', 'api 来自全局');
  check(p.webSearch.enabled === true, 'webSearch 来自全局');
  check(Number.isFinite(Number(p.store.contextTier)), 'store 折算出了 contextTier');
  check(p.visionEnabled === true, 'visionEnabled=true（开关开 + 未探测为不支持）');
  check(p.searchEnabled === true, 'searchEnabled=true');
  check(typeof p.fingerprint === 'string' && p.fingerprint.length > 0, 'fingerprint 非空');
}

// ── 2. 纯函数：不受全局配置影响 ─────────────────────────────────────────
console.log('\n=== 2. 解析器是纯函数（喂什么得什么，不读全局）===');
{
  const cfg = fixture({ persona: { roleText: '夹具角色' } });
  const p1 = buildChatProfileFrom(cfg, A);
  const p2 = buildChatProfileFrom(cfg, A);
  check(p1.persona.roleText === '夹具角色', '用了传入的夹具配置，而不是磁盘/全局配置');
  check(p1.fingerprint === p2.fingerprint, '同一输入两次解析结果一致（确定性）');

  // 改全局配置不应影响已解析的快照（快照是深拷贝，不是活引用）
  const before = p1.persona.roleText;
  cfg.persona.roleText = '事后被改掉';
  check(p1.persona.roleText === before, '解析后修改源配置，快照不受影响（深拷贝）');
}

// ── 3. 跨会话隔离（核心承诺）────────────────────────────────────────────
console.log('\n=== 3. 跨会话隔离：A 的覆盖不影响 B ===');
{
  const cfg = fixture({
    api: { model: '', provider: '', vision: true },
    tools: { enabled: true, categories: { web: true, media: true } },
    webSearch: { enabled: true },
    chatProfiles: {
      [A]: {
        tools: { categories: { web: false } },
        webSearch: { enabled: false },
        api: { model: 'group-a-model' }
      }
    }
  });
  const pa = buildChatProfileFrom(cfg, A);
  const pb = buildChatProfileFrom(cfg, B);

  check(pa.tools.categories.web === false, 'A：web 分类被关掉');
  check(pb.tools.categories.web === true, 'B：web 分类不受影响');
  check(pa.webSearch.enabled === false, 'A：联网被关');
  check(pb.webSearch.enabled === true, 'B：联网仍开');
  check(pa.api.model === 'group-a-model', 'A：模型被覆盖');
  check(pb.api.model === '', 'B：模型保持全局');
  check(pa.searchEnabled === false && pb.searchEnabled === true, 'A/B 的 searchEnabled 派生量各自正确');
  check(pa.fingerprint !== pb.fingerprint, 'A/B 指纹不同（锚点失效判定依赖它）');

  // 隔离的"可执行"证据：同一工具在两个会话下可用性不同
  clearRegistry();
  registerTool({
    id: 'probe_web', name: '探测', description: '探针', category: 'web',
    execute: async () => ({ content: 'ok' })
  });
  const skillsStub = { isActive: () => ({ active: true, code: null, reason: '' }), getToolGuards: () => [], status: () => ({ name: 'stub' }) };
  const avail = (profile) => getToolAvailability('probe_web', {
    skills: skillsStub, toolsCfg: profile.tools, visionEnabled: profile.visionEnabled, searchEnabled: profile.searchEnabled
  });
  const ra = avail(pa); const rb = avail(pb);
  check(ra.enabled === false && ra.code === 'category-disabled', `A 群该工具不可用（${ra.code}）`, JSON.stringify(ra));
  check(rb.enabled === true, 'B 群该工具可用', JSON.stringify(rb));
  clearRegistry();
}

// ── 4. api 段只带安全字段：密钥/地址根本不进快照 ───────────────────────
console.log('\n=== 4. api 快照剥掉密钥与 baseUrl，且覆盖过白名单 ===');
{
  const cfg = fixture({
    api: { apiKey: 'sk-secret-should-not-leak', baseUrl: 'https://api.example/v1', model: 'global-model' },
    chatProfiles: {
      [A]: {
        // 恶意/误写的覆盖：想借分会话配置把密钥塞进快照
        api: { model: 'a-model', apiKey: 'sk-injected', baseUrl: 'http://evil' }
      }
    }
  });
  const p = buildChatProfileFrom(cfg, A);
  check(p.api.model === 'a-model', '白名单字段 model 生效');
  check(!('apiKey' in p.api), 'apiKey 不在快照里（连全局的也不带）');
  check(!('baseUrl' in p.api), 'baseUrl 不在快照里');
  check(!JSON.stringify(p).includes('sk-'), '快照 JSON 序列化后不含任何密钥字面量');
  check(!JSON.stringify(p).includes('api.example') && !JSON.stringify(p).includes('evil'),
    '快照序列化后不含任何端点地址');
  check(CHAT_PROFILE_PATHS.api.keys.includes('apiKey') === false, '声明式表里 api 白名单不含 apiKey');

  // 派生量仍在（这部分才是快照存在的意义）
  check(p.api.vision === undefined || typeof p.api.vision === 'boolean', 'api 保留 vision 开关');
  check(typeof p.visionEnabled === 'boolean', 'visionEnabled 仍被派生出来');
}

// ── 5. __replace__ 约定 ─────────────────────────────────────────────────
console.log('\n=== 5. __replace__ 整体替换仍然可用（删键的唯一途径）===');
{
  const cfg = fixture({
    tools: { overrides: { send_message: true, web_fetch: true } },
    chatProfiles: {
      [A]: { tools: { overrides: { __replace__: { send_message: true } } } }
    }
  });
  const p = buildChatProfileFrom(cfg, A);
  check(p.tools.overrides.send_message === true, '保留显式写下的键');
  check(!('web_fetch' in p.tools.overrides), 'web_fetch 被 __replace__ 整体替换掉了');
}

// ── 6. skills 覆盖（byId 合并）─────────────────────────────────────────
console.log('\n=== 6. skills 按 id 合并，且只改写的字段变 ===');
{
  const cfg = fixture({
    skills: { 'some-skill': { enabled: true, threshold: 5, keepMe: 'x' } },
    chatProfiles: {
      [A]: { skills: { 'some-skill': { enabled: false } } }
    }
  });
  const pa = buildChatProfileFrom(cfg, A);
  const pb = buildChatProfileFrom(cfg, B);
  check(pa.skills['some-skill'].enabled === false, 'A：该技能被关');
  check(pa.skills['some-skill'].threshold === 5, '同一 id 的其它设置被保留（浅合并）');
  check(pa.skills['some-skill'].keepMe === 'x', '未提及的字段原样保留');
  check(pb.skills['some-skill'].enabled === true, 'B：技能仍开');
}

// ── 7. 人设：复用 personaUnified / personaByChat 的既有语义 ─────────────
console.log('\n=== 7. 人设覆盖尊重既有语义 ===');
{
  // 7a. 显式写分会话人设 → 即便全局 personaUnified=true 也应生效（否则静默无效）
  const cfgA = fixture({
    personaUnified: true,
    persona: { roleText: '全局', botName: '小鲸鱼' },
    chatProfiles: { [A]: { persona: { roleText: 'A 群专属' } } }
  });
  const pa = buildChatProfileFrom(cfgA, A);
  const pb = buildChatProfileFrom(cfgA, B);
  check(pa.persona.roleText === 'A 群专属', 'A：分会话人设生效（不被 personaUnified 吞掉）');
  check(pb.persona.roleText === '全局', 'B：没有分会话人设，回落全局');

  // 7b. botName 是账号身份，任何层都不可被分会话改掉
  const cfgB = fixture({
    persona: { botName: '小鲸鱼', selfNickname: '鲸' },
    chatProfiles: { [A]: { persona: { roleText: 'x', botName: '冒充者', selfNickname: '假' } } }
  });
  const p2 = buildChatProfileFrom(cfgB, A);
  check(p2.persona.botName === '小鲸鱼', 'botName 不可被分会话覆盖（@ 判定依赖它）');
  check(p2.persona.selfNickname === '鲸', 'selfNickname 不可被分会话覆盖');

  // 7c. legacy personaByChat 仍生效（老数据兼容，不做破坏性迁移）
  const cfgC = fixture({
    personaUnified: false,
    persona: { roleText: '全局' },
    personaByChat: { '111': { roleText: 'legacy 独立人设' } }
  });
  const p3 = buildChatProfileFrom(cfgC, A);
  check(p3.persona.roleText === 'legacy 独立人设', 'legacy personaByChat（裸 id 键）仍生效');
}

// ── 8. 档位覆盖走既有四象限逻辑 ─────────────────────────────────────────
console.log('\n=== 8. 档位：分会话覆盖 + 既有峰谷/禁言语义不被打乱 ===');
{
  const cfg = fixture({
    store: { unifiedTier: true, contextSliderPos: 100, historyCount: 80 },
    chatProfiles: { [A]: { store: { contextSliderPos: 0 } } }
  });
  // contextSliderPos 是派生字段的来源：updateConfig 会据它算 tier，
  // 直接喂 cfg 时 tier 由 store 里已有的值决定 —— 这里只断言"覆盖被吃进去了"。
  const pa = buildChatProfileFrom(cfg, A);
  const pb = buildChatProfileFrom(cfg, B);
  check(pa.store.contextSliderPos === 0, 'A：滑条位置被分会话覆盖');
  check(pb.store.contextSliderPos === 100, 'B：滑条位置保持全局');
  check(pa.store.historyCount === 80 && pb.store.historyCount === 80, '未覆盖的字段两边一致');

  // 指令禁言是最高优先级硬覆盖，且只在群聊生效
  const cfgMute = fixture({
    commandMute: { enabled: true, command: '/安静', durationMin: 30, active: { '111': 0 } },
    chatProfiles: { [A]: { store: { contextSliderPos: 100 } } }
  });
  const pm = buildChatProfileFrom(cfgMute, A);
  check(pm.store.contextTier === 1, '禁言中：档位被强制为 1（优先于分会话覆盖）');
  check(pm.store.randomPercent === 0, '禁言中：随机概率清零');
}

// ── 9. 屏蔽名单进快照（提示词过滤用）──────────────────────────────────
console.log('\n=== 9. 屏蔽名单按会话进入快照 ===');
{
  const cfg = fixture({
    globalBlocklist: [999, '888'],
    blocklist: { '111': [123, '456'], '222': [777] }
  });
  const pa = buildChatProfileFrom(cfg, A);
  const pb = buildChatProfileFrom(cfg, B);
  check(pa.globalBlocklist.length === 2 && pa.globalBlocklist.every((x) => typeof x === 'string'),
    '全局屏蔽名单进入快照且字符串化');
  check(pa.blocklist.includes('123') && pa.blocklist.includes('456'), 'A：本群屏蔽名单正确');
  check(!pa.blocklist.includes('777'), 'A：不含 B 群的屏蔽项');
  check(pb.blocklist.includes('777') && !pb.blocklist.includes('123'), 'B：屏蔽名单互相隔离');

  // 私聊不应套用群屏蔽
  const pp = buildChatProfileFrom(cfg, 'private:555');
  check(pp.blocklist.length === 0, '私聊不套用群屏蔽名单');
}

// ── 10. visionEnabled 与工具闸门口径一致（修现存隐患）─────────────────
console.log('\n=== 10. visionEnabled：提示词与工具闸门同一口径 ===');
{
  const off = buildChatProfileFrom(fixture({ api: { vision: false } }), A);
  check(off.visionEnabled === false, 'api.vision=false → visionEnabled=false');

  const on = buildChatProfileFrom(fixture({ api: { vision: true, provider: 'nope', model: 'nope' } }), A);
  check(on.visionEnabled === true, '开关开 + 未知模型 → 保持 true（不武断禁用）');
}

// ── 11. 指纹只收影响提示词的项 ─────────────────────────────────────────
console.log('\n=== 11. 指纹：影响提示词的变，不影响的不变 ===');
{
  const base = fixture({ api: { model: 'm', provider: 'p' }, persona: { roleText: 'R' } });
  const f1 = buildChatProfileFrom(base, A).fingerprint;
  const f2 = buildChatProfileFrom(fixture({ api: { model: 'm2', provider: 'p' }, persona: { roleText: 'R' } }), A).fingerprint;
  check(f1 === f2, '换模型不改指纹（模型 id 不进提示词）');

  const f3 = buildChatProfileFrom(fixture({ persona: { roleText: 'R2' } }), A).fingerprint;
  check(f1 !== f3, '换人设改指纹（会触发锚点失效）');

  const f4 = buildChatProfileFrom(fixture({ store: { historyCount: 40 } }), A).fingerprint;
  check(f1 !== f4, '改上下文条数改指纹');

  const f5 = buildChatProfileFrom(fixture({ tools: { enabled: false } }), A).fingerprint;
  check(f1 !== f5, '关工具总开关改指纹');

  check(chatProfileFingerprint(null) === '', '非对象输入安全返回空串');
}

// ── 12. 健壮性：脏数据不抛错 ──────────────────────────────────────────
console.log('\n=== 12. 脏数据/边界输入不抛错 ===');
{
  const cases = [
    [undefined, A], [null, A], ['not-an-object', A], [{}, A],
    [{ chatProfiles: null }, A], [{ chatProfiles: { [A]: 'nope' } }, A],
    [{ chatProfiles: { [A]: null } }, A], [DEFAULT_CONFIG, ''], [DEFAULT_CONFIG, null]
  ];
  let threw = null;
  for (const [cfg, key] of cases) {
    try { buildChatProfileFrom(cfg, key); } catch (e) { threw = `${JSON.stringify(cfg)} / ${key} → ${e.message}`; break; }
  }
  check(threw === null, '非法配置/空 chatKey 都不抛错', threw || '');
  const empty = buildChatProfileFrom(DEFAULT_CONFIG, '');
  check(empty.chatKey === '' && empty.blocklist.length === 0, '空 chatKey 得到安全默认快照');
}

console.log(`\n会话级配置快照：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
