# 安卓交互修复 1.0.68（versionCode 74）

## 实现与原因

使用当前源码实现，保留新版背词四种模式、手写筛选与发音功能，沿用数据库、账号隔离和备份格式。

1. **圈删**：笔迹包围盒提前排除不相交项；投影坐标按笔迹和布局缓存；删除统一提交一次；精读页只清理、重绘受影响区域，并跳过区域外笔迹；保存复用未变笔迹的序列化结果。只减少命中候选还不足以达标，局部重绘才消除了密集页面重画整块的主要开销。整笔删除语义、长按时间和笔形保持一致。
2. **筛查**：可读的 `screening-controller.js` 管理整题状态，英文、选项与进度共同发布。点击立即锁题并反馈，答题记录、进度和混淆词在事务中保存；失败留在原题，重试不会重复记账。预取下一题，保存成功后才切换；会话版本和取消定时器阻止旧请求覆盖。错误纠正从反馈首次绘制机会起等待一秒；自动读音跟随已提交显示的题目。
3. **背词及离页**：按词排队保存，立即更新对应词行；失败移除失败操作并重放后续操作，避免旧回调覆盖新状态。今日计数增量维护，进入、跨日和外部变化时核对。通信桥按请求标识等待保存完成，再执行导航；同文档复用页面并合并重复导航。

补丁脚本可重复执行，找不到唯一替换位置即失败；构建额外检查生成的 JavaScript 语法，避免两个补丁重复插入导入语句。

## 验证结果

设备为 Huawei BTK-W00 / Android 12。压力数据使用独立包 `com.wuliao.english.latencyqa`，词库 1,735 词；未向正式账号写入压力测试记录。

| 场景 | 样本数 | 真机 Event Timing P95 | 结果 |
| --- | ---: | ---: | --- |
| 筛查点击反馈 | 100 | 40 ms | 1,875 次动画帧检查，英文与选项不一致 0 次 |
| 背词记录 | 60 | 56 ms | 60 条记录、遮挡计数及滚动位置重新加载后恢复 |
| 100 条笔迹圈删 | 20 | 64 ms | 目标像素清除、续写、撤销及重新加载通过 |
| 1,000 条笔迹圈删 | 20 | 72 ms | 同上 |
| 3,000 条笔迹圈删 | 20 | 72 ms | 同上 |

另测 5 次答错反馈到下一题显示，分别约 1,023、1,021、1,026、1,022、1,025 ms；乱序开关保持当前题。报告原有 `correction` 字段包括测试驱动轮询开销，准确的逐帧纠错停留值见 `correctionVisibleMs`。

计时口径：Event Timing 是实际平板 WebView 接收事件至下一次绘制的浏览器指标，有量化精度限制。圈删从抬笔提交开始计算，不包含画圈及长按；点击反馈不包含冷启动或一秒纠错停留。另存输入排队、计算、保存与 `paintOpportunity` 指标，后者只是绘制机会代理值，未当作屏幕实测。没有高速相机测量触笔采样到屏幕发光的全链路延迟，因此不能把上述结果等同于物理端到端延迟。

压力笔迹每条 80 点，含圈选外笔迹及可见目标；不代表所有笔形、整页全重叠笔迹或任意大小手写文档。这里的“恢复”是离页和页面重新加载后的持久化验证，不是断电故障测试。屏幕像素检查针对圈删目标区域；题目同步检查按动画帧观察 DOM，不是外部摄像逐帧录像。

- 全量自动回归：**1,148 / 1,148**，见 `output/interaction-regressions-final.log`。
- 浏览器交互：**6 / 6**，见 `output/interaction-browser-final.log`。覆盖连续 100 题、双击、1,735 词行局部更新、真实 IndexedDB 事务中止和重试、自动读音、四种背词模式、手写筛选。
- 异步竞争、慢保存、过期初始化、离页、重复提交与按词失败重放由可控异步自动测试覆盖；没有把模拟故障称为真机存储硬件故障。
- 原始真机数据：`output/interaction-device/vocabulary-results.json`、`ink-results.json`；同目录保留筛查、背词与各档圈删截图。

## 三个可直接复查的操作

1. 精读页圈掉一笔后立即写字、撤销，再离页返回：被圈中的整笔消失，后写笔迹能正确撤销。
2. 筛查连续点两次同一选项：只记录一次；答错能看到约一秒纠错，下一题的英文和中文选项一起改变。
3. 背词快速记录不同单词：每词立即更新计数和遮挡；返回页面仍保留进度与滚动位置。保存失败提示后重试，不会影响其他词已完成的记录。

## 安装与回退

已完成正式包覆盖升级，设备确认版本 1.0.68 / 74。安装后首次启动前，72 个原数据文件 SHA-256 全部一致；启动后页面加载完成，根节点、按钮和可见布局正常。正式账号未执行答题、记录或删笔压力操作。

交付 APK：`output/android/wuliao-english-1.0.68.apk`，常用路径同步为 `output/android/wuliao-english-android.apk`。构建日志为 `output/interaction-release-build.log`，校验值见同目录 `wuliao-english-1.0.68.sha256.txt`。

覆盖升级前已停止旧版并保存：

- `output/interaction-upgrade-backup/wuliao-english-1.0.67.apk`：原安装包。
- `output/interaction-upgrade-backup/app-data-before-1.0.68.tar`：原应用私有数据备份，24,892,416 字节。
- `output/interaction-upgrade-backup/data-manifest.json`：72 个原数据文件的 SHA-256。
- `output/interaction-upgrade-backup/upgrade-result.json`：覆盖升级版本与首次启动前逐文件一致性结果，安装脚本成功后生成。

如需回退，在本项目 PowerShell 中运行以下命令，保留应用数据，不先卸载：

```powershell
& .\.android-sdk\platform-tools\adb.exe shell am force-stop com.wuliao.english
& .\.android-sdk\platform-tools\adb.exe install -r -d .\output\interaction-upgrade-backup\wuliao-english-1.0.67.apk
& .\.android-sdk\platform-tools\adb.exe shell am start -n com.wuliao.english/com.wuliao.english.MainActivity
```

若设备拒绝降级，保留当前应用和备份，再处理签名/版本限制；不要通过卸载或清空数据绕过。私有数据归档用于同设备恢复，不宣称可跨设备直接恢复加密凭据。
