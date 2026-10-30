// 心智数据迁移 CLI（设计 §9.2）。
//
//   npm run mind:migrate -- --from "D:\old\data\mind" --dry-run
//   npm run mind:migrate -- --in-place
//   npm run mind:rollback -- --to "D:\QQ Agent\data\.backup-20261029"
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { migrateMind, rollbackMind } from '../src/mind/migrate.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (flag('help')) {
  console.log([
    '用法：',
    '  npm run mind:migrate -- --from <mind目录> [--data <data目录>] [--dry-run] [--force]',
    '  npm run mind:migrate -- --in-place [--dry-run]',
    '  npm run mind:rollback -- --to <备份目录> [--data <data目录>]'
  ].join('\n'));
  process.exit(0);
}

try {
  if (flag('rollback')) {
    const backup = value('to');
    const dataDir = value('data', path.dirname(backup || DATA_DIR));
    const r = rollbackMind({ dataDir: dataDir || DATA_DIR, backupDir: backup });
    console.log(r.ok ? `已回滚：${r.restoredFrom}\n现场保留在：${r.movedTo}` : `回滚失败：${r.reason}`);
    process.exit(r.ok ? 0 : 1);
  }

  const inPlace = flag('in-place');
  const fromDir = value('from', inPlace ? path.join(DATA_DIR, 'mind') : '');
  if (!fromDir) {
    console.error('缺少 --from（或使用 --in-place）');
    process.exit(2);
  }
  const dataDir = value('data', path.dirname(fromDir));
  const dryRun = flag('dry-run');
  const r = migrateMind({ fromDir, dataDir, apply: !dryRun, force: flag('force') });
  if (!r.ok) {
    console.error(`迁移失败：${r.reason || ''}${r.problems ? `\n- ${r.problems.join('\n- ')}` : ''}`);
    process.exit(1);
  }
  if (r.skipped) {
    console.log(`不需要迁移（已是 v${r.version}）`);
    process.exit(0);
  }
  if (r.dryRun) {
    console.log([
      `预览：v${r.plan.fromVersion} → v${r.plan.toVersion}`,
      `  事件 ${r.plan.counts.events} · 关系 ${r.plan.counts.relations} · 旧行动 ${r.plan.counts.actions}`,
      `  会转成意图：${r.would.intentions} 条；会回填动作统计：${r.would.actionStats} 个`,
      '未写入任何文件（dry-run）。'
    ].join('\n'));
    process.exit(0);
  }
  console.log([
    `迁移完成：v${r.plan.fromVersion} → v${r.plan.toVersion}`,
    `  备份：${r.backupDir}`,
    `  旧目录：${r.oldDir}`,
    `  意图 +${r.derived.intentions}；动作统计 +${r.derived.actionStats}`
  ].join('\n'));
} catch (error) {
  console.error(`迁移异常：${error?.message ?? error}`);
  process.exit(1);
}