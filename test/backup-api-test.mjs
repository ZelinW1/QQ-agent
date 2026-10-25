// 备份接口自测：导出 → 破坏 → 导入 → 还原，且不碰本机设置。
//
// ⚠️ 必须先 boot 再 import src 模块（config 在加载时固定 DATA_DIR）。
import fs from 'node:fs';
import path from 'node:path';
import { bootApp } from './_harness.mjs';

const env = await bootApp({ config: { mind: { enabled: true } } });
const { dataDir } = env;
const { readZip } = await import('../src/backup.js');

const pass = [], fail = [];
const check = (cond, msg, detail = '') => {
  if (cond) { pass.push(msg); console.log('  ✓ ' + msg); }
  else { fail.push(msg); console.error(`  ✗ ${msg}${detail ? '\n      ' + detail : ''}`); }
};

const selfFile = path.join(dataDir, 'mind', 'self.json');
fs.mkdirSync(path.join(dataDir, 'mind'), { recursive: true });
fs.writeFileSync(selfFile, JSON.stringify({ version: 42, narrative: '备份前的我' }), 'utf8');
fs.writeFileSync(path.join(dataDir, 'messages-core-test.tmp'), 'x', 'utf8'); // 噪声文件，确保不会被带走

// ── 1. 导出「她自己」 ───────────────────────────────────────────────────
let zipBuf = null;
{
  const res = await fetch(`${env.base}/api/backup/export?kind=her`);
  check(res.status === 200, `导出 200（实际 ${res.status}）`);
  check(String(res.headers.get('content-type')).includes('zip'), 'content-type 是 zip');
  zipBuf = Buffer.from(await res.arrayBuffer());
  check(zipBuf.length > 100, `包非空（${zipBuf.length} B）`);

  const names = readZip(zipBuf).map((e) => e.name);
  check(names.includes('mind/self.json'), '包里有她的自我');
  check(names.includes('manifest.json') && names.includes('persona.json'), '包里有清单与人设');
  check(!names.some((n) => n.includes('config.json')), '包里没有 config.json（无密钥）');
  check(!names.includes('messages-core-test.tmp'), '根目录噪声文件没被带走');
}

// ── 2. 破坏当前数据 ─────────────────────────────────────────────────────
{
  fs.writeFileSync(selfFile, JSON.stringify({ version: 1, narrative: '被覆盖的我' }), 'utf8');
  check(JSON.parse(fs.readFileSync(selfFile, 'utf8')).version === 1, '已破坏为 v1');
}

// ── 3. 导入还原 ─────────────────────────────────────────────────────────
{
  const cfgBefore = await env.request('GET', '/api/config');
  const res = await fetch(`${env.base}/api/backup/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: zipBuf
  });
  const data = await res.json();
  check(res.status === 200 && data.ok === true, `导入成功（${JSON.stringify(data).slice(0, 80)}）`);
  check(Number(data.restored) >= 1, `还原了 ${data.restored} 个文件`);
  check(String(data.preBackup || '').startsWith('pre-import-'), '导入前自动备份');
  check(fs.existsSync(path.join(dataDir, 'backups', data.preBackup)), '后悔药文件确实在磁盘上');

  const back = JSON.parse(fs.readFileSync(selfFile, 'utf8'));
  check(back.version === 42 && back.narrative === '备份前的我', '自我已还原');

  const cfgAfter = await env.request('GET', '/api/config');
  check(JSON.stringify(cfgBefore.data.api) === JSON.stringify(cfgAfter.data.api), '本机 API 设置未被覆盖');
}

// ── 4. 坏包被拒绝 ───────────────────────────────────────────────────────
{
  const res = await fetch(`${env.base}/api/backup/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: Buffer.from('这不是 zip')
  });
  check(res.status === 400, `坏包 → 400（实际 ${res.status}）`);
}

await env.teardown();
console.log(`\n备份接口：通过 ${pass.length}，失败 ${fail.length}`);
if (fail.length) process.exit(1);
