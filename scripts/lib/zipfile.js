'use strict';
/**
 * 最小 ZIP 写出器（纯 Node，无外部命令）
 *
 * 为什么不用 Compress-Archive：打包脚本要在 macOS/Linux/CI 上同样能跑，
 * 而 powershell.exe 只在 Windows 存在；顺带省掉一次进程启动开销。
 *
 * 只实现打包需要的能力：deflate 压缩、UTF-8 文件名标志位、中央目录与 EOCD。
 * 不支持加密、ZIP64（超过 4GB 或 65535 个文件会报错，本项目的分发包远小于此）。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// ── DOS 时间戳 ─────────────────────────────────────────────────────────────
function dosDateTime(date) {
  const d = date || new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
  const day = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, day };
}

/** 遍历目录，返回相对 root 的文件清单（正斜杠路径，可按规则排除） */
function walk(root, opt) {
  const o = opt || {};
  const shouldSkip = o.skip || (() => false);
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const relChild = rel ? rel + '/' + ent.name : ent.name;
      if (shouldSkip(relChild)) continue;
      const absChild = path.join(abs, ent.name);
      if (ent.isDirectory()) visit(absChild, relChild);
      else if (ent.isFile()) out.push({ rel: relChild, abs: absChild });
    }
  };
  visit(root, '');
  return out;
}

/**
 * 写出 ZIP。
 * @param {string} zipPath 目标文件
 * @param {Array<{name:string, abs:string}|{name:string, data:Buffer}>} entries
 * @returns {{bytes:number, files:number, rawBytes:number}}
 */
function writeZip(zipPath, entries) {
  if (entries.length > 65535) throw new Error('文件数超过 65535，需要 ZIP64（本工具不支持）');
  const chunks = [];
  const central = [];
  const { time, day } = dosDateTime();
  let offset = 0;
  let rawBytes = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = e.data || fs.readFileSync(e.abs);
    rawBytes += data.length;
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // 解压所需版本
    local.writeUInt16LE(0x0800, 6);    // 位 11：文件名为 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);        // 扩展字段长度
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // 生成工具版本
    cd.writeUInt16LE(20, 6);           // 解压所需版本
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);           // 扩展字段
    cd.writeUInt16LE(0, 32);           // 注释
    cd.writeUInt16LE(0, 34);           // 起始磁盘
    cd.writeUInt16LE(0, 36);           // 内部属性
    cd.writeUInt32LE(0, 38);           // 外部属性
    cd.writeUInt32LE(offset, 42);      // 本地头偏移
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  const out = Buffer.concat([...chunks, cdBuf, eocd]);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, out);
  return { bytes: out.length, files: entries.length, rawBytes };
}

/** 列出已生成 ZIP 的条目名（自检用：不依赖解压工具） */
function listZip(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const names = [];
  for (let i = 0; i + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x02014b50) continue;
    const fnLen = buf.readUInt16LE(i + 28);
    const extraLen = buf.readUInt16LE(i + 30);
    const cmtLen = buf.readUInt16LE(i + 32);
    names.push(buf.slice(i + 46, i + 46 + fnLen).toString('utf8'));
    i += 45 + fnLen + extraLen + cmtLen;
  }
  return names;
}

module.exports = { writeZip, walk, listZip, crc32 };
