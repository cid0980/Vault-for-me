/**
 * RepoVault — ZIP writer (store method, no compression).
 *
 * Two jobs: "download my whole vault as one file" (a backup you can trust
 * before purging/rebuilding anything), and a proof that what you exported is
 * byte-identical to what you uploaded.
 *
 * Deliberately dependency-free and *stored* rather than deflated: the files in
 * a vault are almost always images/video/PDF that are already compressed, so
 * re-deflating them would cost CPU for ~0% gain. Output is a normal .zip that
 * `unzip`, Finder, Explorer and Python's zipfile all read.
 *
 * Limits: ZIP64 is not implemented, so the archive must stay under 4 GB and
 * each entry under 4 GB. That is checked, not assumed.
 */

import { te } from './util.js';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800; // filenames are UTF-8
const MAX32 = 0xffffffff;

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (FAT epoch is 1980). */
function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((Math.floor(d.getSeconds() / 2)) & 31),
    date: (((year - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

/** `a/b/c.txt` → keep the path, but strip leading slashes and `..` segments. */
export function safeZipPath(name) {
  return String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .map((seg) => seg.replace(/[\u0000-\u001f]+/g, '').trim())
    .filter(Boolean)
    .join('/') || 'unnamed';
}

/**
 * @param files [{ name, data: Uint8Array }]
 * @returns { blob: Uint8Array, count, bytes, skipped }
 */
export function createZip(files, { onProgress = null, date = new Date() } = {}) {
  const { time, date: dosDate } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  let totalBytes = 0;
  let skipped = [];

  for (const file of files) {
    const rawName = String(file.name == null ? '' : file.name).trim();
    if (!rawName) { skipped.push({ name: rawName, reason: 'empty-name' }); continue; }
    const name = safeZipPath(rawName);
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
    if (data.length > MAX32) { skipped.push({ name, reason: 'entry-too-large' }); continue; }

    const nameBytes = te.encode(name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true);          // version needed (2.0)
    lv.setUint16(6, FLAG_UTF8, true);   // general purpose flags
    lv.setUint16(8, 0, true);           // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);          // extra field length
    local.set(nameBytes, 30);

    locals.push(local, data);
    centrals.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
    totalBytes += data.length;
    if (onProgress) onProgress((locals.length / 2) / files.length);
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const entry of centrals) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true);           // version made by
    cv.setUint16(6, 20, true);           // version needed
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, 0, true);           // method: stored
    cv.setUint16(12, time, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.size, true);
    cv.setUint32(24, entry.size, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    cv.setUint16(30, 0, true);           // extra
    cv.setUint16(32, 0, true);           // comment
    cv.setUint16(34, 0, true);           // disk number
    cv.setUint16(36, 0, true);           // internal attrs
    cv.setUint32(38, 0, true);           // external attrs
    cv.setUint32(42, entry.offset, true); // relative offset of local header
    header.set(entry.nameBytes, 46);
    locals.push(header);
    centralSize += header.length;
  }

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);
  locals.push(eocd);

  const total = locals.reduce((n, part) => n + part.length, 0);
  if (total > MAX32) throw new Error('Archive would exceed 4 GB — split the vault across repos, or export in batches.');

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of locals) { out.set(part, cursor); cursor += part.length; }
  if (onProgress) onProgress(1);

  return { blob: out, count: centrals.length, bytes: totalBytes, skipped };
}

/** Filename for a vault export: repovault-2026-10-05.zip */
export function exportName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `repovault-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.zip`;
}
