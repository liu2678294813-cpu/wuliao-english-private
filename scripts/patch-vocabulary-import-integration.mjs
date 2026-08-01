import { readFile, writeFile } from "node:fs/promises";

const bundlePath = new URL("../public/vocabulary/assets/index-DSvnOTE0.js", import.meta.url);
const bridgeImport = 'import{deleteImportedListForMainRecord as __iwDelete,getAllImportedWords as __iwAll,getImportedWord as __iwOne,getImportedWords as __iwMany,renameImportedListForMainRecord as __iwRename,syncImportedLists as __iwSync}from"../imported-word-bridge.js";';

const replacements = [
  [
    "async function ha(e,t){let n=await da.wordLists.where(`username`).equals(e).toArray();return t?n.filter(e=>e.type===t):n}",
    "async function ha(e,t){try{await __iwSync(e)}catch(e){console.error(`Imported vocabulary sync failed`,e)}let n=await da.wordLists.where(`username`).equals(e).toArray();return t?n.filter(e=>e.type===t):n}",
  ],
  [
    "async function ya(e){await da.wordLists.delete(e)}async function ba(e,t){await da.wordLists.update(e,{name:t})}",
    "async function ya(e){await __iwDelete(e),await da.wordLists.delete(e)}async function ba(e,t){await __iwRename(e,t),await da.wordLists.update(e,{name:t})}",
  ],
  [
    "async function oo(e){let t=io(e);try{return(await ao(t)).entries.find(t=>t.wordId===e)}catch{return}}",
    "async function oo(e){if(e.startsWith(`import:`))try{return await __iwOne(e)}catch{return}let t=io(e);try{return(await ao(t)).entries.find(t=>t.wordId===e)}catch{return}}",
  ],
  [
    "async function so(e){let t=[...new Set(e.map(io))],n=await Promise.all(t.map(ao)),r=new Map;for(let e of n)for(let t of e.entries)r.set(t.wordId,t);return e.map(e=>r.get(e)).filter(e=>!!e)}",
    "async function so(e){let t=e.filter(e=>!e.startsWith(`import:`)),n=e.filter(e=>e.startsWith(`import:`)),r=[...new Set(t.map(io))],i=await Promise.all(r.map(ao)),a=new Map;for(let e of i)for(let t of e.entries)a.set(t.wordId,t);for(let e of await __iwMany(n))a.set(e.wordId,e);return e.map(e=>a.get(e)).filter(e=>!!e)}",
  ],
  [
    "var uo=co().then(ho);",
    "var uo=Promise.all([co(),__iwAll().catch(e=>(console.error(`Imported vocabulary pool failed`,e),[]))]).then(([e,t])=>ho([...e,...t]));",
  ],
  [
    "function Tz(e,t){let n=new ArrayBuffer(e.byteLength);new Uint8Array(n).set(e);let r=new Blob([n],{type:`application/pdf`}),i=URL.createObjectURL(r),a=document.createElement(`a`);a.href=i,a.download=t.endsWith(`.pdf`)?t:`${t}.pdf`,document.body.appendChild(a),a.click(),a.remove(),window.setTimeout(()=>URL.revokeObjectURL(i),3e4)}",
    "function Tz(e,t){let n=new ArrayBuffer(e.byteLength);new Uint8Array(n).set(e);let r=t.endsWith(`.pdf`)?t:`${t}.pdf`;if(window.AndroidFileSaver?.saveBase64){let e=new Uint8Array(n),t=``,i=32768;for(let n=0;n<e.length;n+=i)t+=String.fromCharCode(...e.subarray(n,Math.min(n+i,e.length)));window.AndroidFileSaver.saveBase64(r,`application/pdf`,btoa(t));return}let i=new Blob([n],{type:`application/pdf`}),a=URL.createObjectURL(i),o=document.createElement(`a`);o.href=a,o.download=r,document.body.appendChild(o),o.click(),o.remove(),window.setTimeout(()=>URL.revokeObjectURL(a),3e4)}",
  ],
];

let source = await readFile(bundlePath, "utf8");

if (!source.startsWith(bridgeImport)) {
  source = bridgeImport + source;
}

for (const [before, after] of replacements) {
  if (source.includes(after)) continue;
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected one bundle match, found ${matches}: ${before.slice(0, 80)}`);
  }
  source = source.replace(before, after);
}

await writeFile(bundlePath, source, "utf8");
console.log("Vocabulary import integration patch is present.");
