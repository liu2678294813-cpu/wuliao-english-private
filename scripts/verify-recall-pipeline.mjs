// Exercise shipped image/AI functions against saved ink without classifying or
// overwriting the user's answers. All secrets remain in the Android WebView.
import { build } from '../node_modules/.pnpm/node_modules/esbuild/lib/main.js';
import { writeFileSync } from 'node:fs';
const bundle = await build({ stdin: { contents: 'import { loadHandwritingImage } from "./src/vocabulary/handwritingImage.js"; import { recognizeHandwriting, compareHandwriting } from "./src/vocabulary/handwritingAi.js"; import { computeFileFingerprint } from "./src/fingerprint.js"; globalThis.__recallProbe = {loadHandwritingImage,recognizeHandwriting,compareHandwriting,computeFileFingerprint};', resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser' });
const target = (await fetch('http://127.0.0.1:9223/json/list').then(r => r.json())).find(t => t.type === 'page');
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(ok => { socket.onopen = ok; }); let next = 0; const pending = new Map();
socket.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise(ok => { const id = ++next; pending.set(id, ok); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.error || r.result?.exceptionDetails) throw Error(JSON.stringify(r.error || r.result.exceptionDetails)); return r.result.result.value; };
try {
  await evaluate(bundle.outputFiles[0].text);
  const output = await evaluate(`(async () => {
    const context = await document.querySelector('.vocabulary-frame').contentWindow.__wuliaoScreeningContext();
    if (!context?.words) throw Error('Open screening first');
    const api = window.__recallProbe;
    context.fingerprints = Object.fromEntries(await Promise.all(context.words.map(async w => [w.wordId, await api.computeFileFingerprint(new TextEncoder().encode(JSON.stringify([w.wordId,w.english,w.chinese])))])));
    const db = await new Promise(ok => { const r=indexedDB.open('WuliaoVocabHandwritingDB');r.onsuccess=()=>ok(r.result); });
    const saved = await new Promise(ok=>{const r=db.transaction('answers').objectStore('answers').getAll();r.onsuccess=()=>ok(r.result)});db.close();
    const answers = saved.filter(a=>a.username===context.username && a.strokeCount>0 && context.words.some(w=>w.wordId===a.wordId));
    const images = await Promise.all(answers.map(async a=>({id:a.id,image:await api.loadHandwritingImage(context,a)})));
    const transcripts = await api.recognizeHandwriting({username:context.username,images});
    const rows = answers.map(a=>({...a,...context.words.find(w=>w.wordId===a.wordId),...transcripts.find(t=>t.id===a.id)}));
    const verdicts = await api.compareHandwriting({username:context.username,answers:rows});
    return {readOnly:true,images:images.map((i,index)=>({image:i.image,word:rows[index].english})),results:rows.map(a=>({word:a.english,reference:a.chinese,text:a.text,unsure:a.unsure,...verdicts.find(v=>v.id===a.id),id:undefined}))};
  })()`);
  for (const [index, item] of output.images.entries()) { writeFileSync(`output/recall-handwriting-20260920/live-ink-${index}.png`, Buffer.from(item.image.split(',')[1], 'base64')); }
  delete output.images;
  writeFileSync('output/recall-handwriting-20260920/live-pipeline-result.json', JSON.stringify(output, null, 2)); console.log(JSON.stringify(output,null,2));
} finally { await evaluate('delete window.__recallProbe').catch(()=>{}); socket.close(); }
