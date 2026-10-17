import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const requestedPath = process.argv[2];
const bundlePath = requestedPath
  ? pathToFileURL(requestedPath)
  : new URL("../public/vocabulary/assets/index-DSvnOTE0.js", import.meta.url);
let bundle = await readFile(bundlePath, "utf8");
const hasScreeningModule = bundle.includes('/* wuliao-screening-module:start */');
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

const legacyScreeningHook = "function xo(e,t){let{username:n}=Ba();t||(t=Number(localStorage.getItem(`wuliao:vocab:last-source-list-${n}`))||0),";
const correctedScreeningHook = "function xo(e,t){let{username:n}=Ba();t&&localStorage.setItem(`wuliao:vocab:last-source-list-${n}`,String(t));t||(t=Number(localStorage.getItem(`wuliao:vocab:last-source-list-${n}`))||0),";
if (hasScreeningModule) {
  // The readable controller supersedes this legacy hook patch.
} else if (bundle.includes(legacyScreeningHook)) {
  bundle = bundle.replace(legacyScreeningHook, correctedScreeningHook);
} else if (!bundle.includes(correctedScreeningHook)) {
  throw new Error("未找到筛查词库记忆补丁位置，已停止构建以避免错误修改。");
}

const legacySessionSave = "async function Ta(e){await da.screeningSessions.put({...e,updatedAt:Date.now()}),await xa(e)}";
const correctedSessionSave = "async function Ta(e){e.listId>0&&localStorage.setItem(`wuliao:vocab:last-source-list-${e.username}`,String(e.listId));await da.screeningSessions.put({...e,updatedAt:Date.now()}),await xa(e)}";
if (bundle.includes(legacySessionSave)) {
  bundle = bundle.replace(legacySessionSave, correctedSessionSave);
} else if (!bundle.includes(correctedSessionSave)) {
  throw new Error("未找到筛查会话记忆补丁位置，已停止构建以避免错误修改。");
}

const contextBefore = "return{...r,handleAnswer:f,handleSkip:p}}function So({english:e})";
const contextAfter = "window.__wuliaoScreeningContext=async()=>({username:n,listId:c.current,round:e,currentIndex:r.currentIndex,sourceWordIds:[...a.current],listName:c.current?(await va(c.current))?.name||`当前词库`:`原始总词库`,words:await so(a.current)});return{...r,handleAnswer:f,handleSkip:p}}function So({english:e})";
if (hasScreeningModule) { /* Context is provided by the readable hook. */ }
else if (bundle.includes(contextBefore) && !bundle.includes(contextAfter)) bundle = bundle.replace(contextBefore, contextAfter);
else if (!bundle.includes(contextAfter)) throw new Error("未找到筛选上下文入口，已停止构建");

const audioBefore = "function Mo(e){return new Promise((t,n)=>{let r=jo();";
const audioAfter = "function Mo(e){if(window.WuliaoPronunciation)return window.WuliaoPronunciation.speak(e);return new Promise((t,n)=>{let r=jo();";
if (!bundle.includes(audioAfter)) {
  if (!bundle.includes(audioBefore)) throw new Error("未找到词汇朗读入口");
  bundle = bundle.replace(audioBefore, audioAfter);
}
const stopBefore = "function No(){jo().cancel()}";
const stopAfter = "function No(){window.WuliaoPronunciation?.stop();jo().cancel()}";
if (!bundle.includes(stopAfter)) {
  if (!bundle.includes(stopBefore)) throw new Error("未找到朗读停止入口");
  bundle = bundle.replace(stopBefore, stopAfter);
}

const moduleImport = 'import { useScreening as wuliaoUseScreening, screeningApi as wuliaoScreeningApi } from "../screening-controller.js";\n';
const hook = `/* wuliao-screening-module:start */
function xo(round,listId){
  const {username}=Ba();
  if(listId)localStorage.setItem('wuliao:vocab:last-source-list-'+username,String(listId));
  listId=listId||Number(localStorage.getItem('wuliao:vocab:last-source-list-'+username))||0;
  return wuliaoUseScreening(_,wuliaoScreeningApi({db:da,sessionKey:wa,getSession:Ea,getProgress:Sa,
    list:va,rawList:_a,allIds:bo,shuffleWords:wuliaoShuffleWordsPatched,word:oo,words:so,options:yo,
    makeList:ma,removeSession:Oa,skipId:Qa}),username,round,listId);
}
/* wuliao-screening-module:end */`;
const start = hasScreeningModule ? bundle.indexOf('/* wuliao-screening-module:start */') : bundle.indexOf('function xo(e,t){let{username:n}=Ba();');
const startToken = hasScreeningModule ? '/* wuliao-screening-module:start */' : 'function xo(e,t){let{username:n}=Ba();';
const endToken = hasScreeningModule ? '/* wuliao-screening-module:end */' : 'function So({english:e})';
if (bundle.split(startToken).length !== 2 || bundle.split(endToken).length !== 2) throw new Error('筛查控制器边界不唯一，已停止构建');
const end = hasScreeningModule ? bundle.indexOf('/* wuliao-screening-module:end */', start) + '/* wuliao-screening-module:end */'.length : bundle.indexOf('function So({english:e})', start);
if (start < 0 || end <= start) throw new Error('未找到完整筛查控制器边界，已停止构建');
bundle = bundle.slice(0, start) + hook + bundle.slice(end);
// Git on Windows may check this bundle out with CRLF. The declaration, rather
// than its trailing newline, is the idempotency marker.
if (!bundle.includes(moduleImport.trimEnd())) bundle = moduleImport + bundle;
bundle = bundle.replace('text-center animate-fade-in select-none','text-center select-none');
// Keep source metadata and replace the legacy view with readable modules.
const replaceOnce = (before, after, description) => {
  if (bundle.includes(after)) return;
  if (bundle.split(before).length !== 2) throw new Error(`${description}补丁位置不唯一，已停止构建`);
  bundle = bundle.replace(before, after);
};
replaceOnce('sourceWord:n.english,sourceWordChinese:n.chinese',
  'sourceWord:n.english,sourceWordChinese:n.chinese,sourceWordId:n.wordId', '筛查候选词身份');
replaceOnce('sourceWord:t.sourceWord,sourceWordChinese:t.sourceWordChinese',
  'sourceWord:t.sourceWord,sourceWordChinese:t.sourceWordChinese,sourceWordId:t.sourceWordId', '筛查选项身份');
// Restore the already-authorized account before route guards render. Previously
// an effect restored it too late and direct /confusion links bounced to dashboard.
replaceOnce('(0,_.useState)({username:null,isLoggedIn:!1})',
  '(0,_.useState)(()=>({username:localStorage.getItem(Ra)||null,isLoggedIn:!!localStorage.getItem(Ra)}))', '混淆词深链接账号恢复');
const confusionImport = 'import { ConfusionView as wuliaoConfusionView } from "../confusion-view.js";\n';
if (!bundle.includes(confusionImport.trimEnd())) bundle = confusionImport + bundle;
const confusionStart = '/* wuliao-confusion-view:start */';
const confusionEnd = '/* wuliao-confusion-view:end */';
const viewStart = bundle.indexOf(bundle.includes(confusionStart) ? confusionStart : 'function Fz(){');
const viewEnd = bundle.includes(confusionEnd) ? bundle.indexOf(confusionEnd) + confusionEnd.length : bundle.indexOf('function Iz(', viewStart);
if (viewStart < 0 || viewEnd <= viewStart || bundle.split('function Fz(){').length !== 2) throw new Error('混淆词页面边界不唯一，已停止构建');
bundle = bundle.slice(0, viewStart) + `${confusionStart}\nfunction Fz(){const {username}=Ba();return _.createElement(wuliaoConfusionView,{React:_,username})}\n${confusionEnd}` + bundle.slice(viewEnd);
const obsoleteLinks = [
  ',(0,Y.jsx)(ji,{to:Ga.CONFUSION,className:Ka,children:`混淆词对照`})',
  'n>0&&(0,Y.jsx)(Ua,{variant:`secondary`,onClick:()=>o(Ga.CONFUSION),size:`lg`,className:`w-full`,children:`查看混淆词`}),',
];
for (let index = 0; index < obsoleteLinks.length; index++) {
  const marker = `/* wuliao-confusion-entry-removed:${index} */`;
  if (bundle.includes(marker)) continue;
  const token = obsoleteLinks[index];
  if (bundle.split(token).length !== 2) throw new Error('混淆词旧入口位置不唯一，已停止构建');
  bundle = bundle.replace(token, marker);
}
// Deduplicate the exact displayed meanings, including the relaxed fallback.
const optionImport = 'import { uniqueScreeningOptions as wuliaoUniqueOptions } from "../screening-options.js";';
if (!bundle.includes(optionImport)) bundle = optionImport + '\n' + bundle;
const optionStart = bundle.indexOf('async function yo(');
const optionEnd = bundle.indexOf('async function bo(', optionStart);
if (optionStart < 0 || optionEnd <= optionStart) throw new Error('筛选选项生成入口缺失');
bundle = bundle.slice(0, optionStart) + 'async function yo(e){const [word,pool]=await Promise.all([oo(e),uo]);return wuliaoUniqueOptions(word,pool,{similar:mo,shuffle:go})}' + bundle.slice(optionEnd);
if (!bundle.includes('optionError:wuliaoOptionError')) {
  bundle = bundle.replace('handleAnswer:y,handleSkip:b}=xo(', 'handleAnswer:y,handleSkip:b,optionError:wuliaoOptionError,handleRetry:wuliaoRetry}=xo(');
  const quizHook = bundle.indexOf('optionError:wuliaoOptionError');
  const quizReturn = bundle.indexOf('return h?', quizHook);
  if (quizHook < 0 || quizReturn < 0) throw new Error('筛选异常界面入口缺失');
  bundle = bundle.slice(0, quizReturn) + 'return wuliaoOptionError?_.createElement("section",{role:"alert",className:"max-w-3xl mx-auto p-6"},_.createElement("p",null,wuliaoOptionError),_.createElement("button",{onClick:wuliaoRetry,className:"px-4 py-3"},"重试"),_.createElement("button",{onClick:b,className:"px-4 py-3"},"跳过本题（不记答错）")):h?' + bundle.slice(quizReturn + 'return h?'.length);
}
await writeFile(bundlePath, bundle, "utf8");
