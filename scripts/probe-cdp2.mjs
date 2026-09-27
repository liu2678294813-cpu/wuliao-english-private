// 真机 WebView CDP 最小客户端（页面 target 直连，Node 原生 WebSocket）。
// 用法: node scripts/probe-cdp2.mjs <expr-file-or-command>
import { readFileSync } from "node:fs";

const list = await fetch("http://127.0.0.1:9223/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) {
  console.log("NO PAGE TARGET");
  console.log(JSON.stringify(list.slice(0, 5), null, 2));
  process.exit(1);
}
console.log(`PAGE: ${page.title} | ${page.url.slice(0, 120)}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("ws error"));
});

let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const id = nextId += 1;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const expr = process.argv[2] || "1+1";
const fileArg = process.argv.findIndex((a) => a === "--file");
const expression = fileArg >= 0 ? readFileSync(process.argv[fileArg + 1], "utf8") : expr;
const result = await send("Runtime.evaluate", {
  expression,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2));
ws.close();
