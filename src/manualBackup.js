import { openBackupStaging } from "./backupStaging.js";
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createBackup, defaultBackupSources, summarizeBackup, BACKUP_FORMAT, BACKUP_VERSION } from './backup.js';
import { hashUpdateAttachment, jsonPieces, UpdateBackupHash, writeStreamedUpdateBackup } from './updateBackupStream.js';

const native = registerPlugin('ManualBackup');
const CHUNK = 192 * 1024;
function decodeBase64(data) {
  const binary = atob(data), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Acquire the destination during the click gesture, before asynchronous reads.
export async function openBackupDestination(filename) {
  filename = filename.replace(/[\\/:*?"<>|]/g, '_');
  if (Capacitor.isNativePlatform()) {
    const { backupId } = await native.begin({ filename });
    return {
      plugin: {
        writeBackupChunk: args => native.write(args),
        finishBackupAccount: args => native.finish(args),
      }, backupId, abort: () => native.abort({ backupId }), saved: true,
    };
  }
  const handle = globalThis.showSaveFilePicker ? await globalThis.showSaveFilePicker({ suggestedName: filename,
    types: [{ description: '无聊英语备份', accept: { 'application/json': ['.json'] } }] }) : null;
  const stream = handle ? await handle.createWritable() : null;
  const parts = []; let size = 0;
  return {
    backupId: 'manual', saved: Boolean(stream),
    abort: async () => { parts.length = 0; await stream?.abort(); },
    plugin: {
      async writeBackupChunk({ data, offset }) {
        if (offset !== size) throw new Error('备份分块顺序错误');
        const bytes = decodeBase64(data);
        size += bytes.length;
        if (stream) await stream.write(bytes);
        else {
          if (size > 256 * 1024 * 1024) throw new Error('此浏览器不支持大文件直接保存，请在 Android 应用或支持文件保存的桌面浏览器中导出；数据未删减。');
          parts.push(new Blob([bytes]));
        }
      },
      async finishBackupAccount({ sha256 }) {
        if (stream) {
          await stream.close();
          const saved = await handle.getFile(), hash = new UpdateBackupHash();
          for (let offset = 0; offset < saved.size; offset += CHUNK) hash.update(new Uint8Array(await saved.slice(offset, offset + CHUNK).arrayBuffer()));
          if (saved.size !== size || hash.hex() !== sha256) throw new Error('备份文件回读校验失败');
        }
        else {
          const url = URL.createObjectURL(new Blob(parts, { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = filename;
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000); parts.length = 0;
        }
        return { verified: true };
      },
    },
  };
}

export async function exportManualBackup({ username, appVersion, destination, active = () => {}, onProgress = () => {}, sources }) {
  const blobs = new Map();
  const staging = await openBackupStaging();
  try {
    active(); onProgress('正在读取学习记录…');
    const { manifest, counts } = await createBackup({ username, appVersion,
      sources: sources || defaultBackupSources({ strict: true }), serialize: false, staging,
      encodeAttachment: async blob => {
        active(); onProgress(`正在校验附件 ${blobs.size + 1}…`);
        blobs.set(`att-${blobs.size + 1}`, blob);
        return hashUpdateAttachment(blob, active);
      },
    });
    let lastUpdate = 0;
    const plugin = { ...destination.plugin, writeBackupChunk: async args => {
      active(); await destination.plugin.writeBackupChunk(args);
      if (Date.now() - lastUpdate > 150) { lastUpdate = Date.now(); onProgress(`正在写入备份：${(args.offset / 1048576).toFixed(1)} MB…`); }
    }, finishBackupAccount: async args => {
      active(); onProgress('正在完成保存并回读校验，请稍候…');
      return destination.plugin.finishBackupAccount(args);
    } };
    await writeStreamedUpdateBackup({ manifest, blobs, plugin, backupId: destination.backupId, accountIndex: 0, active });
    return { counts, saved: destination.saved };
  } catch (error) { await destination.abort().catch(() => {}); throw error; }
  finally { blobs.clear(); await staging.close(); }
}

// Parse a v1 JSON file incrementally. Attachment strings are decoded in bounded
// chunks into Blobs; no complete file/base64 string is ever materialized.
export async function parseBackupFile(file, options = {}) {
  const staging = await openBackupStaging();
  try {
    const manifest = await parseFile(file, options, staging);
    Object.defineProperty(manifest, 'dispose', { value: () => staging.close() });
    return manifest;
  } catch (error) { await staging.close(); throw error; }
}

async function parseFile(file, { active = () => {}, onProgress = () => {} }, staging) {
  let buffer = '', at = 0, offset = 0, depth = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const blobs = new Map();
  async function fill() {
    if (at < buffer.length) return true;
    active();
    if (offset >= file.size) return false;
    const end = Math.min(file.size, offset + CHUNK);
    buffer = decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: end < file.size });
    at = 0; offset = end;
    onProgress(`正在检查备份：${Math.floor(offset / file.size * 100)}%`);
    return buffer.length ? true : fill();
  }
  async function peek() { return await fill() ? buffer[at] : ''; }
  async function take() { const c = await peek(); if (!c) throw new Error('备份文件被截断'); at++; return c; }
  async function spaces() { while (/\s/.test(await peek()) && await peek()) at++; }
  async function string(attachmentId) {
    if (await take() !== '"') throw new Error('备份字符串无效');
    let raw = '', escaped = false, size = 0;
    const pieces = [], hash = new UpdateBackupHash();
    const flush = () => {
      if (!raw) return;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4) throw new Error('附件 Base64 无效');
      const bytes = decodeBase64(raw);
      size += bytes.length; hash.update(bytes); pieces.push(new Blob([bytes])); raw = '';
    };
    while (await fill()) {
      const start = at;
      while (at < buffer.length) {
        const c = buffer[at++];
        if (c === '"' && !escaped) {
          raw += buffer.slice(start, at - 1);
          if (attachmentId) { flush(); const blob = new Blob(pieces); blobs.set(attachmentId, blob); return { blob, size, hash: hash.hex() }; }
          return JSON.parse('"' + raw + '"');
        }
        if (attachmentId && (c === '\\' || c.charCodeAt(0) < 32)) throw new Error('附件编码无效');
        escaped = c === '\\' && !escaped;
      }
      raw += buffer.slice(start, at);
      if (attachmentId) {
        const end = Math.floor(raw.length / 4) * 4, tail = raw.slice(end); raw = raw.slice(0, end); flush(); raw = tail;
      }
    }
    throw new Error('备份字符串被截断');
  }
  async function value(path = []) {
    await spaces(); const c = await peek();
    if (c === '"') return string(path.length === 3 && path[0] === 'attachments' && path[2] === 'data' ? path[1] : null);
    if (c === '{' || c === '[') {
      if (++depth > 100) throw new Error('备份结构嵌套过深');
      at++; const array = c === '[';
      const staged = array && path[0] === 'sections' && (path[1] === 'localStorage' && path.length === 3 || path[1] === 'indexedDB' && path.length === 4);
      const result = array ? (staged ? staging.list() : []) : Object.create(null), end = array ? ']' : '}';
      await spaces();
      if (await peek() === end) { at++; depth--; return result; }
      while (true) {
        await spaces(); const key = array ? result.length : await string();
        if (!array) { if (Object.hasOwn(result, key)) throw new Error('备份包含重复字段'); await spaces(); if (await take() !== ':') throw new Error('备份格式无效'); }
        const item = await value([...path, String(key)]);
        if (array) await result.push(item); else result[key] = item;
        await spaces(); const separator = await take();
        if (separator === end) { depth--; return result; }
        if (separator !== ',') throw new Error('备份格式无效');
      }
    }
    let token = '';
    while (await peek() && !/[\s,}\]]/.test(await peek())) { token += await take(); if (token.length > 100) throw new Error('备份数值无效'); }
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)) throw new Error('备份值无效');
    return JSON.parse(token);
  }
  const parsed = await value(); await spaces();
  if (await peek()) throw new Error('备份包含多余内容');
  if (parsed?.format !== BACKUP_FORMAT || parsed.version !== BACKUP_VERSION || !Array.isArray(parsed.accounts) || parsed.accounts.length !== 1
      || !parsed.accounts[0]?.username || !parsed.sections?.localStorage || !parsed.sections?.indexedDB || !parsed.attachments) throw new Error('备份格式或版本无效');
  await staging.flush?.();
  for (const [id, attachment] of Object.entries(parsed.attachments)) {
    const data = attachment.data;
    if (!data?.blob || data.size !== attachment.size || data.hash !== attachment.sha256) throw new Error(`附件 ${id} 校验失败`);
    attachment.data = '';
  }
  const { checksum, ...canonical } = parsed, hash = new UpdateBackupHash(), encoder = new TextEncoder();
  onProgress('正在校验备份完整性…');
  for await (const piece of jsonPieces(canonical, blobs, active)) hash.update(encoder.encode(piece));
  if (!checksum || hash.hex() !== checksum) throw new Error('备份校验和失败：文件可能损坏或被修改');
  for (const [id, blob] of blobs) Object.defineProperty(parsed.attachments[id], 'blob', { value: blob });
  await validateRecords(parsed);
  return parsed;
}

async function validateRecords(manifest) {
  for (const list of Object.values(manifest.sections.localStorage)) {
    if (!Array.isArray(list) && !list?.[Symbol.asyncIterator]) throw new Error('本地记录结构无效');
    for await (const r of list) if (!r || typeof r.key !== 'string' || typeof r.value !== 'string') throw new Error('本地记录结构无效');
  }
  for (const stores of Object.values(manifest.sections.indexedDB)) for (const list of Object.values(stores)) {
    if (!Array.isArray(list) && !list?.[Symbol.asyncIterator]) throw new Error('数据库记录结构无效');
    for await (const r of list) {
      if (!r?.value || typeof r.value !== 'object' || r.key == null) throw new Error('数据库记录结构无效');
      if (r.value.file?.__backupAttachment && !manifest.attachments[r.value.file.__backupAttachment]) throw new Error('备份缺少引用的附件');
    }
  }
  summarizeBackup(manifest);
}
