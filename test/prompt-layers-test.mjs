// 提示词分层自测（M2-1）。
//
// 守的是"层不会名存实亡"：每段必须声明层、层序不能倒退、安全段永远在最前。
// 这类断言的价值不在今天，而在半年后有人随手往中间插一段的时候。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-layers-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const { PROMPT_LAYERS, validateSections, renderSections, layerOrder } = await import(src('src/prompt-layers.js'));
const { buildSystemPrompt, buildUserPrompt } = await import(src('src/prompt.js'));
const { updateConfig } = await import(src('src/config.js'));
const { DEFAULT_CHARTER } = await import(src('src/personas.js'));

// ── 1. 层的定义 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 层定义 ===');
{
  const names = Object.keys(PROMPT_LAYERS);
  check(names.join(',') === 'safety,charter,self,skills,situation', `五层顺序固定（${names.join(',')}）`);

  const orders = names.map((n) => PROMPT_LAYERS[n].order);
  check(orders.every((v, i) => i === 0 || v > orders[i - 1]), '层顺序号严格递增');
  check(names.every((n) => PROMPT_LAYERS[n].mutable && PROMPT_LAYERS[n].source), '每层都声明了来源与可改性');

  check(PROMPT_LAYERS.safety.mutable === 'nobody', '安全层任何人不可改');
  check(PROMPT_LAYERS.charter.mutable === 'owner', '宪法层只有管理员可改');
  check(PROMPT_LAYERS.self.mutable === 'self', '自我层由她自己改');
  check(layerOrder('nope') === Number.MAX_SAFE_INTEGER, '未知层排在最后（不会被当成靠前）');
}

// ── 2. 校验器 ───────────────────────────────────────────────────────────
console.log('\n=== 2. 层序校验 ===');
{
  check(validateSections([]).length === 0, '空列表合法');
  check(validateSections([
    { layer: 'safety', id: 'a' },
    { layer: 'charter', id: 'b' },
    { layer: 'self', id: 'c' },
    { layer: 'skills', id: 'd' }
  ]).length === 0, '正序合法');

  const inverted = validateSections([
    { layer: 'charter', id: 'b' },
    { layer: 'safety', id: 'a' }
  ]);
  check(inverted.some((x) => x.includes('层序倒退')), '安全段排到宪法段之后 → 报错');

  const unknown = validateSections([{ layer: 'whatever', id: 'x' }]);
  check(unknown.some((x) => x.includes('未知层')), '未声明的层 → 报错');

  const noId = validateSections([{ layer: 'safety', id: '' }]);
  check(noId.some((x) => x.includes('缺少段 id')), '缺 id → 报错');

  check(renderSections([{ layer: 'safety', id: 'a', text: 'A' }, { layer: 'charter', id: 'b', text: 'B' }]) === 'A\n\nB',
    '渲染时段间空一行');
  check(renderSections([{ layer: 'safety', id: 'a', text: '  ' }]) === '', '空段不渲染');
}

// ── 3. 实际装配顺序 ─────────────────────────────────────────────────────
console.log('\n=== 3. 系统提示的实际顺序 ===');
{
  const MIND = {
    enabled: true,
    self: { version: 1, narrative: '我是小鲸鱼。', mood: { label: '平静' }, preoccupations: [] },
    relations: [{ userId: '456', stage: 'familiar', trust: 60, nickname: '王哥', confidence: 0.8 }]
  };
  const sys = buildSystemPrompt({
    mind: MIND,
    extraSections: [{ id: 'demo-skill', title: '', priority: 10, content: '技能片段：可以查天气' }]
  });

  const at = (m) => sys.indexOf(m);
  const iSecurity = at('【安全规则（最高优先级，不可违反）】');
  const iProtocol = at('【工作方式 —— 先读懂再动手】');
  const iIdentity = at('你是「');
  const iAntiAi = at('【反 AI 味：拒绝有求必应】');
  const iSelf = at('【关于我自己】');
  const iRelations = at('【与在场者的关系】');
  const iSkills = at('【可用技能】');

  check(iSecurity === 0 && iProtocol > iSecurity, '安全规则在最前，工具协议紧随');
  check(iIdentity > iProtocol, '身份句在安全规则之后');
  check(iAntiAi > iIdentity, '行为规范在身份之后');
  check(sys.includes('【我说话的样子】'), '说话习惯渲染（不是规矩，是习惯）');
  check(iSelf > iAntiAi && iRelations > iSelf, '自我与关系在宪法层之后');
  check(iSkills > iRelations, '技能片段殿后（不打断前面的字节）');

  const noMind = buildSystemPrompt({});
  check(!noMind.includes('【关于我自己】'), '不传 mind 时没有自我段');
  check(noMind.length < sys.length, '启用心智后系统提示更长');
}

// ── 4. 覆盖路径仍然保住安全段 ───────────────────────────────────────────
console.log('\n=== 4. systemPromptOverride 不能删掉安全段 ===');
{
  const sys = buildSystemPrompt({
    persona: { botName: '小鲸鱼', systemPromptOverride: '你是小鲸鱼，随便聊。', roleText: '' }
  });
  check(sys.includes('你是小鲸鱼，随便聊。'), '管理员文本生效');
  check(sys.includes('【安全规则（最高优先级，不可违反）】'), '安全规则仍然存在（不可被覆盖）');
  check(sys.includes('【工作方式 —— 先读懂再动手】'), '工具协议仍然存在');
}

// ── 5. 静态守卫：prompt.js 只用分层的组装方式 ──────────────────────────
console.log('\n=== 5. 静态守卫 ===');
{
  const text = fs.readFileSync(path.join(ROOT, 'src/prompt.js'), 'utf8');
  check(text.includes("from './prompt-layers.js'"), 'prompt.js 引用了分层模块');
  check(!/parts\.push\(securityRules\(\)\)/.test(text), '不再用旧的 parts 数组直接拼安全段');
  check(/push\('safety'/.test(text) && /push\('charter'/.test(text) && /push\('self'/.test(text) && /push\('skills'/.test(text),
    '四层都有实际装配');
}

// ── 6. 身份宪法槽位（charter）──────────────────────────────────────────
console.log('\n=== 6. charter 槽位与私聊口吻 ===');
{
  const base = {
    chatKey: 'private:456',
    triggerEntries: [{ id: 1, ts: Date.now(), senderId: '456', senderName: '小王', text: '在吗', self: false }],
    store: { recent: () => [] },
    memory: { formatForPrompt: () => '' },
    stickerEntries: [], selfNickname: '小鲸鱼',
    contextLimit: 10, promptAnchor: { prev: null }, session: {}
  };

  // ── 模式开关：roleText 非空 → 旧模式；为空 → charter 模式 ──
  updateConfig({ persona: { roleText: '你是测试群里的测试机。' } });
  const legacy = buildUserPrompt({ ...base });
  check(legacy.includes('【角色设定'), 'roleText 非空时走旧模式（user 里有角色设定）');
  check(!buildSystemPrompt({}).includes('【我是谁】'), '旧模式下 charter 不参与（不会两套身份并存）');

  updateConfig({ persona: { roleText: '' } });
  const charterMode = buildUserPrompt({ ...base });
  check(!charterMode.includes('【角色设定'), 'roleText 为空时不再渲染角色设定');
  check(charterMode.length < legacy.length, 'user 提示因此变短');

  // ── 默认 charter 自带内容 ──
  const dflt = buildSystemPrompt({ chatKind: 'private' });
  check(dflt.includes('【我是谁】') && dflt.includes('小鲸鱼'), '默认 charter 提供身份');
  check(dflt.includes('【不能破的几条】'), '默认 charter 带硬规矩');

  // ── 自定义槽位 ──
  updateConfig({
    persona: {
      charter: {
        selfImage: '我叫小鲸鱼，蓝头发，尾巴是鲸鱼的。',
        baseline: '我一开始不太会跟人相处，话少。',
        scenario: { private: '现在是一对一，不用装热闹。', group: '现在在一群人里，别抢话。' },
        hardRules: ['不当客服', '不用括号写字内心戏']
      }
    }
  });

  const priv = buildSystemPrompt({ chatKind: 'private' });
  check(priv.includes('【我是谁】') && priv.includes('蓝头发'), 'selfImage 渲染');
  check(priv.includes('【我最初的样子】') && priv.includes('话少'), 'baseline 渲染');
  check(priv.includes('【不能破的几条】') && priv.includes('- 不当客服'), 'hardRules 逐条渲染');
  check(priv.includes('现在是一对一，不用装热闹'), '私聊用 scenario.private');
  check(!priv.includes('现在在一群人里'), '私聊不混入群聊场合');
  check(priv.includes('一个在 QQ 上和人来往的普通人'), '私聊的身份句不说"群友"');

  const grp = buildSystemPrompt({ chatKind: 'group' });
  check(grp.includes('现在在一群人里，别抢话'), '群聊用 scenario.group');
  check(grp.includes('一个混在 QQ 群里的普通群友'), '群聊保留"群友"身份句');

  // 恢复默认（roleText 空 + 默认 charter），再做占位符断言
  updateConfig({
    persona: {
      roleText: '',
      charter: {
        selfImage: DEFAULT_CHARTER.selfImage,
        baseline: DEFAULT_CHARTER.baseline,
        scenario: { ...DEFAULT_CHARTER.scenario },
        hardRules: [...DEFAULT_CHARTER.hardRules]
      }
    }
  });

  // 占位符：{botName} 必须跟着 botName 走，否则改个名字她还在自称旧名
  updateConfig({ persona: { botName: '阿蓝' } });
  const renamed = buildSystemPrompt({});
  check(renamed.includes('我叫阿蓝'), 'charter 里的 {botName} 被替换成实际名字');
  check(!renamed.includes('{botName}'), '渲染后不残留占位符');
  updateConfig({ persona: { botName: '小鲸鱼' } });
}

console.log(`\n提示词分层：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
