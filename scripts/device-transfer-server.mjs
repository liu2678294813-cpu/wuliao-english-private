// Only encrypted chunks cross the LAN. Learning stores remain in the browser.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, readdir, statfs } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { networkInterfaces } from 'node:os';

export function privateHost(host) {
  const p = String(host).split('.').map(Number);
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) && p.join('.') === host && p.every(n => n >= 0 && n <= 255)
    && (p[0] === 10 || p[0] === 192 && p[1] === 168 || p[0] === 172 && p[1] >= 16 && p[1] <= 31 || host === '127.0.0.1');
}
const random = () => randomBytes(24).toString('hex');
const fail = message => { throw new Error(message); };
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': bytes.length }).end(bytes);
};
export async function readTransferBody(request) {
  let size = 0; const parts = [];
  for await (const part of request) { size += part.length; if (size > 320000) fail('传输分块过大'); parts.push(part); }
  return JSON.parse(Buffer.concat(parts).toString() || '{}');
}
export function createTransferController({ directory = resolve('artifacts/device-transfer-cache'), bind = '0.0.0.0', advertisedHosts } = {}) {
  let session, server, timer;
  const capability = random();
  const publicStatus = () => ({ id: session.id, state: session.state, offer: session.offer, finish: session.finish, chunks: session.chunks, bytes: session.bytes });
  async function stop() {
    clearTimeout(timer);
    const old = session; session = null;
    if (server) { const closing = server; server = null; closing.closeAllConnections(); await new Promise(r => closing.close(r)); }
    if (old) await rm(join(directory, old.id), { recursive: true, force: true });
    return {};
  }
  async function remoteAction(action, body, token) {
    if (!session || token !== session.token) fail('连接码无效或会话已结束');
    if (session.state === 'waiting' && Date.now() > session.expiresAt) fail('连接码已过期');
    if (action === 'status') return publicStatus();
    if (action === 'offer') {
      if (session.state !== 'waiting' || typeof body.data !== 'string' || body.data.length > 16384) fail('接收端当前不可连接');
      session.offer = body.data; session.state = 'offered'; return {};
    }
    if (session.state !== 'accepted') fail('接收端尚未确认或会话已完成');
    if (action === 'chunk') {
      if (body.index !== session.chunks || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.data || '')) fail('传输分块顺序或编码错误');
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length < 29 || bytes.length > 196636) fail('传输分块大小无效');
      const disk = await statfs(directory);
      if (disk.bavail * disk.bsize < bytes.length + 32 * 1024 * 1024) fail('接收设备存储空间不足');
      await writeFile(join(directory, session.id, `${body.index}.bin`), bytes, { flag: 'wx' });
      session.chunks++; session.bytes += bytes.length; return {};
    }
    if (action === 'finish') {
      if (typeof body.data !== 'string' || body.data.length > 4096 || !session.chunks) fail('结束信息无效');
      session.finish = body.data; session.state = 'complete'; return {};
    }
    fail('未知传输操作');
  }
  async function command(action, args = {}) {
    if (action === 'stop') return stop();
    if (action === 'start') {
      await stop();
      await mkdir(directory, { recursive: true });
      for (const entry of await readdir(directory)) if (/^[a-f0-9]{48}$/.test(entry)) await rm(join(directory, entry), { recursive: true, force: true });
      session = { id: random(), token: random(), state: 'waiting', chunks: 0, bytes: 0, expiresAt: Date.now() + 600000 };
      await mkdir(join(directory, session.id), { recursive: true });
      // Serialize mutations, including requests from competing senders.
      let queue = Promise.resolve();
      server = createServer((req, res) => {
        const task = async () => {
          try {
            if (req.method !== 'POST' || req.headers.origin) fail('仅允许应用配对连接');
            const match = /^\/transfer\/([a-z]+)$/.exec(req.url);
            if (!match) fail('未知传输路径');
            const result = await remoteAction(match[1], await readTransferBody(req), req.headers['x-transfer-token']);
            json(res, 200, result);
          } catch (error) { json(res, 400, { error: error.message }); }
        };
        queue = queue.then(task, task);
      });
      await new Promise((r, j) => { server.once('error', j); server.listen(0, bind, r); });
      const hosts = advertisedHosts || Object.values(networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal && privateHost(n.address)).map(n => n.address);
      timer = setTimeout(() => { if (session?.state === 'waiting' || session?.state === 'offered') void stop(); }, 600000); timer.unref();
      return { id: session.id, token: session.token, hosts, port: server.address().port };
    }
    if (action === 'remote') {
      const { host, port, token, method, body = {} } = args;
      if (!privateHost(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !['status', 'offer', 'chunk', 'finish'].includes(method)) fail('只支持本地网络设备');
      const response = await fetch(`http://${host}:${port}/transfer/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Transfer-Token': token }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
      const result = await response.json(); if (!response.ok) fail(result.error || '连接失败'); return result;
    }
    if (!session) fail('接收任务已结束，请重新打开接收');
    if (action === 'status') return publicStatus();
    if (action === 'accept') { if (session.state !== 'offered') fail('没有等待确认的设备'); session.state = 'accepted'; clearTimeout(timer); return {}; }
    if (action === 'read') {
      if (session.state !== 'complete' || !Number.isInteger(args.index) || args.index < 0 || args.index >= session.chunks) fail('备份尚未接收完整');
      return { data: (await readFile(join(directory, session.id, `${args.index}.bin`))).toString('base64') };
    }
    fail('未知本机操作');
  }
  async function handleControl(req, res) {
    if (!req.url.startsWith('/api/device-transfer/')) return false;
    try {
      const peer = req.socket.remoteAddress, origin = req.headers.origin;
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) || req.headers.host !== '127.0.0.1:4173' || origin && origin !== 'http://127.0.0.1:4173') fail('仅允许本机应用控制互传');
      const action = req.url.slice('/api/device-transfer/'.length);
      let result;
      if (action === 'bootstrap' && req.method === 'GET') result = { capability };
      else {
        if (req.method !== 'POST' || req.headers['x-wuliao-control'] !== capability) fail('本机验证失败，请刷新页面');
        result = await command(action, await readTransferBody(req));
      }
      json(res, 200, result);
    } catch (error) { json(res, 400, { error: error.message }); }
    return true;
  }
  return { command, handleControl, stop };
}
