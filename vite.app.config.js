import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  const e2eOverlayOff = process.env.VITE_E2E_OVERLAY_OFF === "1";
  return {
    plugins: [react()],
    base: "./",
    build: {
      target: "es2022",
    },
    // The test server must become responsive before Playwright navigates. With
    // this app's large static graph, Vite 8 dependency discovery can monopolize
    // the dev server for minutes even though production builds complete quickly.
    optimizeDeps: e2eOverlayOff
      ? { noDiscovery: true, include: [] }
      : undefined,
    // E2E：dev 下动态 import public 词库 chunk 会被 vite 拒绝并弹错误
    // overlay，阻断后续点击。E2E 关闭 overlay，让离线词库查找失败后
    // 静默降级（生产 build 中这些 chunk 是静态文件，导入正常）。
    server: e2eOverlayOff
      ? {
          hmr: { overlay: false },
          warmup: { clientFiles: ["./src/main.jsx"] },
        }
      : undefined,
  };
});
