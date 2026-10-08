// Evidence only: credentials and learning content never leave the WebView.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const output = process.argv[2];
if (!output) throw new Error("Specify an evidence output path");
async function inspect() {
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2,"0")).join("");
  const local = {};
  for (const key of Object.keys(localStorage).sort()) local[key] = { hash: await hash(localStorage.getItem(key)), length: localStorage.getItem(key).length };
  const stores = {};
  const request = indexedDB.open("wuliao-english");
  const database = await new Promise((resolve,reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    for (const name of database.objectStoreNames) {
      const count = await new Promise((resolve,reject) => { const read = database.transaction(name).objectStore(name).count(); read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); });
      stores[name] = { count };
    }
    return { url: location.href, dbVersion: database.version, stores, local };
  } finally { database.close(); }
}
const evidence = execFileSync(process.execPath,["scripts/device-cdp.mjs","eval",`(${inspect.toString()})()`],{encoding:"utf8",windowsHide:true,timeout:90000});
writeFileSync(output,evidence);
const data = JSON.parse(evidence);
console.log(JSON.stringify({output,dbVersion:data.dbVersion,storeCounts:Object.fromEntries(Object.entries(data.stores).map(([name,value])=>[name,value.count])),localKeyCount:Object.keys(data.local).length}));
