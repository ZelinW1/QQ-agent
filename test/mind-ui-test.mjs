// 心智页渲染自测。
//
// 为什么要"真跑一遍"：`node --check` 只查语法，查不出 "B 未定义" 这类运行时错误，
// 也查不出 innerHTML 拼接漏了转义。这个测试把 ui/app/13-mind.js 放进 vm 执行，
// 用假的 DOM 和假的 api，断言渲染结果与转义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { bootApp } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-ui-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const code = fs.readFileSync(path.join(ROOT, 'ui/app/13-mind.js'), 'utf8');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 假 DOM：按 id 造元素，记住 value/innerHTML 与 click 处理器。 */
function makeSandbox(stateData, extraApi = null) {
  const els = new Map();
  const handlers = new Map();
  const ensure = (sel) => {
    if (!els.has(sel)) {
      const el = {
        id: sel.replace(/^#/, ''),
        value: '', innerHTML: '', textContent: '', disabled: false, dataset: {},
        addEventListener(ev, fn) { handlers.set(`${sel}:${ev}`, fn); },
        click() { handlers.get(`${sel}:click`)?.(); },
        querySelectorAll() { return []; }
      };
      els.set(sel, el);
    }
    return els.get(sel);
  };
  const box = ensure('#mind-page');
  const calls = [];
  const sandbox = {
    console,
    $: (sel) => (String(sel).startsWith('#') ? ensure(sel) : null),
    esc,
    fmtTime: () => '10-25 13:00',
    api: async (p, opts) => {
      calls.push({ path: p, opts });
      if (p === '/api/mind/state') return stateData;
      if (extraApi) { const r = extraApi(p, opts); if (r) return r; }
      return { ok: true };
    }
  };
  vm.createContext(sandbox);
  new vm.Script(code, { filename: '13-mind.js' }).runInContext(sandbox);
  return { sandbox, box, calls, el: ensure };
}

const STATE = {
  ok: true,
  available: true,
  enabled: true,
  scope: 'private',
  mode: 'charter',
  charter: {
    selfImage: '我叫{botName}，蓝头发。',
    baseline: '我一开始话少。',
    scenario: { private: '一对一，两条以内。', group: '群里一句话。' },
    voice: ['句尾很少用句号', '被夸会先否认一句'],
    hardRules: ['不当客服', '不用 markdown']
  },
  charterResolved: {
    selfImage: '我叫小鲸鱼，蓝头发。',
    baseline: '我一开始话少。',
    scenario: { private: '一对一，两条以内。', group: '群里一句话。' },
    voice: ['句尾很少用句号', '被夸会先否认一句'],
    hardRules: ['不当客服', '不用 markdown']
  },
  roleTextChars: 0,
  botName: '小鲸鱼',
  self: { version: 3, narrative: '我是小鲸鱼。最近对熟人话多。', mood: { label: '有点闷', valence: -0.3 }, preoccupations: ['想问裁员的事'], updatedAt: Date.now() },
  relations: [{
    userId: '777', names: ['小王'], nickname: '王哥', stage: 'familiar',
    trust: 62, warmth: 70, knownFor: ['做后端'], tender: ['别问裁员'],
    openLoops: ['他后来怎么样了'], recentSummary: '聊到裁员', confidence: 0.8, updatedAt: Date.now()
  }],
  tick: {
    energy: 77, today: '2026-10-25', todayProactive: 1, todayDecisions: 3,
    todayReflections: 1, lastReflectAt: Date.now(), lastReflectAttemptAt: Date.now(),
    sleep: { state: 'awake', stayUps: 0, nightKey: '' }
  },
  sleep: {
    enabled: false, asleep: false, window: null,
    config: { startHour: 23, startMinute: 30, endHour: 8, endMinute: 0, jitterMin: 40, maxStayUp: 2, graceMs: 900000 }
  },
  counts: { events: 5, uncompacted: 4, relations: 1, reflections: 1 },
  recentReflections: [{ at: Date.now(), ok: true, empty: false, produced: { self: true, relations: [{ userId: '777' }], compacted: 2 }, rejected: 0 }],
  recentActions: []
};

// ── 1. 正常渲染 ─────────────────────────────────────────────────────────
console.log('\n=== 1. 正常渲染 ===');
const { sandbox, box, calls } = makeSandbox(STATE);
await sandbox.loadMindPage();
{
  const html = box.innerHTML;
  check(html.length > 500, '渲染出内容');
  check(calls.some((c) => c.path === '/api/mind/state'), '请求了状态接口');
  check(html.includes('我是谁') && html.includes('我叫小鲸鱼'), '身份槽位');
  check(html.includes('我说话的样子') && html.includes('句尾很少用句号'), '说话习惯');
  check(html.includes('不当客服'), '硬规矩');
  check(html.includes('王哥'), '关系：nickname');
  check(html.includes('做后端'), '关系：已有认知');
  check(html.includes('别问裁员'), '关系：雷点');
  check(html.includes('体力'), '节律：体力');
  check(html.includes('77'), '节律：体力数值');
  check(html.includes('最近反思'), '反思卡');
  check(html.includes('压缩 2 条'), '反思产出摘要');
  check(html.includes('开关与作息') && html.includes('mind-sleep-start'), '开关与作息卡');
  check(html.includes('23:30'), '入睡时间用配置值填充');
}

// ── 2. 转义（防注入）───────────────────────────────────────────────────
console.log('\n=== 2. 转义 ===');
{
  const evil = JSON.parse(JSON.stringify(STATE));
  evil.self.narrative = '<img src=x onerror=alert(1)>';
  evil.relations[0].nickname = '<script>bad()</script>';
  const { sandbox: s2, box: b2 } = makeSandbox(evil);
  await s2.loadMindPage();
  check(!b2.innerHTML.includes('<img src=x'), '叙事里的 HTML 被转义');
  check(!b2.innerHTML.includes('<script>bad()'), '昵称里的脚本被转义');
  check(b2.innerHTML.includes('&lt;img'), '能看到转义后的文本');
}

// ── 3. roleText 模式与不可用 ───────────────────────────────────────────
console.log('\n=== 3. 边界状态 ===');
{
  const legacy = JSON.parse(JSON.stringify(STATE));
  legacy.mode = 'roleText';
  legacy.roleTextChars = 6148;
  const { sandbox: s3, box: b3 } = makeSandbox(legacy);
  await s3.loadMindPage();
  check(b3.innerHTML.includes('整段角色卡'), 'roleText 模式说明');
  check(b3.innerHTML.includes('6148'), '显示角色卡字符数');
  check(!b3.innerHTML.includes('我叫小鲸鱼'), 'roleText 模式下不显示槽位内容');

  const off = { ok: true, available: false, enabled: false, reason: '心智存储未接入' };
  const { sandbox: s4, box: b4 } = makeSandbox(off);
  await s4.loadMindPage();
  check(b4.innerHTML.includes('心智尚未接入'), '不可用时给出原因');
}

// ── 4. 保存流程 ────────────────────────────────────────────────────────
console.log('\n=== 4. 保存 ===');
{
  const { sandbox: s5, calls: c5 } = makeSandbox(STATE);
  // 直接调保存：表单元素不存在时 val() 返回空串，应当仍能发出请求
  await s5.saveMindCharter();
  const save = c5.find((c) => c.path === '/api/config');
  check(Boolean(save), '保存请求发到了 /api/config');
  check(save.opts.method === 'POST', '用 POST');
  const body = JSON.parse(save.opts.body);
  check(body.persona && body.persona.charter, '载荷在 persona.charter 下');
  check(Array.isArray(body.persona.charter.hardRules), 'hardRules 是数组');
  check(body.persona.charter.scenario && 'private' in body.persona.charter.scenario, 'scenario 分场合');
}

// ── 5. 静态接线 ────────────────────────────────────────────────────────
console.log('\n=== 5. 接线 ===');
{
  const html = fs.readFileSync(path.join(ROOT, 'ui/index.html'), 'utf8');
  check(html.includes('data-tab="mind"'), 'index.html 有「心智」页签');
  check(html.includes('id="view-mind"'), 'index.html 有对应视图');
  check(html.includes('/app/13-mind.js'), 'index.html 加载了 13-mind.js');

  const core = fs.readFileSync(path.join(ROOT, 'ui/app/00-core.js'), 'utf8');
  check(/if \(name === 'mind'\) loadMindPage\(\);/.test(core), 'switchTab 会加载心智页');

  const css = fs.readFileSync(path.join(ROOT, 'ui/style.css'), 'utf8');
  check(css.includes('.mind-wrap') && css.includes('.mind-rel'), '样式已定义');
}

// ── 6. 真实服务：脚本能被浏览器取到 ────────────────────────────────────
console.log('\n=== 6. 静态服务 ===');
{
  const env = await bootApp({ config: { mind: { enabled: true } } });
  const js = await env.request('GET', '/app/13-mind.js');
  check(js.status === 200, `13-mind.js 可访问（HTTP ${js.status}）`);
  check(js.text.includes('loadMindPage'), '返回的是脚本本体');
  const state = await env.request('GET', '/api/mind/state');
  check(state.status === 200 && state.data?.ok === true, '状态接口在真实服务里可用');
  await env.teardown();
}

// ── 7. 出生仪式 ────────────────────────────────────────────────────────
console.log('\n=== 7. 出生仪式 ===');
{
  const DRAFT = {
    name: ['蓝汐', '鲸落'],
    selfImage: '我叫{botName}，蓝色渐变长发，蓝瞳，尾巴是鲸鱼的。',
    baseline: '我还没想清楚自己会成为什么样的人。这些只是起点，以后会变。',
    voice: ['句尾很少用句号']
  };
  const { sandbox: s7, box: b7, calls: c7, el } = makeSandbox(STATE, (p) => (
    p === '/api/mind/charter/draft' ? { ok: true, drafts: [DRAFT] } : null
  ));
  await s7.loadMindPage();
  check(b7.innerHTML.includes('出生仪式'), '页面上有出生仪式入口');

  el('#birth-kw').value = '鲸鱼少女，蓝瞳';
  el('#birth-vision').value = '成为一个会自我成长的伙伴';
  await s7.generateBirthDrafts();

  check(c7.some((c) => c.path === '/api/mind/charter/draft'), '发起了生成请求');
  const gen = c7.find((c) => c.path === '/api/mind/charter/draft');
  const seed = JSON.parse(gen.opts.body).seed;
  check(seed.vision.includes('自我成长'), '愿景随请求带上');
  check(b7.innerHTML.includes('草案 1'), '渲染出草案');
  check(b7.innerHTML.includes('蓝汐'), '渲染候选名字');
  check(b7.innerHTML.includes('蓝色渐变长发'), '渲染自我形象');

  s7.applyBirthDraft(0);
  check(b7.innerHTML.includes('mind-f-self'), '采用后进入编辑表单');
  check(b7.innerHTML.includes('mind-f-name'), '编辑表单可以直接改名字');
  check(b7.innerHTML.includes('我叫{botName}'), '编辑框填入草案文本且保留占位符');
  check(b7.innerHTML.includes('mind-f-voice'), '草案的说话习惯也进了编辑表单');
  check(b7.innerHTML.includes('保存并改名为'), '保存按钮提示会改名（名字必须经确认才换）');
}

console.log(`\n心智页：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
