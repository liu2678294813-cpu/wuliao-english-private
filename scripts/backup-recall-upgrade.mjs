import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,openSync,closeSync,writeFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const adb=resolve('.android-sdk/platform-tools/adb.exe'),app='com.wuliao.english';
const output=resolve(process.argv[2] || 'output/recall-handwriting-20260920/upgrade-backup');mkdirSync(output,{recursive:true});
const run=(...args)=>execFileSync(adb,args,{encoding:'utf8',windowsHide:true,maxBuffer:64*1024*1024}).trim();
// Stop only the original app after isolated QA; never clear or uninstall it.
run('shell','am','force-stop',app);
const packageInfo=run('shell','dumpsys','package',app);
const apkPath=run('shell','pm','path',app).split('\n').find(s=>s.startsWith('package:')).slice(8).trim();
const oldApk=resolve(output,`wuliao-english-${packageInfo.match(/versionName=([^\s]+)/)?.[1]}.apk`);run('pull',apkPath,oldApk);
const manifest=run('shell','run-as',app,'sh','-c',"'find app_webview app_hws_webview files shared_prefs no_backup -type f -exec sha256sum {} \\;' ").split('\n').map(s=>s.trim()).filter(Boolean).sort();
assert.ok(manifest.length>0);
const archive=resolve(output,'app-data-before-1.0.69.tar');
const fd=openSync(archive,'wx');
try{const result=spawnSync(adb,['exec-out','run-as',app,'tar','-cf','-','app_webview','app_hws_webview','files','shared_prefs','no_backup'],{stdio:['ignore',fd,'pipe'],windowsHide:true});assert.equal(result.status,0,result.stderr?.toString());}finally{closeSync(fd);}
const result={createdAt:new Date().toISOString(),version:packageInfo.match(/versionName=([^\s]+)/)?.[1],files:manifest.length,bytes:statSync(archive).size,oldApkBytes:statSync(oldApk).size};
writeFileSync(resolve(output,'data-manifest.json'),JSON.stringify(manifest,null,2));
writeFileSync(resolve(output,'backup-result.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
