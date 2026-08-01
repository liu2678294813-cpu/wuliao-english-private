import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";

const root = resolve("dist");
// Keep the original vocabulary-app origin so its IndexedDB records remain available after merging.
const port = 4173;
const url = `http://127.0.0.1:${port}`;
const appTitle = "无聊英语 · 精读训练";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".pdf": "application/pdf",
  ".apk": "application/vnd.android.package-archive",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function localNetworkUrls() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === "IPv4" && !address.internal)
    .map((address) => `http://${address.address}:${port}`);
}

function printAccessUrls() {
  console.log(`电脑访问：${url}`);
  const lanUrls = localNetworkUrls();
  if (lanUrls.length) {
    console.log("平板/手机访问（设备需连接同一 Wi-Fi）：");
    lanUrls.forEach((lanUrl) => console.log(`  ${lanUrl}`));
  }
}

if (!existsSync(join(root, "index.html"))) {
  console.error("尚未找到构建文件，请先运行 pnpm build。");
  process.exit(1);
}

const server = createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, `http://${request.headers.host}`).pathname);
  let filePath = normalize(join(root, requestPath === "/" ? "index.html" : requestPath));
  if (!filePath.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(root, "index.html");
  const size = statSync(filePath).size;
  const type = mime[extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = request.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (match) {
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      response.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
      createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
  }
  response.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
  createReadStream(filePath).pipe(response);
});

function openApp() {
  if (process.platform === "win32" && process.env.WULIAO_NO_OPEN !== "1") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  }
}

server.on("error", async (error) => {
  if (error.code !== "EADDRINUSE") {
    console.error(error);
    process.exit(1);
  }

  try {
    const response = await fetch(url);
    const html = await response.text();
    if (!response.ok || !html.includes(`<title>${appTitle}</title>`)) {
      throw new Error("port occupied by another application");
    }
    console.log("无聊英语已在运行。");
    printAccessUrls();
    openApp();
    process.exit(0);
  } catch {
    console.error(`端口 ${port} 已被其他程序占用，请先关闭占用程序后重试。`);
    process.exit(1);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log("无聊英语已启动。");
  printAccessUrls();
  openApp();
});
