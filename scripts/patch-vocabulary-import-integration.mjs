import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const bundlePath = process.argv[2] ? pathToFileURL(process.argv[2]) : new URL("../public/vocabulary/assets/index-DSvnOTE0.js", import.meta.url);
const oldBridgeImport = 'import{deleteImportedListForMainRecord as __iwDelete,getAllImportedWords as __iwAll,getImportedWord as __iwOne,getImportedWords as __iwMany,renameImportedListForMainRecord as __iwRename,syncImportedLists as __iwSync}from"../imported-word-bridge.js";';
const bridgeImport = 'import{deleteImportedListForMainRecord as __iwDelete,getReadingWordList as __readingList,getReadingWords as __readingWords,isReadingWordList as __isReadingList,resolveVocabularyList as __resolveList,getAllImportedWords as __iwAll,getImportedWord as __iwOne,getImportedWords as __iwMany,renameImportedListForMainRecord as __iwRename,syncImportedLists as __iwSync}from"../imported-word-bridge.js";';

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

const readingListReplacements = [
  [
    "async function ha(e,t){try{await __iwSync(e)}catch(e){console.error(`Imported vocabulary sync failed`,e)}let n=await da.wordLists.where(`username`).equals(e).toArray();return t?n.filter(e=>e.type===t):n}",
    "async function ha(e,t){let[,n]=await Promise.all([__iwSync(e).catch(e=>console.error(`Imported vocabulary sync failed`,e)),__readingList(e,{create:true}).catch(e=>console.error(`Reading vocabulary sync failed`,e))]);let r=(await da.wordLists.where(`username`).equals(e).toArray()).filter(e=>!__isReadingList(e));if(n&&!n.hidden)r.push(n);return t?r.filter(e=>e.type===t):r}",
  ],
  [
    "async function ya(e){await __iwDelete(e),await da.wordLists.delete(e)}async function ba(e,t){await __iwRename(e,t),await da.wordLists.update(e,{name:t})}",
    "async function ya(e){if(!await __iwDelete(e))await da.wordLists.delete(e)}async function ba(e,t){await __iwRename(e,t),await da.wordLists.update(e,{name:t})}",
  ],
  [
    "async function oo(e){if(e.startsWith(`import:`))try{return await __iwOne(e)}catch{return}let t=io(e);try{return(await ao(t)).entries.find(t=>t.wordId===e)}catch{return}}",
    "async function oo(e){if(e.startsWith(`unknown:`))return(await __readingWords([e]))[0];if(e.startsWith(`import:`))try{return await __iwOne(e)}catch{return}let t=io(e);try{return(await ao(t)).entries.find(t=>t.wordId===e)}catch{return}}",
  ],
  [
    "async function so(e){let t=e.filter(e=>!e.startsWith(`import:`)),n=e.filter(e=>e.startsWith(`import:`)),r=[...new Set(t.map(io))],i=await Promise.all(r.map(ao)),a=new Map;for(let e of i)for(let t of e.entries)a.set(t.wordId,t);for(let e of await __iwMany(n))a.set(e.wordId,e);return e.map(e=>a.get(e)).filter(e=>!!e)}",
    "async function so(e){let t=e.filter(e=>!e.startsWith(`import:`)&&!e.startsWith(`unknown:`)),n=e.filter(e=>e.startsWith(`import:`)),[r,i,o]=await Promise.all([Promise.all([...new Set(t.map(io))].map(ao)),__iwMany(n),__readingWords(e)]),a=new Map;for(let e of r)for(let t of e.entries)a.set(t.wordId,t);for(let e of [...i,...o])a.set(e.wordId,e);return e.map(e=>a.get(e)).filter(e=>!!e)}",
  ],
  [
    "async function va(e){return da.wordLists.get(e)}",
    "async function va(e){return __resolveList(await da.wordLists.get(e))}",
  ],
  [
    "className:`bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between`,children:[(0,Y.jsxs)(`div`,{className:`min-w-0 flex-1`",
    "className:`bg-white rounded-lg border border-gray-200 p-4 flex items-center justify-between`,\"data-vocab-list-id\":e.id,children:[(0,Y.jsxs)(`div`,{className:`min-w-0 flex-1`",
  ],
  [
    "message:`确定要删除「${c?.name}」吗？该操作不可撤销。`",
    "message:__isReadingList(c)?`从词库训练移除「${c.name}」（${c.wordIds.length} 词）？阅读标记、语境与学习记录会保留。可从精读陌生词库重新打开。`:`确定要删除「${c?.name}」吗？该操作不可撤销。`",
  ],
  [
    "let e=await ha(t);e.sort((e,t)=>t.createdAt-e.createdAt),i(e)})()},[t]),(0,_.useEffect)(()=>{!a||!t||(async()=>{let e=await va(a);if(!e||e.username!==t)return;f(e.name),g(e.wordIds.length);let n=await so(e.wordIds),r=new Map(n.map(e=>[e.wordId,e]));u(e.wordIds.map(e=>r.get(e)).filter(e=>!!e))})()},[a,t]);",
    "let n=await ha(t);n.sort((e,t)=>t.createdAt-e.createdAt),i(n)})()},[t]),(0,_.useEffect)(()=>{let e=!0;u([]),f(``),g(0);if(a&&t)(async()=>{let n=await va(a);if(!e||!n||n.username!==t)return;let r=await so(n.wordIds);if(e)f(n.name),g(r.length),u(r)})();return()=>{e=!1}},[a,t]);",
  ],
];

let source = (await readFile(bundlePath, "utf8")).split(oldBridgeImport).join("");

if (!source.includes(bridgeImport)) {
  source = bridgeImport + source;
}
// Other build patches may prepend their own imports. Keep exactly one binding.
const firstBridgeImport = source.indexOf(bridgeImport);
source = source.slice(0, firstBridgeImport + bridgeImport.length)
  + source.slice(firstBridgeImport + bridgeImport.length).split(bridgeImport).join("");

const finalReplacements = new Map(readingListReplacements);
for (const [before, after] of [...replacements, ...readingListReplacements]) {
  if (source.includes(after) || source.includes(finalReplacements.get(after) ?? after)) continue;
  const matches = source.split(before).length - 1;
  if (matches !== 1) {
    throw new Error(`Expected one bundle match, found ${matches}: ${before.slice(0, 80)}`);
  }
  source = source.replace(before, after);
}

await writeFile(bundlePath, source, "utf8");
console.log("Vocabulary import integration patch is present.");
