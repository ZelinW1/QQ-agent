// 心智注入自测（PR2）。
//
// 守两件事：
//   1. **关闭时逐字节不变** —— 这是整套心智功能的安全阀，回归时必须能证明。
//   2. **写的是"她是谁"，不是"她该演谁"** —— 禁止扮演框架词汇。
//      这条看着像措辞洁癖，其实是产品方向：一旦提示词里出现"你要扮演"，
//      模型就会退回到"演一个角色"，而不是"作为自己说话"。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-inject-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const {
  renderSelfSection, renderRelationsSection, renderRecentSection, mindFingerprint, collectMindContext
} = await import(src('src/mind/inject.js'));
const { MindStore } = await import(src('src/mind/store.js'));
const { buildUserPrompt, buildSystemPrompt } = await import(src('src/prompt.js'));

// 方向守卫：这些词一出现，她就在"演"，不在"是"
const FORBIDDEN = ['扮演', '角色扮演', '人设', '按照设定', '演技', '假装是'];

// ── 1. 【关于我自己】 ───────────────────────────────────────────────────
console.log('\n=== 1. 【关于我自己】 ===');
{
  const text = renderSelfSection({
    version: 3,
    narrative: '我是小鲸鱼。最近在学着分辨谁值得认真对待。',
    mood: { label: '有点烦' },
    preoccupations: ['那家伙说要辞职，不知道后来怎样了']
  });
  check(text.startsWith('【关于我自己】'), '有段头');
  check(text.includes('我是小鲸鱼'), '包含她自己的叙事');
  check(text.includes('我现在的心情：有点烦'), '包含心情');
  check(text.includes('我最近挂心的') && text.includes('辞职'), '包含挂心的事');
  check(!FORBIDDEN.some((w) => text.includes(w)), '不含扮演类词汇');

  check(renderSelfSection(null) === '', 'null 返回空串');
  check(renderSelfSection({ version: 0, narrative: '', mood: { label: '' }, preoccupations: [] }) === '',
    '全空时不插段（保证逐字节不变）');
  check(renderSelfSection({ narrative: '只有叙事' }) === '【关于我自己】\n只有叙事', '只有叙事时的形状');
}

// ── 2. 【与在场者的关系】 ───────────────────────────────────────────────
console.log('\n=== 2. 【与在场者的关系】 ===');
{
  const text = renderRelationsSection([
    {
      userId: '789', stage: 'acquaintance', trust: 45, warmth: 50,
      nickname: '', names: ['阿七'], knownFor: [], tender: [], openLoops: [], confidence: 0.6
    },
    {
      userId: '456', stage: 'familiar', trust: 62, warmth: 70,
      nickname: '王哥', names: ['小王'], knownFor: ['做后端', '爱喝美式'],
      tender: ['别问裁员的事'], openLoops: [{ text: '问他后来怎么样了' }], confidence: 0.8
    }
  ]);
  check(text.startsWith('【与在场者的关系】'), '有段头');
  const lines = text.split('\n');
  const i456 = text.indexOf('QQ:456');
  const i789 = text.indexOf('QQ:789');
  check(i456 > 0 && i789 > 0 && i456 < i789, '按 userId 升序渲染（与传入顺序无关）');
  check(text.includes('王哥(QQ:456)：熟人'), '阶段用中文说法');
  check(text.includes('信任 62'), '带信任度');
  check(text.includes('你称呼「王哥」'), '带她的称呼');
  check(text.includes('你知道的：做后端；爱喝美式'), '带稳定事实');
  check(text.includes('别提：别问裁员的事'), '带雷点');
  check(text.includes('还没问完：问他后来怎么样了'), '带未完结事项');
  check(!FORBIDDEN.some((w) => text.includes(w)), '不含扮演类词汇');

  const low = renderRelationsSection([
    { userId: '456', stage: 'close', trust: 90, confidence: 0.2, names: ['小王'] }
  ]);
  check(low.includes('印象还有些模糊'), '低置信只给模糊印象');
  check(!low.includes('亲近') && !low.includes('信任 90'), '低置信不做强陈述（不显示阶段与信任度）');

  check(renderRelationsSection([]) === '', '空数组返回空串');
  check(renderRelationsSection(null) === '', 'null 返回空串');
}

// ── 3. 【最近想起的事】 ─────────────────────────────────────────────────
console.log('\n=== 3. 【最近想起的事】 ===');
{
  const fixed = new Date(2026, 9, 24, 10, 30).getTime();
  const text = renderRecentSection([
    { id: 'e_1', ts: fixed, text: '他说被裁员了' }
  ]);
  check(text.startsWith('【最近想起的事】'), '有段头');
  check(text.includes('不是你这次要说的话'), '明确"不是要说的话"（防止照着念）');
  check(/- 10-24 10:30 他说被裁员了/.test(text), '条目格式正确');
  check(!text.includes('#'), '不带消息 id（这不是可引用记录）');
  check(!FORBIDDEN.some((w) => text.includes(w)), '不含扮演类词汇');
  check(renderRecentSection([]) === '', '空数组返回空串');
}

// ── 4. 指纹 ─────────────────────────────────────────────────────────────
console.log('\n=== 4. 指纹：只收稳定簇 ===');
{
  const self = { version: 2 };
  const rels = [
    { userId: '456', stage: 'familiar', trust: 62, warmth: 70, nickname: '王哥', confidence: 0.8 },
    { userId: '789', stage: 'stranger', trust: 50, warmth: 50, nickname: '', confidence: 0.3 }
  ];
  const f1 = mindFingerprint({ self, relations: rels });
  const f2 = mindFingerprint({ self, relations: [...rels].reverse() });
  check(f1 === f2, '关系顺序不影响指纹（排序后再序列化）');

  const f3 = mindFingerprint({ self: { version: 3 }, relations: rels });
  check(f1 !== f3, '自我版本变了指纹就变');

  const f4 = mindFingerprint({ self, relations: [{ ...rels[0], stage: 'close' }, rels[1]] });
  check(f1 !== f4, '关系阶段变了指纹就变');

  check(mindFingerprint({ self: { version: 1 }, relations: [] }) !== f1, '关系清空后指纹不同');
}

// ── 5. 采集 ─────────────────────────────────────────────────────────────
console.log('\n=== 5. 采集（唯一的 IO 函数）===');
{
  const storeRoot = fs.mkdtempSync(path.join(dataDir, 'collect-'));
  const store = new MindStore({ root: storeRoot, getOptions: () => ({}) });
  store.reviseSelf({ narrative: '我是小鲸鱼。' }, { reason: '初始化' });
  store.patchRelation('456', { stage: 'familiar', nickname: '王哥' }, { evidence: ['e_seed'] });
  store.appendEvent({ chatKey: 'private:456', actorId: '456', text: '他说被裁员了', salience: 0.9 });
  store.appendEvent({ chatKey: 'private:456', actorId: '456', text: '无关紧要的一句', salience: 0.05 });

  const ctx = collectMindContext({
    store, chatKey: 'private:456', options: { autoEventsInPrompt: 3, minEventSalience: 0.2 },
    participantIds: ['456'], now: Date.now()
  });
  check(ctx && ctx.enabled === true, '返回启用状态的上下文');
  check(ctx.self.version === 1, '带自我');
  check(ctx.relations.length === 1 && ctx.relations[0].userId === '456', '带在场者关系');
  check(ctx.events.length === 1 && ctx.events[0].text.includes('裁员'), '低显著度事件被过滤');
  check(typeof ctx.fingerprint === 'string' && ctx.fingerprint.length > 0, '带指纹');

  const empty = collectMindContext({ store: null, chatKey: 'private:456' });
  check(empty === null, '没有 store 时返回 null（调用方不插段）');
}

// ── 6. 逐字节等价（关闭时不插段）────────────────────────────────────────
console.log('\n=== 6. 关闭时提示词逐字节不变 ===');
{
  // 给一点历史与记忆，让【记忆】【已读信息】真的出现，才能验证相对顺序
  const oldTs = new Date(2026, 9, 23, 21, 0).getTime();
  const store = {
    recent: () => [
      { id: 1, mid: 900, ts: oldTs, senderId: '456', senderName: '小王', text: '昨天那句', self: false, read: true, media: [] }
    ]
  };
  const memory = { formatForPrompt: () => '【对群友的印象】\n- 小王：爱喝美式' };
  const base = {
    chatKey: 'private:456',
    triggerEntries: [{ id: 2, ts: new Date(2026, 9, 24, 10, 30).getTime(), senderId: '456', senderName: '小王', text: '在吗', self: false }],
    store, memory, stickerEntries: [], selfNickname: '小鲸鱼',
    contextLimit: 10, promptAnchor: { prev: null }, session: {}
  };
  // 【当前时间】精确到秒，两次调用可能跨秒；比较时剔除它，其余必须完全一致
  const strip = (s) => String(s).replace(/【当前时间】[^\n]*/g, '【当前时间】<t>');

  const a = strip(buildUserPrompt({ ...base }));
  const b = strip(buildUserPrompt({ ...base, mind: { enabled: false } }));
  const c = strip(buildUserPrompt({ ...base, mind: null }));
  check(a === b, 'mind.enabled=false 与不传 mind 完全一致');
  check(a === c, 'mind=null 与不传 mind 完全一致');
  check(!a.includes('【关于我自己】'), '关闭时没有心智段');

  const MIND = {
    enabled: true,
    self: { version: 1, narrative: '我是小鲸鱼。', mood: { label: '有点烦' }, preoccupations: [] },
    relations: [{ userId: '456', stage: 'familiar', trust: 62, nickname: '王哥', confidence: 0.8 }],
    events: [{ id: 'e_1', ts: new Date(2026, 9, 20, 9, 0).getTime(), text: '他说被裁员了' }],
    // 真实链路里由 collectMindContext 生成（取决于作息配置）
    rhythm: '我暂时不睡，什么时候都在。'
  };

  // 自我与关系在 system 的 self 层（身份归身份）
  const sysOff = buildSystemPrompt({});
  const sysOn = buildSystemPrompt({ mind: MIND });
  check(!sysOff.includes('【关于我自己】'), '关闭时 system 里没有自我段');
  check(sysOn.includes('【关于我自己】') && sysOn.includes('【与在场者的关系】'), '启用时 system 里有两段');
  // 她必须知道自己的作息：否则夜里引擎拦住消息，她在对话里毫不知情
  check(sysOn.includes('【我的日常】'), '启用时 system 里有【我的日常】');
  check(sysOn.includes('我暂时不睡'), '未开启作息时明确告诉她"不睡"');
  check(sysOn.indexOf('【关于我自己】') > sysOn.indexOf('你是「'), '自我段在身份句之后');
  check(sysOn.indexOf('【关于我自己】') > sysOn.indexOf('【安全规则】') || !sysOn.includes('【安全规则】'),
    '自我段在安全规则之后');

  // user 只保留情景（最近想起的事）
  const on = strip(buildUserPrompt({ ...base, mind: MIND }));
  check(on.includes('【最近想起的事】'), '启用时 user 里有回忆段');
  check(!on.includes('【关于我自己】'), '自我段不再出现在 user 里');
  // 旧印象（memberImpression）由关系档案接管：心智开启时不再渲染，
  // 否则同一件事会有两份互相矛盾的说法；关闭时保持原样。
  check(!on.includes('【对群友的印象】'), '心智开启时不渲染旧印象');
  check(a.includes('【对群友的印象】'), '心智关闭时旧印象照旧');
  check(!on.includes('【记忆】\n'), '心智开启时不再有旧【记忆】段');
  check(a.includes('【记忆】\n'), '心智关闭时仍有【记忆】段');

  // 用"段头 + 紧随其后的正文"定位，避免命中【引导说明】里对段名的引用
  const at = (marker) => on.indexOf(marker);
  const iRead = at('【已读信息】以下');
  const iRecent = at('【最近想起的事】');
  const iUnread = at('【未读信息】以下');
  check(iRead > 0, '夹具确实产生了【已读信息】');
  check(iRead < iRecent && iRecent < iUnread, '最近想起的事在已读之后、未读之前（易变区）');
}

// ── 7. 回忆不重复已读窗口 ───────────────────────────────────────────────
console.log('\n=== 7. 只回忆已读窗口之外的事（避免同一件事说两遍）===');
{
  const msgs = [
    { id: 11, mid: 901, ts: new Date(2026, 9, 23, 20, 0).getTime(), senderId: '456', senderName: '小王', text: '窗口内的一条', self: false, read: true, media: [] },
    { id: 12, mid: 902, ts: new Date(2026, 9, 23, 21, 0).getTime(), senderId: '456', senderName: '小王', text: '窗口内的另一条', self: false, read: true, media: [] }
  ];
  const store = { recent: () => msgs };
  const memory = { formatForPrompt: () => '' };
  const oldTs = new Date(2026, 9, 18, 10, 0).getTime();   // 窗口之外
  const insideTs = new Date(2026, 9, 23, 20, 30).getTime(); // 落在窗口内
  const text = buildUserPrompt({
    chatKey: 'private:456',
    triggerEntries: [{ id: 21, ts: new Date(2026, 9, 24, 10, 30).getTime(), senderId: '456', senderName: '小王', text: '在吗', self: false, media: [] }],
    store, memory, stickerEntries: [], selfNickname: '小鲸鱼',
    contextLimit: 10, promptAnchor: { prev: null }, session: {},
    mind: {
      enabled: true,
      self: null,
      relations: [],
      events: [
        { id: 'e_old', ts: oldTs, text: '很久以前那件事' },
        { id: 'e_inside', ts: insideTs, text: '已经在已读里出现过的事' }
      ]
    }
  });
  check(text.includes('很久以前那件事'), '窗口外的事件仍会被回忆');
  check(!text.includes('已经在已读里出现过的事'), '窗口内的事件被过滤，不再重复');
}

console.log(`\n心智注入：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
