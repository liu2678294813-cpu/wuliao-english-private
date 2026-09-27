// 版本 / 构建信息统一入口。Android 构建由 scripts/build-android.ps1 注入
// VITE_APP_VERSION / VITE_APP_BUILD / VITE_GIT_COMMIT；web 构建使用默认值。
import { isAndroidApp } from "./platform";

export function getAppInfo() {
  const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
  return {
    appVersion: String(env.VITE_APP_VERSION || "0.1.0"),
    buildId: env.VITE_APP_BUILD ? String(env.VITE_APP_BUILD) : "",
    platform: isAndroidApp() ? "android" : "web",
    gitCommit: env.VITE_GIT_COMMIT ? String(env.VITE_GIT_COMMIT) : "",
  };
}
