# Android 多设备兼容性复测指南

本指南使用项目已有 Node、Playwright、Capacitor 和本地 Android SDK，不新增测试框架。所有命令从源码根目录运行。证据保存在 `output/android-compat-20261008/`，它被 Git 忽略。

## 浏览器自动化

```powershell
corepack pnpm test:all
corepack pnpm test:e2e
corepack pnpm exec playwright test --config e2e/android-compat.config.mjs
corepack pnpm release:check
```

兼容性专项配置默认自行构建并启动 5199 端口，测试九种窗口、核心模块、iframe、档案弹窗、阅读阶段恢复、工具栏和滑块。若已有同一版本的测试预览，可设置 `$env:COMPAT_EXISTING_SERVER='1'`，但不得复用未知版本。`COMPAT_RUN` 指定不同证据子目录以保存修复前后结果。

浏览器 viewport 不是品牌真机；DPR/字体/CPU 节流只是代理场景。截图检查与 DOM 边界断言配合使用；状态恢复读取真实持久化后的 UI。

## 本地 Android 真机复测

先按项目既有保留数据部署流程保存私有文件/旧 APK、核对证书，再覆盖安装。不得卸载或清除数据。脚本要求目标 App 已启动并登录原账号，显式传入设备序列号；它使用新的本地隔离账号，结束后恢复原账号和原系统旋转设置，并比较原账号学习事实摘要。测试账号留作证据，不擅自删除。

```powershell
& .android-sdk\platform-tools\adb.exe devices -l
node scripts/android-compat-device.mjs '<CONFIRMED_DEVICE_SERIAL>' output/android-compat-20261008/device-repeat
```

脚本的 CDP 合成笔不能验证硬件压感或掌触抑制；TTS started 日志不能验证听感。大量原账号数据在设备内逐记录计算摘要，避免一次把 PDF/笔迹二进制内容复制到 CDP。首次运行原账号约 1.5 万词条时，前后摘要可能各需一分钟以上。本轮最终证据由 13 项主运行通过和写作/TTS 2 项补测通过组成，早期失败文件仍保留。

## Android 模拟器

本轮主机固件虚拟化报告未启用、无系统镜像，模拟器结果为 BLOCKED。需要先在 BIOS/UEFI 启用虚拟化并按 Android 官方要求配置 Windows Hypervisor Platform（可能需要重启）；不能通过脚本擅自改系统启动配置。准备好之后逐个运行 AVD。

```powershell
$env:JAVA_HOME = (Get-ChildItem .android-toolchain\jdk -Directory | Select-Object -First 1).FullName
$env:ANDROID_SDK_ROOT = (Resolve-Path .android-sdk).Path
$env:ANDROID_AVD_HOME = Join-Path (Resolve-Path .).Path 'output\android-avd'
New-Item -ItemType Directory -Force $env:ANDROID_AVD_HOME | Out-Null
# 先查看实际可用镜像，不推断所有 API 镜像都存在。
& .android-sdk\cmdline-tools\latest\bin\sdkmanager.bat --list
# 示例：确认镜像可用后下载。许可证由使用者审核接受。
& .android-sdk\cmdline-tools\latest\bin\sdkmanager.bat 'emulator' 'system-images;android-36;google_apis;x86_64'
& .android-sdk\emulator\emulator.exe -accel-check
& .android-sdk\cmdline-tools\latest\bin\avdmanager.bat list device
# 将下面设备定义替换为上一步列出的平板 ID。
& .android-sdk\cmdline-tools\latest\bin\avdmanager.bat create avd -n Wuliao_API36 -k 'system-images;android-36;google_apis;x86_64' -d '<TABLET_DEVICE_ID>'
python -X utf8 scripts/android-compat-emulator.py --avd Wuliao_API36
```

依次对 API 24、28、30、31、34、36 建立可取得的镜像，不同时启动多个虚拟机。运行脚本只选择新启动的 `emulator-PORT`，不会操作已连接的真机；它记录安装、启动、系统/WebView、旋转截图、后台恢复和 logcat。它不把启动烟雾测试算作业务验收。字体/显示大小、文件选择器、TTS、触摸以及笔迹仍需后续交互验证。

## 云端设备：当前 BLOCKED，未上传任何 APK 或用户资料

查询日期：2026-10-08。未发现本机 gcloud、Firebase/BrowserStack 授权配置。正式 APK 包含产品资料，必须先审查 APK 中 PDF、范文、字体授权及潜在私人内容；新建云测试账号不能消除 APK 自带内容的隐私风险。只有经内容审核的测试包、合成学习数据和明确的账户/额度授权才可上传。

### Firebase Test Lab

支持 Robo、instrumentation、Game Loop；设备库存以控制台或 CLI 的实时结果为准。Spark 官方公开额度为每天 5 次物理设备、10 次虚拟设备；Blaze 超过每日免费时长后，物理设备 5 美元/小时、虚拟设备 1 美元/小时，按分钟计费。实际额度需检查项目，不自动启用计费。

```powershell
# 只读：选定已经授权的测试项目后查询库存和系统版本。
gcloud firebase test android models list --project '<AUTHORIZED_PROJECT>'
gcloud firebase test android versions list --project '<AUTHORIZED_PROJECT>'
gcloud firebase test android models describe '<ACTUAL_MODEL_ID>' --project '<AUTHORIZED_PROJECT>'
# 以下会上传并消耗额度：仅在已核实授权、价格及脱敏包后执行。
gcloud firebase test android run --project '<AUTHORIZED_PROJECT>' --type robo --app '<REVIEWED_SYNTHETIC_TEST_APK>' --device 'model=<ACTUAL_MODEL_ID>,version=<ACTUAL_API>,locale=zh_CN,orientation=portrait' --timeout 5m
```

不能凭品牌目标虚构 Firebase 平板库存。以 `models list` 的 formFactor、supportedVersionIds 和稳定性标签选择三星、小米、联想（若实际存在）。本次未执行库存 API 或云测试。

Firebase Robo 的 `robo-directives` 不支持 WebView 内元素；本 App 的详细学习流程需要适合 WebView 的自动化或人工交互，不能把 Robo 启动成功视作七阶段、手写和写作全部通过。

### BrowserStack

App Live 用于交互式真机验收，App Automate 用于 Appium 等自动化，二者套餐不能混用。官方公开列表含 Galaxy Tab S7/API 30、S8/API 31、S9/API 33、A9 Plus/API 34、S10 Plus/API 35、S11/API 36；这是公开列表，不能作为账户实时可预约证明。小米/联想平板未从本轮公开列表确认。App Live Individual 页面显示年付折合 39 美元/月；地区、月付、并发和税费以账户结算页面为准。

```powershell
# 仅在授权后，把审核过的测试 APK 上传 App Live；凭据只取环境变量。
curl.exe -u "$($env:BROWSERSTACK_USERNAME):$($env:BROWSERSTACK_ACCESS_KEY)" -X POST 'https://api-cloud.browserstack.com/app-live/upload' -F 'file=@<REVIEWED_SYNTHETIC_TEST_APK>'
```

上传后在 App Live 选择账户实际可用的平板并保存设备/系统/WebView、截图、日志与逐项结果。不要把交互式试用额度理解为无限自动化许可。

AWS Device Farm 是另一种真实 Android 设备平台，可在现有 AWS 授权下查询设备并运行内置或自定义测试；本次没有 AWS 配置与授权，未启动收费任务。

### 合成验收数据与步骤

复用 `scripts/make-scanned-exam-fixture-pdf.mjs` 生成本地合成扫描题；测试账号使用随机 `compat-qa-*` 名称，AI 请求使用已有 E2E mock，不填真实 API Key。分别测试：注册→首页预算→词汇筛查/背诵→精读阶段与批注→完形→写作→备份导出/恢复→旋转/后台恢复。正式账号、备份文件和私人 PDF 始终留在本地。

## 官方依据

- [Android 模拟器加速](https://developer.android.com/studio/run/emulator-acceleration)
- [Adaptive App Quality](https://developer.android.com/docs/quality-guidelines/adaptive-app-quality)
- [Firebase 设备查询](https://firebase.google.com/docs/test-lab/android/available-testing-devices)
- [Firebase CLI 测试](https://firebase.google.com/docs/test-lab/android/command-line)
- [Firebase 价格与配额](https://firebase.google.com/docs/test-lab/usage-quotas-pricing)
- [BrowserStack 设备列表](https://www.browserstack.com/list-of-browsers-and-platforms/app_live)
- [BrowserStack App Live 上传 API](https://www.browserstack.com/app-live/rest-api)
- [BrowserStack 价格](https://www.browserstack.com/pricing?product=app-live)
- [AWS Device Farm](https://docs.aws.amazon.com/devicefarm/latest/developerguide/welcome.html)
