// 备份模块自测：zip 读写、两类包的内容边界、还原白名单。
//
// 守的是安全边界：
//   · 任何包里都不能出现 config.json（API Key 就是从这里漏出去的）
//   · 还原时白名单外的东西一律不写（哪怕包里被人塞了）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => pathToFileURL(path.join(ROOT, rel)).href;
const { createZip, readZip, buildBackup, inspectBackup, restoreBackup, backupBeforeImport, personaSubset } = await import(src('src/backup.js'));

let pass = 0; let fail = 0;
const check = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); if (detail) console.log('      ' + detail); }
};

const mkData = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-src-'));
  fs.mkdirSync(path.join(dir, 'mind'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'mind', 'self.json'), JSON.stringify({ version: 2, narrative: '我是小鲸鱼' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'mind', 'tick.json'), JSON.stringify({ energy: 80 }), 'utf8');
  fs.writeFileSync(path.join(dir, 'messages', 'private_777.json'), JSON.stringify({ messages: [] }), 'utf8');
  fs.writeFileSync(path.join(dir, 'logs', 'app.log'), 'secret-ish log', 'utf8');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ api: { apiKey: 'sk-should-never-leak' } }), 'utf8');
  return dir;
};

const cfg = {
  persona: {
    botName: '小鲸鱼',
    charter: { selfImage: '我叫{botName}', baseline: '话少', hardRules: ['不当客服'] },
    participation: 'medium'
  },
  memberNotes: { 777: '王哥' }
};

// ── 1. zip 读写 ─────────────────────────────────────────────────────────
console.log('\n=== 1. zip 读写 ===');
{
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello', 'utf8') },
    { name: 'dir/中文.json', data: Buffer.from('{"x":1}', 'utf8') },
    { name: 'big.txt', data: Buffer.from('x'.repeat(5000), 'utf8') }
  ];
  const zip = createZip(entries);
  const back = readZip(zip);
  check(back.length === 3, '条目数一致');
  check(back.find((e) => e.name === 'a.txt').data.toString() === 'hello', '内容一致');
  check(back.find((e) => e.name === 'dir/中文.json').data.toString() === '{"x":1}', '中文路径与内容正常');
  check(back.find((e) => e.name === 'big.txt').data.length === 5000, '大文件（deflate）正常');
}

// ── 2. 「她自己」包的边界 ───────────────────────────────────────────────
console.log('\n=== 2. her 包 ===');
{
  const dir = mkData();
  const { buffer, kind } = buildBackup({ dataDir: dir, config: cfg, kind: 'her' });
  const names = readZip(buffer).map((e) => e.name);
  check(kind === 'her', 'kind=her');
  check(names.includes('mind/self.json') && names.includes('mind/tick.json'), '含她的心智数据');
  check(names.includes('persona.json') && names.includes('manifest.json'), '含人设与清单');
  check(!names.some((n) => n.includes('config.json')), '**不含 config.json**');
  check(!names.some((n) => n.startsWith('messages/')), 'her 包不含聊天记录');
  check(!names.some((n) => n.startsWith('logs/')), 'her 包不含日志');

  const { manifest, persona } = inspectBackup(buffer);
  check(manifest.kind === 'her' && manifest.format === 'qq-agent-backup', '清单可读');
  check(persona.botName === '小鲸鱼' && persona.charter.selfImage === '我叫{botName}', '人设子集完整');
  check(persona.memberNotes['777'] === '王哥', '群友备注跟着她走');
}

// ── 3. full 包 ──────────────────────────────────────────────────────────
console.log('\n=== 3. full 包 ===');
{
  const dir = mkData();
  const { buffer } = buildBackup({ dataDir: dir, config: cfg, kind: 'full' });
  const names = readZip(buffer).map((e) => e.name);
  check(names.includes('messages/private_777.json'), '含聊天记录');
  check(names.includes('mind/self.json'), '也含心智数据');
  check(!names.some((n) => n.includes('config.json')), '**仍不含 config.json**');
  check(!names.some((n) => n.startsWith('logs/')), '不含日志');
}

// ── 4. 还原白名单 ───────────────────────────────────────────────────────
console.log('\n=== 4. 还原白名单 ===');
{
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-dst-'));
  const entries = [
    { name: 'mind/self.json', data: Buffer.from('{"version":9}') },
    { name: 'messages/x.json', data: Buffer.from('{"messages":[]}') },
    // 恶意/异常条目：全部应被忽略
    { name: 'config.json', data: Buffer.from('{"api":{"apiKey":"pwned"}}') },
    { name: 'logs/app.log', data: Buffer.from('x') },
    { name: 'manifest.json', data: Buffer.from('{}') },
    { name: 'persona.json', data: Buffer.from('{}') }
  ];
  const r = restoreBackup({ dataDir: dest, entries, manifest: { kind: 'full' } });
  check(r.restored === 2, `只还原白名单内的（${r.restored}）`);
  check(fs.existsSync(path.join(dest, 'mind', 'self.json')), '心智数据已写入');
  check(!fs.existsSync(path.join(dest, 'config.json')), '**config.json 没有被写**');
  check(!fs.existsSync(path.join(dest, 'logs', 'app.log')), '日志没有被写');
}

// ── 5. 导入前的后悔药 ───────────────────────────────────────────────────
console.log('\n=== 5. 导入前备份 ===');
{
  const dir = mkData();
  const r = backupBeforeImport({ dataDir: dir, config: cfg });
  check(fs.existsSync(r.path), '备份文件已生成');
  check(path.dirname(r.path).endsWith('backups'), '落在 backups/ 目录');
  check(fs.readFileSync(r.path).length > 100, '文件非空');
}

// ── 6. persona 子集不夹带设置 ───────────────────────────────────────────
console.log('\n=== 6. persona 子集 ===');
{
  const p = personaSubset({ persona: { botName: 'X', apiKey: 'sk-xxx' }, api: { apiKey: 'sk-yyy' } });
  check(!('apiKey' in p) && JSON.stringify(p).indexOf('sk-') === -1, '不会把密钥带进人设');
}

console.log(`\n备份：通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
