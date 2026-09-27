// Read-only provider verification. Credentials stay inside the production WebView.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
async function verify() {
  const raw = localStorage.getItem('kaoyan_vocab_current_user'); let user;
  try { user = JSON.parse(raw); } catch { user = raw; }
  const username = typeof user === 'string' ? user : user.username;
  const prefix = `wuliao:user:${encodeURIComponent(username)}:`;
  const get = key => localStorage.getItem(prefix + key);
  const read = async (name, store) => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open(name); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    try { return await new Promise((ok, no) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); } finally { db.close(); }
  };
  const rows = await read('wuliao-english', 'writing-ink');
  const ink = rows.filter(r => r.username === username && r.surfaceId.startsWith('vocabulary:')).sort((a, b) => b.strokes.length - a.strokes.length)[0];
  if (!ink) return { error: 'No saved vocabulary ink' };
  const canvas = document.createElement('canvas'); canvas.width = 1472; canvas.height = 256;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const stroke of ink.strokes) { ctx.strokeStyle = stroke.tool === 'eraser' ? 'white' : stroke.color; ctx.lineWidth = (stroke.width || 1) * 4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); stroke.points.forEach((p, i) => { const q = p.writingLocal || p; ctx[i ? 'lineTo' : 'moveTo'](q.x * canvas.width, q.y * canvas.height); }); ctx.stroke(); }
  const invoke = async (modality, messages) => {
    const p = JSON.parse(get('wuliao:ai:provider-profile:v2:' + modality));
    let key = window.AndroidSecureStore.get(`ai:credential:v2:${encodeURIComponent(username)}:${p.credentialScopeId}`);
    if (!key && modality === 'vision') { const legacy = JSON.parse(get('wuliao:writing:vision-api-config:v1') || 'null'); if (legacy?.baseUrl?.replace(/\/$/, '') === p.baseUrl.replace(/\/$/, '')) key = window.AndroidSecureStore.get('ai:vision-apikey:' + encodeURIComponent(username)); }
    if (!key) return { bound: false, model: p.modelId };
    try { const response = await fetch(p.baseUrl.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: p.modelId, messages, temperature: 0 }), signal: AbortSignal.timeout(60000) });
      const body = await response.json(); return { status: response.status, model: p.modelId, content: body.choices?.[0]?.message?.content, error: body.error?.message?.replace(/sk-[\w*.-]+/g, '[redacted]') };
    } catch (e) { return { model: p.modelId, error: e.message }; }
  };
  const vision = await invoke('vision', [{ role: 'system', content: '忠实转录手写中文，不猜测。只返回 JSON {"text":"原文","unsure":false}。' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: canvas.toDataURL('image/png') } }] }]);
  const text = await invoke('text', [{ role: 'system', content: '判断英汉词义是否相符。只返回 JSON {"verdict":"correct|wrong|unsure","reason":"中文理由"}。' }, { role: 'user', content: JSON.stringify({ english: 'applause', reference: '鼓掌；喝彩', answer: '掌声' }) }]);
  return { readOnly: true, strokes: ink.strokes.length, vision, text };
}
const result = execFileSync(process.execPath, ['scripts/device-cdp.mjs', 'eval', `(${verify.toString()})()`], { encoding: 'utf8', windowsHide: true, timeout: 145000 });
writeFileSync('output/recall-handwriting-20260920/live-ai-result.json', result);
console.log(result);
