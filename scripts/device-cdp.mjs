// Android WebView page-target CDP helper.
// Usage:
//   node scripts/device-cdp.mjs eval "document.title"
//   node scripts/device-cdp.mjs screenshot test-results/device.png
//   node scripts/device-cdp.mjs set-file "input[type=file]" /sdcard/Download/example.pdf
//   node scripts/device-cdp.mjs pen-stroke 100 200 240 260
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [, , command = "eval", ...args] = process.argv;
const debuggerUrl = process.env.WULIAO_DEVICE_CDP_URL || "http://127.0.0.1:9223";
const targets = await fetch(`${debuggerUrl}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page");
if (!page) throw new Error(`No Android WebView page target is available at ${debuggerUrl}.`);

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.onopen = resolveOpen;
  socket.onerror = () => rejectOpen(new Error("Unable to connect to the WebView page target."));
});

let nextId = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve: resolveRequest, reject: rejectRequest } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) rejectRequest(new Error(message.error.message));
  else resolveRequest(message.result);
};

function send(method, params = {}) {
  nextId += 1;
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(nextId, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id: nextId, method, params }));
  });
}

try {
  if (command === "eval") {
    const expression = args.join(" ") || "document.title";
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime evaluation failed.");
    console.log(JSON.stringify(result.result?.value ?? result.result, null, 2));
  } else if (command === "screenshot") {
    const outputPath = resolve(args[0] || "test-results/device-cdp.png");
    const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, Buffer.from(result.data, "base64"));
    console.log(outputPath);
  } else if (command === "set-file") {
    const [selector, filePath] = args;
    if (!selector || !filePath) throw new Error("set-file requires a selector and an Android filesystem path.");
    const documentNode = await send("DOM.getDocument", { depth: 1 });
    const matched = await send("DOM.querySelector", {
      nodeId: documentNode.root.nodeId,
      selector,
    });
    if (!matched.nodeId) throw new Error(`No element matches ${selector}.`);
    await send("DOM.setFileInputFiles", { nodeId: matched.nodeId, files: [filePath] });
    console.log(JSON.stringify({ selector, filePath, assigned: true }));
  } else if (command === "pen-stroke") {
    const [startX, startY, endX, endY] = args.map(Number);
    if (![startX, startY, endX, endY].every(Number.isFinite)) {
      throw new Error("pen-stroke requires numeric startX startY endX endY.");
    }
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1, pointerType: "pen",
    });
    for (let step = 1; step <= 8; step += 1) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + ((endX - startX) * step) / 8,
        y: startY + ((endY - startY) * step) / 8,
        button: "none",
        buttons: 1,
        pointerType: "pen",
      });
    }
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: endX, y: endY, button: "left", buttons: 0, clickCount: 1, pointerType: "pen",
    });
    console.log(JSON.stringify({ startX, startY, endX, endY, dispatched: true }));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  socket.close();
}
