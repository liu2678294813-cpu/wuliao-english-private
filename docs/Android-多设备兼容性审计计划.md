# Android 多设备兼容性审计与实施计划

日期：2026-10-08。以当前工作区为业务基线，不恢复已经移除的模拟考试。

## 安全基线

- 分支：`codex/vocabulary-modes-handwriting-20260915`
- HEAD：`033c228a7d048cc44c5e56dd5af60a69b672bf67`
- 备份：`output/android-compat-20261008/baseline/`，包含分支、HEAD、status、tracked/staged binary diff、untracked 清单、7,600 个原文件及 SHA-256。
- 既有未提交变更保持原样，以备份逐文件对比区分本轮修改。备份和用户数据不上传 GitHub。
- Android：minSdk 24 / targetSdk 36 / compileSdk 36；原版本 1.0.80 (86)，原 debug 签名升级路径。
- 真机：BTK-W00，Android 12 / API 31，1440×2200，density 300；华为 WebView 114.0.5.302。
- 主机：16 GB RAM，初始空闲约 2.4 GB；没有 emulator/system-images/AVD；固件虚拟化报告 False。模拟器不得与真机证据混淆。

## 风险分级与最小实施范围

| 等级 | 位置 | 模块/环境 | 根因或待验证风险 | 处理/验证 | 业务影响 |
|---|---|---|---|---|---|
| P1 | AndroidManifest.xml | Android 11+ 发音 | 使用 TextToSpeech，但没有 TTS_SERVICE queries | 按 Android 官方要求添加包可见性声明；检查合并 Manifest、真机引擎日志 | 不改变发音策略 |
| P1 | AnnotationToolbar.jsx | 完形/写作的浮动工具、旋转/分屏 | 折叠工具位置只在拖动时约束；窗口变小可能失去入口 | 先复现拖动→缩窗，再监听可见窗口变化重新限位 | 保持工具/擦除/笔迹语义 |
| P1 | AiFloatWindow.jsx | AI 悬浮按钮、软键盘 | 使用 innerHeight、只监听 window.resize，不能完整处理 visualViewport | 测试可见窗口缩小时按钮可达性，复用小型几何辅助函数 | 不发请求、不改 Provider/消息 |
| P2 | AnnotationToolbar.jsx | 粗细滑块、鼠标/笔 | 未捕获指针，离开轨道抬笔可能残留拖动状态 | 真实输入事件测试拖出后抬笔；捕获/取消统一结束 | 只修手势收尾 |
| P1 | vite.app.config.js / 依赖 | 老 WebView | ES2022 及现代 DOM/CSS 不能由 minSdk 24 推出支持范围 | 核实 legacy PDF.js、检测 WebView；测试缺少可选 API 的降级；未测试版本单列 | 不擅自提高 minSdk |
| P1 | Shared Ink Runtime / durable storage | 所有笔迹表面 | 旋转、取消、缩放、后台保存的跨设备风险 | 已有 Node/E2E + 新增窗口与输入回归 + Android WebView | 不重写引擎、不改存储 |
| P2 | CSS / iframe / 弹窗 | 9 个窗口矩阵、字体/DPR | 需渲染检查溢出、遮挡、操作可达性 | 先测再修实际失败，保留原视觉与导航 | 不隐藏功能 |
| P2 | AndroidFileSaver | API 24–28 | 旧版保存到 App 外部专属目录，非公共 Download | 报告实际范围；不为兼容性新增广泛文件权限 | 现有路径保留 |
| P1 | 云端测试 APK | 私人 PDF/范文/凭据 | 正式 APK 不等于无私人内容的测试包 | 未授权不上传；提供独立合成样例接入步骤与命令 | 云端标记 BLOCKED |

## 顺序与业务契约自检

1. 保存安全基线，运行原 `test:all` 和 `test:e2e`，保存日志。
2. 在原构建上运行新增测试，记录复现结果；仅修明确问题。
3. 测试九个窗口：390×844、544×832、832×544、600×960、960×600、800×1280、1280×800、1024×640、1600×900。使用独立浏览器账号、截图、边界与 console 记录。
4. 补充旋转/缩窗、DPR、字体、键盘、浮动工具、笔迹恢复验证；合成事件不作为真实压感/掌触抑制证据。
5. 运行现有回归、发布门禁、生产构建、Capacitor sync、APK 校验。
6. 真机升级前备份私有文件与安装包、核对证书；覆盖安装后首次启动前比较哈希；启动后核对账号/学习数据、横竖屏和后台恢复。
7. 更新两份文档 PDF 并检查渲染，生成最终验收报告与证据索引，提交并推送对应 GitHub 仓库。

不改变 applicationId、数据库结构、账号隔离、七阶段规则、词汇 Source of Truth、手写坐标格式或 AI 计费行为。不使用子智能体。

## 官方依据

- [Adaptive App Quality](https://developer.android.com/docs/quality-guidelines/adaptive-app-quality)：Tier 2 是优化目标，未经完整清单/设备验收不作达标声明。
- [TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech)：Android 11+ TTS 服务包可见性要求。
- [Firebase Test Lab 配额和价格](https://firebase.google.com/docs/test-lab/usage-quotas-pricing)：需先核实项目授权和额度。
- [BrowserStack App Live](https://www.browserstack.com/docs/app-live)：交互式云端真机；库存需运行前查询。
