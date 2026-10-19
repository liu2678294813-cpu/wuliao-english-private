import { Capacitor, registerPlugin } from '@capacitor/core';
import { exportManualBackup } from './manualBackup.js';
import { UpdateBackupHash, updateBackupBase64 } from './updateBackupStream.js';

const native = registerPlugin('DeviceTransfer');
let capability;
export async function transferCommand(action, args = {}) {
  if (Capacitor.isNativePlatform()) return native.command({ action, args });
  if (location.origin !== 'http://127.0.0.1:4173') throw new Error('局域网互传请使用 Windows 下载版或安卓 App；此页面仍可使用文件导入导出。');
  if (!capability) {
    const response = await fetch('/api/device-transfer/bootstrap');
    if (!response.ok || !(response.headers.get('content-type') || '').includes('application/json')) throw new Error('请更新并重新启动 Windows 下载版，再使用局域网互传。');
    capability = (await response.json()).capability;
  }
  const response = await fetch(`/api/device-transfer/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Wuliao-Control': capability }, body: JSON.stringify(args) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '互传失败'); return result;
}
export function fromBase64(text) {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
export async function makeConnection(command = transferCommand) {
  const info = await command('start');
  const secret = updateBackupBase64(crypto.getRandomValues(new Uint8Array(32)));
  return { ...info, secret };
}
export function connectionCode(info, host) {
  return 'WL1.' + btoa(JSON.stringify({ id: info.id, host, port: info.port, token: info.token, secret: info.secret }));
}
export function parseConnection(code) {
  try {
    if (!code.trim().startsWith('WL1.')) throw Error();
    const info = JSON.parse(atob(code.trim().slice(4)));
    const p = String(info.host).split('.').map(Number);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(info.host) || !p.every(n => n >= 0 && n <= 255) || !(p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || info.host === '127.0.0.1')
      || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{48}$/.test(info.id) || !/^[a-f0-9]{48}$/.test(info.token)
      || fromBase64(info.secret).length !== 32) throw Error();
    return info;
  } catch { throw new Error('连接码无效，请复制接收端完整的 WL1 连接码。'); }
}
export async function transferCipher(info) {
  const key = await crypto.subtle.importKey('raw', fromBase64(info.secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const params = (index, iv) => ({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${info.id}:${index}`), tagLength: 128 });
  return {
    async encrypt(index, bytes) {
      // Fresh nonces also protect retries with the same one-time connection code.
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt(params(index, iv), key, bytes));
      const packet = new Uint8Array(iv.length + encrypted.length); packet.set(iv); packet.set(encrypted, iv.length);
      return updateBackupBase64(packet);
    },
    async decrypt(index, data) { try { const packet = fromBase64(data); return new Uint8Array(await crypto.subtle.decrypt(params(index, packet.subarray(0, 12)), key, packet.subarray(12))); } catch { throw new Error('传输解密校验失败，数据可能损坏或连接码不匹配；未导入学习数据。'); } },
  };
}
export async function sendDeviceBackup({ code, username, appVersion, active, onProgress, command = transferCommand, sources }) {
  const info = parseConnection(code), cipher = await transferCipher(info);
  const remote = (method, body = {}) => command('remote', { host: info.host, port: info.port, token: info.token, method, body });
  await remote('offer', { data: await cipher.encrypt(0, encoder.encode(JSON.stringify({ username, appVersion, platform: Capacitor.getPlatform() }))) });
  onProgress('已连接，请在接收端确认接收…');
  const end = Date.now() + 600000;
  while (true) {
    active(); const status = await remote('status');
    if (status.state === 'accepted') break;
    if (Date.now() > end) throw new Error('等待接收确认超时，请重新连接。');
    await new Promise(r => setTimeout(r, 800));
  }
  let index = 0, size = 0;
  const destination = { saved: false, backupId: info.id, abort: async () => {}, plugin: {
    async writeBackupChunk({ offset, data }) {
      active(); if (offset !== size) throw new Error('发送分块顺序错误');
      const bytes = fromBase64(data);
      await remote('chunk', { index, data: await cipher.encrypt(index + 1, bytes) });
      index++; size += bytes.length;
    },
    async finishBackupAccount({ sha256 }) {
      active(); await remote('finish', { data: await cipher.encrypt(0xffffffff, encoder.encode(JSON.stringify({ chunks: index, size, sha256 }))) });
      return { verified: true };
    },
  } };
  await exportManualBackup({ username, appVersion, destination, active, onProgress, sources });
  onProgress('发送完成，请在接收端完成文件校验、差异预览和导入确认。');
}
// Decrypted chunks live in a temporary database; parseBackupFile reads bounded slices.
export async function receiveDeviceFile(info, status, { active, onProgress, command = transferCommand, indexedDb = globalThis.indexedDB }) {
  const cipher = await transferCipher(info);
  const finish = JSON.parse(decoder.decode(await cipher.decrypt(0xffffffff, status.finish)));
  if (!Number.isSafeInteger(finish.size) || finish.size < 1 || finish.chunks !== status.chunks) throw new Error('接收文件大小或分块数量无效');
  const name = `wuliao-transfer-stage-${crypto.randomUUID()}`;
  const db = await new Promise((r, j) => { const q = indexedDb.open(name, 1); q.onupgradeneeded = () => q.result.createObjectStore('chunks'); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); });
  const close = async () => { db.close(); await new Promise((r, j) => { const q = indexedDb.deleteDatabase(name); q.onsuccess = r; q.onerror = () => j(q.error); q.onblocked = () => j(new Error('接收暂存区仍在使用')); }); };
  const request = (mode, op) => new Promise((r, j) => { const tx = db.transaction('chunks', mode); const q = op(tx.objectStore('chunks')); tx.oncomplete = () => r(q.result); tx.onerror = () => j(tx.error); tx.onabort = () => j(tx.error || new Error('接收暂存失败')); });
  try {
    let size = 0; const hash = new UpdateBackupHash();
    for (let index = 0; index < finish.chunks; index++) {
      active(); const part = await command('read', { index });
      const bytes = await cipher.decrypt(index + 1, part.data);
      if (index < finish.chunks - 1 && bytes.length !== 196608) throw new Error('接收分块大小无效');
      hash.update(bytes); size += bytes.length;
      await request('readwrite', store => store.add(new Blob([bytes]), index));
      onProgress(`正在校验接收文件：${Math.floor((index + 1) / finish.chunks * 100)}%`);
    }
    if (size !== finish.size || hash.hex() !== finish.sha256) throw new Error('接收备份完整性校验失败；未导入学习数据。');
    return { size, dispose: close, slice(start, end) { return { async arrayBuffer() {
      const parts = [];
      for (let index = Math.floor(start / 196608); index <= Math.floor((end - 1) / 196608); index++) {
        active(); const blob = await request('readonly', store => store.get(index));
        parts.push(blob.slice(Math.max(0, start - index * 196608), Math.min(blob.size, end - index * 196608)));
      }
      return new Blob(parts).arrayBuffer();
    } }; } };
  } catch (error) { await close(); throw error; }
}
