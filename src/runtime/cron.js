// cron 表达式：五段（分 时 日 月 周），够用且不引入依赖。
//
// 为什么自己写而不是装库：只需要"下一次什么时候"，不需要调度线程、时区库、
// 也不需要在 Windows 上拉起子进程。三十行能解决的问题，装一个依赖会让升级更麻烦。
//
// 支持：`*`、数字、区间 `a-b`、列表 `a,b,c`、步长 `*/n` 与 `a-b/n`。
// 周：0-6（周日=0），也接受 7=周日（很多 crontab 这么写）。
// 不支持：秒级、时区名、"@"缩写。这些一旦需要，应该显式扩，而不是猜。

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }
];

/**
 * 解析一个字段成允许值集合。
 * @returns {Set<number>|null} 非法返回 null
 */
function parseField(raw, { min, max }) {
  const set = new Set();
  for (const part of String(raw).split(',')) {
    const text = part.trim();
    if (!text) return null;

    // 步长：*/n 或 a-b/n
    const [rangePart, stepPart] = text.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo; let hi;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = Math.min(a, b); hi = Math.max(a, b);
    } else {
      // 单值 + 步长没有意义（`5/2` 在 crontab 里等价于 `5`），按单值处理
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      lo = n; hi = stepPart === undefined ? n : max;
    }
    // dow 允许 7 当周日
    if (max === 6 && (lo === 7 || hi === 7)) { set.add(0); lo = Math.min(lo, 6); hi = Math.min(hi, 6); }
    if (lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set.size ? set : null;
}

/**
 * 解析表达式。
 * @param {string} expr
 * @returns {{ok:true, fields:{minute:Set,hour:Set,dayOfMonth:Set,month:Set,dayOfWeek:Set}}|{ok:false, reason:string}}
 */
export function parseCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  if (parts.length !== 5) return { ok: false, reason: 'cron 需要五段：分 时 日 月 周' };
  const fields = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    const set = parseField(parts[i], f);
    if (!set) return { ok: false, reason: `第 ${i + 1} 段（${f.name}）非法：${parts[i]}` };
    fields[f.name] = set;
  }
  return { ok: true, fields };
}

/**
 * 下一次触发时间（严格晚于 after）。
 *
 * 实现是"按天跳、按小时/分钟找"：最多看 366 天，每天只在匹配的小时/分钟里找。
 * 比逐分钟扫描快几个数量级，也不需要在依赖里塞一个时区库（本地时间即可）。
 *
 * @param {string} expr
 * @param {number} after
 * @returns {number|null} 时间戳；非法或 366 天内不会触发则 null
 */
export function nextCronAt(expr, after = Date.now()) {
  const parsed = typeof expr === 'object' ? expr : parseCron(expr);
  if (!parsed?.ok) return null;
  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed.fields;

  const start = new Date(Number(after) || Date.now());
  const base = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();

  for (let d = 0; d <= 366; d++) {
    const day = new Date(base + d * 86400000);
    if (!month.has(day.getMonth() + 1)) continue;
    if (!dayOfMonth.has(day.getDate())) continue;
    if (!dayOfWeek.has(day.getDay())) continue;

    for (const h of [...hour].sort((a, b) => a - b)) {
      for (const m of [...minute].sort((a, b) => a - b)) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
        if (at > Number(after)) return at;
      }
    }
  }
  return null;
}

/**
 * 人话描述（界面与日志用）。不追求覆盖所有组合，只把常见写法说清。
 * @param {string} expr
 */
export function describeCron(expr) {
  const parsed = parseCron(expr);
  if (!parsed.ok) return `无效表达式（${parsed.reason}）`;
  const { minute, hour, dayOfMonth, month, dayOfWeek } = parsed.fields;
  const everyMinute = minute.size === 60;
  const oneHour = hour.size === 1 ? [...hour][0] : null;
  const oneMinute = minute.size === 1 ? [...minute][0] : null;

  if (everyMinute && hour.size === 24 && dayOfMonth.size === 31 && month.size === 12 && dayOfWeek.size === 7) {
    return '每分钟';
  }
  if (oneHour !== null && oneMinute !== null && dayOfMonth.size === 31 && month.size === 12 && dayOfWeek.size === 7) {
    return `每天 ${String(oneHour).padStart(2, '0')}:${String(oneMinute).padStart(2, '0')}`;
  }
  if (oneHour !== null && oneMinute !== null && dayOfWeek.size === 1) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${names[[...dayOfWeek][0]]} ${String(oneHour).padStart(2, '0')}:${String(oneMinute).padStart(2, '0')}`;
  }
  if (oneHour !== null && oneMinute !== null && dayOfMonth.size === 1) {
    return `每月 ${[...dayOfMonth][0]} 日 ${String(oneHour).padStart(2, '0')}:${String(oneMinute).padStart(2, '0')}`;
  }
  if (oneHour !== null && minute.size === 60) return `每小时（${String(oneHour).padStart(2, '0')} 点这一小时里每分钟）`;
  return `${expr}（${parsed.fields.minute.size} 个分钟点 / ${parsed.fields.hour.size} 个小时点）`;
}
