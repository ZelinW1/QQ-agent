// 备份：导出 / 导入她的数据。
//
// 两类包，边界是刻意的：
//   her  —— 只装"她自己"：mind 目录（自我/关系/事件/节律/反思）+ persona 子集。
//           换机器导入后，她还是原来那个人。
//   full —— 加上聊天记录、会话留档、表情、用量。
//           **仍然不包含 config.json**：每台机器的设置各自配置，
//           尤其不能把 API Key 打进包里（那是最典型的一次泄露事故）。
//
// 导入前一定先给当前数据打一个包（backups/<时间戳>.zip），
// 这样"导入错了"永远有后悔药。
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const BACKUP_DIR = 'backups';
const MAX_TOTAL = 512 * 1024 * 1024;   // 解压后总量上限（防 zip 炸弹）

// ── zip 写入（无外部依赖）───────────────────────────────────────────────

function crc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
}
const CRC_TABLE = crc32Table();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 打一个 zip。
 * @param {{name:string, data:Buffer}[]} entries
 * @returns {Buffer}
 */
export function createZip(entries = []) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const compressed = deflateRawSync(data, { level: 6 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, payload);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0, 8);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/** 读 zip：返回 [{name, data}]。拒绝路径穿越与超限。 */
export function readZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('不是有效的备份文件');
  const sig = (off) => buffer.readUInt32LE(off);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的备份文件（找不到中央目录）');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (sig(ptr) !== 0x02014b50) throw new Error('备份文件损坏（中央目录异常）');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) {
      throw new Error(`备份包含非法路径：${name}`);
    }
    const lNameLen = buffer.readUInt16LE(localOff + 26);
    const lExtraLen = buffer.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    total += data.length;
    if (total > MAX_TOTAL) throw new Error('备份解压后过大，已拒绝');
    out.push({ name, data });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ── 打包内容 ────────────────────────────────────────────────────────────

function walkFiles(root, rel = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return out; }
  for (const name of names) {
    const fp = path.join(root, name);
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    const r = rel ? `${rel}/${name}` : name;
    if (st.isDirectory()) out.push(...walkFiles(fp, r));
    else out.push({ name: r, data: fs.readFileSync(fp) });
  }
  return out;
}

/** persona 子集：属于"她"的部分，而不是机器设置。 */
export function personaSubset(cfg = {}) {
  const p = cfg.persona || {};
  return {
    botName: p.botName ?? '',
    selfNickname: p.selfNickname ?? '',
    roleText: p.roleText ?? '',
    participation: p.participation ?? 'medium',
    charter: p.charter ?? null,
    memberNotes: cfg.memberNotes ?? {}
  };
}

const FULL_DIRS = ['mind', 'messages', 'memory', 'sessions', 'sticker-images', 'usage-days'];
const FULL_FILES = ['usage-daily.json', 'stickers.json'];

/**
 * 生成备份包。
 * @param {object} p
 * @param {string} p.dataDir
 * @param {object} p.config 当前配置（取 persona 子集）
 * @param {'her'|'full'} [p.kind]
 * @param {string} [p.appVersion]
 * @returns {{buffer:Buffer, files:number, bytes:number, kind:string}}
 */
export function buildBackup({ dataDir, config = {}, kind = 'her', appVersion = '' } = {}) {
  const entries = [];
  const dirs = kind === 'full' ? FULL_DIRS : ['mind'];
  for (const dir of dirs) {
    const abs = path.join(dataDir, dir);
    for (const f of walkFiles(abs)) entries.push({ name: `${dir}/${f.name}`, data: f.data });
  }
  if (kind === 'full') {
    for (const f of FULL_FILES) {
      const fp = path.join(dataDir, f);
      try { if (fs.statSync(fp).isFile()) entries.push({ name: f, data: fs.readFileSync(fp) }); } catch { /* 没有就算了 */ }
    }
  }
  const manifest = {
    format: 'qq-agent-backup',
    version: 1,
    kind,
    createdAt: Date.now(),
    appVersion: String(appVersion || ''),
    // 明确记录"故意不含什么"，避免以后有人以为漏了
    excludes: ['config.json（含 API Key 与各机设置）', 'logs', 'video-cache']
  };
  entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
  entries.push({ name: 'persona.json', data: Buffer.from(JSON.stringify(personaSubset(config), null, 2), 'utf8') });

  const buffer = createZip(entries);
  return { buffer, files: entries.length, bytes: buffer.length, kind };
}

/** 读备份的 manifest（不落盘）。 */
export function inspectBackup(buffer) {
  const entries = readZip(buffer);
  const man = entries.find((e) => e.name === 'manifest.json');
  if (!man) throw new Error('这不是 QQ Agent 的备份包（缺少 manifest）');
  let manifest;
  try { manifest = JSON.parse(man.data.toString('utf8')); } catch { throw new Error('备份额清单损坏'); }
  if (manifest.format !== 'qq-agent-backup') throw new Error('备份格式不匹配');
  const persona = entries.find((e) => e.name === 'persona.json');
  let personaData = null;
  if (persona) { try { personaData = JSON.parse(persona.data.toString('utf8')); } catch { /* 忽略 */ } }
  return { manifest, persona: personaData, entries };
}

/** 把当前数据打一个包放到 backups/ 下（导入前的后悔药）。 */
export function backupBeforeImport({ dataDir, config = {}, appVersion = '' } = {}) {
  const dir = path.join(dataDir, BACKUP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `pre-import-${stamp}.zip`;
  // 导入口的后悔药一律用完整包（设置不在里面，但数据要全）
  const { buffer } = buildBackup({ dataDir, config, kind: 'full', appVersion });
  fs.writeFileSync(path.join(dir, name), buffer);
  return { name, path: path.join(dir, name), bytes: buffer.length };
}

/**
 * 还原备份（由调用方负责先做 backupBeforeImport）。
 *
 * 只还原白名单内的目录，绝不写 config.json —— 包里根本没有它。
 *
 * @returns {{restored:number, dirs:string[], kind:string}}
 */
export function restoreBackup({ dataDir, entries = [], manifest = {} }) {
  const allowed = new Set(FULL_DIRS);
  const dirs = new Set();
  let restored = 0;
  for (const e of entries) {
    if (e.name === 'manifest.json' || e.name === 'persona.json') continue;
    const top = e.name.split('/')[0];
    if (!allowed.has(top)) continue;          // 白名单外的条目一律忽略
    const dest = path.join(dataDir, ...e.name.split('/'));
    const rel = path.relative(dataDir, dest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, e.data);
    restored += 1;
    dirs.add(top);
  }
  return { restored, dirs: [...dirs], kind: String(manifest.kind || '') };
}
