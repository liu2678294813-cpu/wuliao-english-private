# Android 多设备兼容性测试与验收报告

工程日期：2026-10-08 至 2026-10-09。产品：无聊英语。目标版本：Android 1.0.81（versionCode 87）。

## 1. 结论与证据口径

已实施两项可复现的手写工具交互修复和 Android 11+ TTS 服务可见性补全，建立九种窗口、字体/DPR/CPU 代理场景及 Android 真机/模拟器复测脚本。最终 Node 测试 **1317/1317 PASS**，完整 Playwright 回归 **206/206 PASS**（包含新增兼容性测试），独立兼容性专项 **16/16 PASS**。生产前端、Capacitor 同步、Android APK 构建及 `release:check` 均 PASS。

**不能据此宣称支持所有安卓平板或已经达到 Adaptive App Quality Tier 2。** 浏览器窗口不是品牌真机；系统最低安装 API 不等于最低可用 WebView。模拟器与云端实测受当前环境限制，状态为 BLOCKED。只有以下明确登记的真机操作和测试用例属于本轮实测。

真机最终结果：**PASS（13 项主验收 + 2 项补测）**。已覆盖安装 1.0.81，恢复原账号和资料库，实际安装 APK 哈希与构建产物完全一致。主运行先通过 13 项，在写作按钮定位处失败；原因是 APK 提供的离线入口名为“使用随应用范文”，旧驱动误用了无范文时的 AI 入口名称。修正定位后写作和 TTS 单独补测通过；未将那次完整运行的 FAIL 改写为 PASS。

## 2. 工程基线及资产保全

| 项目 | 记录 |
|---|---|
| 实际源码 | `D:\codex库\无聊英语`；正式项目目录中的同名路径为链接 |
| 开始分支 | `codex/vocabulary-modes-handwriting-20260915` |
| 开始 HEAD | `033c228a7d048cc44c5e56dd5af60a69b672bf67` |
| 工作区状态 | 原来已有大量修改、删除和未跟踪文件；保留原分支和索引，不使用 reset/clean/stash/restore |
| 源码安全备份 | `output/android-compat-20261008/baseline/`：branch、HEAD、status、tracked/staged binary diff、untracked 清单及 7600 个原文件的副本与 SHA-256，共 222192919 字节 |
| GitHub | `liu2678294813-cpu/wuliao-english-private`；API 实查为公开仓库，名称中的 private 不代表访问限制 |
| 发布对照基准 | 远端 main `86d33685204f174c7321785b0c4be56b9154dcfe`；与最终工作树比较，仅提交本轮改动，避免把本地历史分支差异误发为新修改 |
| 业务边界 | 不改变 applicationId、证书、数据库/账号格式、七阶段、词汇来源、AI 请求计费与笔迹坐标格式 |
| 历史模块 | 当前源码已移除模拟考试活动运行时；既有删除属于任务开始前状态，本轮不恢复，不将 X1 历史测试列作当前通过 |

本次主运行代码改动仅为 `src/ui/AnnotationToolbar.jsx`、`android/app/src/main/AndroidManifest.xml`，另将 `android/app/build.gradle` 版本递增到 1.0.81/87。测试与交付文件：

- `e2e/android-compat.spec.js`、`e2e/android-compat.config.mjs`：新增专项测试和证据输出。
- `e2e/flow24-approved-a-ui.spec.js`：修正历史导航数量断言，并逐项验证当前九个导航入口。
- `package.json`：增加 `test:android-compat`。
- `playwright.config.mjs`、`scripts/compat-preview.mjs`：可选的独立构建快照预览，避免另一次构建替换测试中的 JS 文件。
- `scripts/android-compat-device.mjs`：显式选择真机，在隔离本地测试账号中操作，前后核对原账号学习数据。
- `scripts/android-compat-emulator.py`：顺序启动指定 AVD 的 Android 烟雾测试；缺少环境时输出 BLOCKED。
- 本报告、`Android-多设备兼容性审计计划.md`、`Android-兼容性复测指南.md`。
- 外部现有文档项目的 `生成脚本/build_docs.py` 与两份规定 PDF 同步更新；原生成器和 PDF 已备份至 `output/android-compat-20261008/baseline-docs/`。

最终保全复核发现，10 月 9 日 00:03 之后工作区出现本轮之外的统一导入系统改动（包括 parser、storage、锁文件及 `src/import/`）。它们晚于本轮 APK 构建，保留原样，不纳入本次兼容性提交或已安装 APK。发布从已核实的远端 main 基线使用独立 Git 索引，只加入本次明确文件；不切换用户分支、不改用户暂存区。本报告关于“没有改变数据库结构”的结论指本次发布快照。基线清单中 7 个已迁移的路径是本任务最初生成的基线说明文件，内容仍保存在 `output/.../baseline/`，不是丢失的用户文件。

## 3. Android 和渲染架构审计

| 项目 | 已核实事实及含义 |
|---|---|
| SDK | minSdk 24、targetSdk 36、compileSdk 36；没有提高最低系统版本 |
| 依赖 | Capacitor 8.4.2、React 19.2.8、Vite 8.2.1、PDF.js 6.2.108、Playwright 1.57.0 |
| 前端目标 | Vite `es2022`；PDF 使用 legacy 构建，但这不自动补齐全部 DOM/CSS/JavaScript 兼容性 |
| ABI | APK 中没有 ABI 专属 `.so`；不因本项目自带 native library 限制架构，但仍受系统/WebView 能力约束 |
| 窗口 | viewport 为 `width=device-width, initial-scale=1.0, viewport-fit=cover`；沿用当前响应式布局和实际窗口尺寸，不加入设备型号判断或硬编码九个断点 |
| Activity | Manifest 已处理 orientation、keyboard、screenSize、smallestScreenSize、screenLayout、uiMode、navigation、density 等配置变化；旋转测试不能自动算作 Activity 被销毁重建 |
| 返回链 | 原生 `OnBackPressedCallback` → `__wuliaoHandleHardwareBack` → 现有弹层/页面优先级及保存边界 |
| 文件保存 | API 29+ 使用 MediaStore Downloads；API 24–28 使用 App 外部专属 Download 目录，不能声称两个范围保存位置相同 |
| PDF/OCR | 保留现有 PDF.js、Canvas、扫描导入与 OCR 接口。浏览器测试使用合成资料/受控响应；未消耗真实 AI/OCR 服务额度 |
| AI | Provider、密钥存储与显式请求契约保持不变；本轮不读取/上传用户 API Key，不以 mock 结果宣称线上模型实测 |
| TTS | 增加 `android.intent.action.TTS_SERVICE` 包查询；沿用 AndroidSpeech 与当前引擎，不变更发音路线 |

### 手写审计

Shared Ink Runtime 已统一 pointerup/pointercancel/lost-capture 收尾，使用指针捕获、可选 coalesced samples、归一化坐标及 DPR 上限。压感缺失时保留基础宽度/默认反馈；原生只对 stylus/eraser 请求 unbuffered dispatch，并让 WebView 正常处理事件，不采用厂商专属核心书写 API。现有擦除、撤销、保存、恢复、像素交接、缓存测试均在完整回归中执行。

这些是代码和自动化证据，不是 M-Pencil/S Pen 实际压感、掌触抑制、悬停、橡皮擦按钮或出墨延迟成绩。真实笔感需对应硬件与人工操作。

## 4. 问题、根因及修复

| 级别/状态 | 问题位置与影响 | 根因、处理及验证 | 业务影响 |
|---|---|---|---|
| P1 / PASS | 折叠手写工具在旋转、分屏、键盘可见窗口缩小时可能跑到屏幕外 | 旧位置仅拖动时限位；现在监听 window 和 visualViewport resize/scroll，按按钮实际矩形及可见区域重新限位，rAF 合并；修复前专项失败，修复后 PASS | 保留工具、撤销、擦除及存储语义 |
| P2 / PASS | 粗细滑块拖出轨道后抬笔，再移回来仍改变数值 | 旧拖动布尔状态未可靠结束；现在跟踪 pointerId、捕获当前指针并在 up/cancel/lost-capture 时清理，缺少捕获时离开收尾；修复前失败，修复后 PASS | 只修改手势收尾 |
| P1 / PASS（声明） | Android 11+ 语音引擎发现 | 添加官方要求的 TTS_SERVICE queries；APK Manifest 与原生桥接验收分开记录 | 不改变发音策略 |
| P2 / PASS | 首页旧测试要求 10 个导航 | 开始前当前产品只有 9 个入口；初始完整回归 189 PASS/1 FAIL。修正为精确 9 个且逐一检查名称，没有删除测试或隐藏 UI | 不改产品代码 |
| P1 / NOT_RUN | API 24 等旧系统附带的旧 WebView | minSdk 24 不能保证 ES2022/现代 Web API 可用；保留 SDK，不盲加全局 polyfill 或作旧引擎支持承诺 | 后续必须实装目标 API 并记录 WebView |
| P2 / PASS（有限） | AI 窗口、字体、DPR、iframe 边界 | 草稿缩窗保持、设置面板、3 类代理场景和 9 个窗口通过；审计阶段疑点没有复现成需要改代码的问题，未修改 AI 窗口 | 不发送真实 AI 请求 |
| P1 / BLOCKED | 其他系统与品牌 | 无可用模拟器条件/云测试授权；提供实际接入命令与库存查询，不伪造结果 | 未新增付费依赖 |

## 5. 测试矩阵

| 设备或环境 | Android / 引擎 | 分辨率或窗口 | 测试类型 | 状态 | 边界 |
|---|---|---|---|---|---|
| BTK-W00 | Android 12 / API 31；Huawei WebView 114.0.5.302 / Chromium 114.0.5735.196 | 物理 1440×2200，density 300；实测横屏 CSS 1174×736，DPR 1.875 | 本地真机覆盖安装、WebView/ADB 验收 | PASS | 当前实物窗口不同于历史 832×544 参考 |
| 桌面 Chromium | 非 Android | 390×844 | 手机窗口代理 | PASS | 独立账号、主要模块、iframe、弹窗、旋转和状态恢复 |
| 桌面 Chromium | 非 Android | 544×832、832×544 | 历史平板参考窗口 | PASS | 不能记作 Huawei 物理分辨率 |
| 桌面 Chromium | 非 Android | 600×960、960×600 | 窄平板窗口 | PASS | 同上 |
| 桌面 Chromium | 非 Android | 800×1280、1280×800 | 常规平板窗口 | PASS | 同上 |
| 桌面 Chromium | 非 Android | 1024×640 | 小平板窗口 | PASS | 同上 |
| 桌面 Chromium | 非 Android | 1600×900 | 超大窗口 | PASS | 同上 |
| 桌面 Chromium | 非 Android | 544×420、模拟 visualViewport 偏移/缩小 | 分屏/可见区域事件 | PASS | 非 Android 原生分屏手势 |
| 桌面 Chromium | 非 Android | 600×960，字体 150%，CPU 4 倍节流，DPR 1.875 | 性能和字体代理 | PASS | CPU 节流不是实际低 RAM 设备 |
| 桌面 Chromium | 非 Android | 1600×900，DPR 3，dark | 大屏高像素密度代理 | PASS | 未验证系统级显示大小或厂商强制深色 |
| 计划 AVD | API 24、28、30、31、34、36 | 待实际 AVD 定义 | Android 模拟器 | BLOCKED | emulator、system-images、AVD 不存在；固件虚拟化 False；主机 16GB，初始空闲约 2.4GB |
| 计划 Firebase Test Lab | 待库存查询 | 待库存查询 | 云端真实/虚拟设备 | BLOCKED | 没有项目授权/CLI 配置，未上传 APK |
| 计划 BrowserStack | 公开列表含三星平板；非实际预约 | 待账户可用设备 | 云端真机 | BLOCKED | 没有可用授权；小米/联想平板库存未确认 |

Android API 24、28、30、34、36 全部为 NOT_RUN；API 31 的 PASS 范围仅为本报告列明的 BTK-W00 操作。Android 16 大屏策略以官方说明作为审计依据，未运行 API 36，不作实测声明。

## 6. 功能覆盖及质量门禁

| 模块 | 浏览器/Node | 真机覆盖范围 | 未覆盖部分 |
|---|---|---|---|
| 首页、计划、档案、统计 | PASS：预算、档案弹窗、回归断言、九窗口 | 首页预算/档案和边界 | 长期真实统计增长 |
| 精读、资料库、七阶段 | PASS：已有完整流程、刷新、证据与保存边界 | 官方资料打开、精读开始、笔迹刷新后恢复 | 全部真实资料逐篇验收 |
| PDF、扫描导入/OCR | PASS：现有导入、布局、受控 OCR 测试 | 阅读相关加载 | 真机文件选择器、真实扫描识别、系统打印 PDF 全链路 |
| 完形及复习 | PASS：答题、流程、复习、笔迹及汇总测试 | 入口与布局 | 全部完形阶段的物理触摸操作 |
| 词库、筛查、背诵、复习、iframe | PASS：桥接、账号、状态、撤销、列表、窗口变化 | 四入口及 iframe / 背诵列表 | 全词库人工发音听检 |
| 长难句 | PASS：已有完整测试 | 页面入口 | 真机完整训练闭环 |
| 写作 W1–W8 | PASS：已有完整工作流和 W2 平板测试 | 离线范文 W1→W2、译文填写及刷新后恢复、实际软键盘显示 | 真机真实 AI/OCR 服务、写作草稿跨原生旋转 |
| 手写/工具栏 | PASS：引擎、擦除、撤销、耐久保存、工具栏两项缺陷复现与修复 | 合成 CDP pen、笔迹落库/重载、旋转 | 真实手写笔硬件能力与长时间手写 |
| AI/Provider、备份恢复、计时 | PASS：既有契约、隔离和 E2E | 原账号和已存学习事实核对 | 真实云模型计费请求、真机完整导入恢复 |
| Android 返回、前后台、TTS | JS 层既有回归 PASS | 硬件 BACK 返回资料库、HOME/恢复、低内存通知、原生 TTS started 日志 | 其他 OEM 与系统版本、真实音质听检 |
| X1 模拟考试 | 当前版本活动模块不存在；不适用 | 不操作保留的历史数据 | 不虚构历史功能覆盖 |

| 门禁 | 修复前 | 最终 |
|---|---|---|
| `pnpm test:all` | 1317 PASS | 1317 PASS |
| `pnpm test:e2e` | 189 PASS / 1 FAIL（过时导航数量断言） | 206 PASS，21.9 分钟 |
| 初始专项 | 9 PASS / 2 FAIL（已复现的工具栏/滑块缺陷） | 扩展为 16 PASS，约 2.8 分钟 |
| `pnpm build`、Capacitor sync、APK | 构建原业务基线用于复现 | PASS |
| `pnpm release:check` | — | PASS |

截图比较：117 对，90 对逐像素相同、0 对尺寸不一致；27 对差异只分布于首页/档案/筛查的动态账号、时间及内容。结合页面截图、DOM 边界及业务状态断言检查，没有把动态差异强行算作视觉回归。截图不等于所有文字和触控目标都已经逐项测量。

内置浏览器原生管道不可用，记录原始失败后按本任务允许的仓库 Playwright 方案执行。测试预览使用独立静态快照，避免长回归期间另一次构建造成资源消失。

## 7. 性能、稳定性及失败记录

浏览器 `homeReadyMs`（包含隔离账号注册及页面准备）分别为：普通窗口 1169ms、CPU 4 倍节流/150% 字体 5108ms、大屏 DPR 3 为 1065ms。它们是同机代理观测，不是 Android 冷启动或品牌横评。升级后的原生 `am start -W` 报 COLD、TotalTime 1853ms；这是单次 Activity 启动观测，不代表首页所有资源完全可交互的时间。

真机通过 `am send-trim-memory ... RUNNING_LOW` 发送系统低内存通知并检查前后台恢复；该通知不等于实际限制 RAM。真实低 RAM 平板、巨大 PDF、长时间 OCR/手写、数小时稳定性与进程被系统杀死后的 Activity 重建尚未完成，状态 NOT_RUN。

真机测试驱动调试中必须保留以下事实：旧 1.0.80 的早期诊断在一次性读取/跨 CDP 传输大量 IndexedDB 数据时两次遇到 Huawei WebView 渲染进程 SIGTRAP。批量读取造成压力是怀疑原因，未证明唯一根因；这些不是新 APK 的已修复缺陷证据。改成逐记录在设备内哈希、只传递摘要后完成前后校验。另有账号登录后预期首页、Android 返回时序和写作按钮定位等驱动失败，均保留原日志，不计作 PASS。系统密码保存提示处理和旋转截图等待补全后，最终硬件 BACK 记录确认原生调用了 JS 返回处理器，并返回资料库；没有为通过测试更改业务返回逻辑。新版本主运行日志中未发现 FATAL EXCEPTION/ANR/Fatal signal，且前后原账号 IndexedDB 摘要一致。最后两项补测只操作已存在的隔离账号，结束后恢复原账号；为让用户及时带走平板，没有再次重复全量 1.5 万词条哈希或长测。

构建警告判断：沿用当前 debug 证书属于升级路径要求，未擅建 release 签名；Vite 大 chunk 提示是后续性能风险；Gradle flatDir/path override 是现有构建配置；v1 签名对 META-INF 元数据的提示不等于 v2/v3 APK 完整性验证失败。发布门禁中的 24 项已分类 OCR/参考文本异常和 Web 0.1.0 / Android 1.0.81 独立版本也有明确记录，没有隐藏。

## 8. APK 与保留数据覆盖安装

| 项目 | 值 |
|---|---|
| APK 本地路径 | `D:\codex库\无聊英语\output\android\wuliao-english-android.apk` |
| 版本 | 1.0.81 / 87 |
| applicationId | `com.wuliao.english` |
| SDK | min 24 / target 36 / compile 36 |
| 文件字节数 | 188558866 |
| SHA-256 | `ee1a4326902a394870b8fb74032ba78fd3c2b1a76f8e014f0bda7768376a0ea3` |
| 签名 | 现有 debug 证书；v1/v2/v3 验证通过 |
| 证书 SHA-256 | `cb65f9a54422b71a791dddda1bdff301818d5ee7a34fddf839ff5d33e4e2330a`，与原安装一致 |
| 部署方式 | 项目内 ADB，显式选定 BTK-W00，`install -r`，结果 Success |
| 首次启动前 | 95/95 私有文件 SHA-256 相同，0 新增、0 缺失、0 变化 |
| 备份 | `output/unknown-context/android-compat-final-20261008/`；私有压缩备份 60203008 字节、清单、旧 APK、安装前后账号事实；另保留更早备份 |
| 前台/实际 APK | MainActivity 已恢复，PID 8440；安装 APK SHA-256 与上列构建包一致 |
| 启动后 | 原账号存在；reader-ink 59、unknown-words 413、writing-ink 8，长难句相关原数据计数及学习 localStorage 哈希一致；主验收结束还比较了 importedWords 14761、records 641 等逐行摘要 |

验收中的学习操作全部在新增本地 `compat-qa-*` 隔离账号进行；不删除账号或已有记录，结束后恢复原账号。诊断、备份、账号名、截图和私有学习内容均只留在被忽略的 `output/`，不上传 GitHub 或第三方测试平台。

## 9. 最终支持边界与后续优先级

1. **已验证环境：** 当前桌面 Chromium 的九种窗口和列明的代理场景；BTK-W00 / Android 12 / Huawei WebView 114 的已列明操作。浏览器全回归不能替代全部真机业务测试。
2. **可合理预期但未验证：** 具备相近 WebView 能力的其他安卓平板。依据是通用 Pointer Events、响应式布局和无 ABI 专属 `.so`；这是推测，不是品牌认证。
3. **已确认不兼容：** Android API 23 及以下被 APK minSdk 24 排除。没有本轮实测可证明某个其他品牌整体不兼容；也没有证据证明所有 API 24+ 都可用。
4. **最高优先级补测：** 启用虚拟化后逐个执行 API 24/28/30/34/36，记录 WebView；优先 API 24 老引擎、API 36 大屏方向/窗口、API 28 文件保存路径。
5. **随后补测：** 在已授权且审查过内容的云测试包上实测账户实际可用三星平板；小米、联想需实时确认库存；最后由真实手写笔完成压感、掌触、悬停、橡皮擦、长写和延迟验收。

改进路线优先补齐设备证据，再针对复现的问题做局部修复。提前加全局兼容层或重写笔迹引擎会扩大回归面，且无法替代实际 Android/WebView 测试。

## 10. 复测与证据索引

详见 [兼容性复测指南](Android-兼容性复测指南.md) 和 [初始审计计划](Android-多设备兼容性审计计划.md)。公开源码包含脚本、测试及结论；原始私有证据只在本地：

- `output/android-compat-20261008/baseline-node.log`、`baseline-e2e.log`、`before/`：修复前基线和缺陷。
- `final-node.log`、`final-e2e.log`、`final-e2e.json`、`after/results.json`：最终回归与专项。
- `after/playwright/`、`screenshot-comparison.json`：截图及差异。
- `android-build.log`、`release-check.log`、`apk.json`、`candidate-signature.txt`、`installed-signature.txt`：构建和签名。
- `emulator/result.json`：环境阻塞记录。
- `device-baseline-*`、`device-candidate/result.json`：真机各次尝试，失败保留；候选主运行 13 项 PASS。
- `device-final-additional/result.json`：写作/TTS 2 项补测 PASS、IME 状态、原账号恢复、版本/前台/安装 APK 哈希；`final-evidence.json` 汇总。
- `output/unknown-context/android-compat-final-20261008/preservation-result.json`：首次启动前数据保全证明。

两份规定 PDF 已重新生成并渲染检查：《无聊英语-现有功能文档》38 页、《无聊英语-功能修改过程文档》45 页；共 83 页未发现页面外文字或替换缺字标记，已检查全页缩略图和新增兼容性章节。修正了新增章节末尾跨页留下单行的问题。PDF 留在原文档目录；本次 GitHub Release 上传 APK、校验和及本报告，私有证据不随附件发布。

官方依据：[Adaptive App Quality](https://developer.android.com/docs/quality-guidelines/adaptive-app-quality)、[Android 16 行为](https://developer.android.com/about/versions/16/behavior-changes-16)、[TextToSpeech 包可见性](https://developer.android.com/reference/android/speech/tts/TextToSpeech)。云端库存、费用、接入命令及其官方来源集中在复测指南，执行时须重新确认。

自检：已将事实、推测、未运行和阻塞范围分开；没有虚构兼容率、云设备、手写硬件成绩或 Tier 2 认证；没有卸载/清除 App；原工作区资产和学习数据保全证据保留。
