// 自动化任务的存储与调度（D2）。
//
// 与自由时刻的区别（设计 §8）：
//   · 自由是"她想做"：看体力、看心情、可以不做；
//   · 自动化是"说好了要做"：到点就做，不看 asleep / energy / 决策次数。
// 所以它有自己的调度与自己的额度（并发上限、失败退避），不和 free 抢预算。
//
// 存储用 JSON 文件而不是事件流：任务定义是**配置**，不是她的经历。
// 放 mind/ 里会让"删掉领域就起不来"的边界变模糊；放 runtime/ 才对。
import fs from 'node:fs';
import path from 'node:path';

import { nextCronAt, parseCron } from './cron.js';

/** 连续失败这么多次就自动停用：一直失败的任务只会烧钱。 */
export const MAX_FAILURES = 3;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * @param {object} opts
 * @param {string} opts.dir 数据目录（与 mind 同级）
 */
export function createAutomationStore({ dir } = {}) {
  if (!dir) throw new Error('automation store 需要 dir');
  const file = path.join(dir, 'automations.json');
  const load = () => {
    const raw = readJson(file, { tasks: [] });
    return Array.isArray(raw?.tasks) ? raw : { tasks: [] };
  };
  const save = (data) => writeJsonAtomic(file, data);

  return {
    file,
    list() { return load().tasks; },

    /** 新建任务。cron 非法直接拒绝（不要存进去再等到调度时才炸）。 */
    add(input = {}) {
      const cron = String(input.cron || '').trim();
      const parsed = parseCron(cron);
      if (!parsed.ok) return { ok: false, reason: parsed.reason };
      const action = String(input.action || '').trim();
      if (!action) return { ok: false, reason: '缺少 action' };

      const now = Date.now();
      const task = {
        id: `au_${now}_${Math.random().toString(36).slice(2, 7)}`,
        name: String(input.name || '').slice(0, 60) || cron,
        cron,
        action,
        args: input.args && typeof input.args === 'object' ? input.args : {},
        chatKey: String(input.chatKey || ''),
        enabled: input.enabled !== false,
        createdAt: now,
        lastRunAt: 0,
        lastResult: '',
        failures: 0,
        nextRunAt: nextCronAt(cron, now) || 0
      };
      const data = load();
      data.tasks.push(task);
      save(data);
      return { ok: true, task };
    },

    update(id, patch = {}) {
      const data = load();
      const i = data.tasks.findIndex((t) => t.id === id);
      if (i < 0) return { ok: false, reason: '没有这个任务' };
      const task = { ...data.tasks[i], ...patch, id: data.tasks[i].id };
      if (patch.cron !== undefined) {
        const parsed = parseCron(patch.cron);
        if (!parsed.ok) return { ok: false, reason: parsed.reason };
        task.nextRunAt = nextCronAt(patch.cron, Date.now()) || 0;
      }
      data.tasks[i] = task;
      save(data);
      return { ok: true, task };
    },

    remove(id) {
      const data = load();
      const before = data.tasks.length;
      data.tasks = data.tasks.filter((t) => t.id !== id);
      if (data.tasks.length === before) return { ok: false, reason: '没有这个任务' };
      save(data);
      return { ok: true };
    },

    /**
     * 记一次执行结果。
     *
     * 失败会累加计数并在达到上限时停用；成功清零并把 nextRunAt 推到下一次。
     * 停用不删除：用户要能在界面上看见"它为什么停了"。
     */
    markRun(id, { ok, error = '', at = Date.now() } = {}) {
      const data = load();
      const i = data.tasks.findIndex((t) => t.id === id);
      if (i < 0) return { ok: false, reason: '没有这个任务' };
      const task = { ...data.tasks[i] };
      task.lastRunAt = at;
      task.lastResult = ok ? 'ok' : String(error || 'failed').slice(0, 200);
      task.failures = ok ? 0 : (Number(task.failures) || 0) + 1;
      if (task.failures >= MAX_FAILURES) {
        task.enabled = false;
        task.lastResult = `${task.lastResult}（连续失败 ${task.failures} 次，已停用）`;
      }
      task.nextRunAt = nextCronAt(task.cron, at) || 0;
      data.tasks[i] = task;
      save(data);
      return { ok: true, task };
    }
  };
}

/**
 * 挑出到点该跑的任务。
 *
 * 注意 nextRunAt 缺失（老数据/非法 cron）的任务会被跳过，而不是"立刻跑一次"——
 * 自动化宁可漏一次，也不该在升级后突然把所有任务同时触发。
 */
export function dueTasks(tasks = [], now = Date.now(), limit = 3) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t && t.enabled !== false)
    .filter((t) => Number(t.nextRunAt) > 0 && Number(t.nextRunAt) <= now)
    .sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt))
    .slice(0, Math.max(1, limit));
}
