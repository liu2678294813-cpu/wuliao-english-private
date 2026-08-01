import { readFile, writeFile } from "node:fs/promises";

const bundlePath = new URL("../public/vocabulary/assets/index-DSvnOTE0.js", import.meta.url);
let bundle = await readFile(bundlePath, "utf8");
const legacyAutoListSetup = "e&&(async()=>{await ga(e,Fa.name,Fa.wordIds);let[t,n]=await Promise.all([ha(e),Da(e)]);";
const correctedListSetup = "e&&(async()=>{let[t,n]=await Promise.all([ha(e),Da(e)]);";
const legacyAccountRestore = "e&&(ga(e,Fa.name,Fa.wordIds).catch(e=>{console.error(`Failed to ensure built-in custom list:`,e)}),n({username:e,isLoggedIn:!0}))";
const correctedAccountRestore = "e&&n({username:e,isLoggedIn:!0})";
const legacyLoginSetup = "await ga(t,Fa.name,Fa.wordIds),localStorage.setItem(Ra,t)";
const correctedLoginSetup = "localStorage.setItem(Ra,t)";

if (bundle.includes(legacyAutoListSetup)) {
  bundle = bundle.replace(legacyAutoListSetup, correctedListSetup);
} else if (!bundle.includes(correctedListSetup)) {
  throw new Error("未找到词库初始化补丁位置，已停止构建以避免错误修改。");
}

if (bundle.includes(legacyAccountRestore)) {
  bundle = bundle.replace(legacyAccountRestore, correctedAccountRestore);
} else if (!bundle.includes(correctedAccountRestore)) {
  throw new Error("未找到账号恢复补丁位置，已停止构建以避免错误修改。");
}

if (bundle.includes(legacyLoginSetup)) {
  bundle = bundle.replace(legacyLoginSetup, correctedLoginSetup);
} else if (!bundle.includes(correctedLoginSetup)) {
  throw new Error("未找到登录补丁位置，已停止构建以避免错误修改。");
}

await writeFile(bundlePath, bundle, "utf8");
