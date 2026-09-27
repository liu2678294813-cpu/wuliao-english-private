# 单词升级：实现、验证与回退

## 行为

- 背词：默认/循环与点击/滑动组合。默认一次遮挡；循环黑、白、黑、白、锁定。点击与滑动共用规则进度，规则之间隔离。
- 黑线支持撤销与清除；历史完成日期保留，今日完成数按单词去重。复习答错重置两个模式的遮挡进度。
- 筛查：保留选择模式，新增手写模式，每批20词，保持76px行高。复用 WritingInkSurface 和 AnnotationToolbar，未修改原笔画处理算法。
- 识别仅在点击时读取新笔迹；键盘文字不自动识别。识别请求只含匿名图片编号和笔迹，不含英文、标准释义。
- 对照单独调用应用内文本AI；同义词可接受，空白/不确定不归类。正确/错误分别写入既有 wordLists 的 familiar/raw 类型。
- 同一来源、轮次的手写结果归入可正常学习的对应词表；改判只修正本轮生成的记录。wordLists/wordRecords 在一个 IndexedDB 事务中提交，稳定答案ID确保重试不重复添加。
- 内容修改会中止尚未提交的过期归类事务。延迟AI结果核对账号、会话、答案版本和笔迹指纹。没有实时AI请求在书写/滚动/切换模式时产生。

## 存储与兼容

- 不升级现有三个数据库版本。新增 WuliaoVocabHandwritingDB v1，answers 保存释义、识别/对照状态，sessions 保存批次位置。
- 笔迹继续保存到 wuliao-english/writing-ink，增加 `vocabulary:` surface 身份；不冒用写作练习记录。
- 新增数据纳入应用完整备份。现有备份格式不变，同账号合并恢复，保留设备已有记录。
- 背词记录新增 modeProgress，保留 legacyClickCount；旧已完成记录映射为默认已遮挡，旧未完成记录的新模式从可见开始。
- 此次识别与对照使用用户现有应用AI设置；未创建密钥，未将密钥写入源码或传给词汇 iframe。

## 验证方式

2026-09-19 最终验证：完整回归测试 1,137 项、浏览器端到端 8 项、音频处理回归 3 项全部通过。浏览器覆盖首次备份后手写保存、真实 Ogg 播放到结束、快速切词、设备美音兜底和多音词默认文件选择。源码目录与构建产物中的 6,547 个音频均通过独立发布文件核对。

发音首尾审计发现旧生成流程包含两层非零阈值裁剪。弱信号不能仅靠振幅认定为噪声，因此最终发音资产已关闭合成器 `trim` 和二次阈值裁剪，保留全部原始合成波形，再做增益调整、编码及全库校验。旧裁剪版文件未纳入本次交付。

- 单元/回归：`corepack pnpm run test:all`；新增模式测试已纳入。
- 浏览器：先 `corepack pnpm build`，再启动 `corepack pnpm exec vite preview --config vite.app.config.js --host 127.0.0.1 --port 5199 --strictPort`，另一个终端运行 `corepack pnpm exec playwright test --config e2e/vocabulary-upgrade.config.mjs`。
- AI端到端使用隔离测试账号、假密钥及拦截响应，验证真实请求/存储流程。它不证明用户所选模型的实际中文手写识别准确率。
- 内置Browser启动返回 `privileged native pipe bridge is not available; browser-client is not trusted`，使用项目现有 Chrome/Playwright 自动化测试。
- 实际触控笔硬件、掌压与 Android APK 未验证，本次未重新打包APK。
- 截图和测试日志位于项目 output/，不纳入源码提交。

## 发音交付与质量证据（2026-09-19）

- 磁盘可读取的内置词库共 6,515 个不同拼写，全部有固定美音 `af_heart` 音频，生成速度参数为 0.95。私人浏览器导入词库无法从项目目录读取，未覆盖的新词仍使用设备美音朗读。
- 共有 6,547 个不同 Ogg 文件：6,515 个基础读音和 32 个词性变体。20 个词根据词库首要释义选择变体作为默认，原基础读音留存溯源；因此清单的 6,567 条记录不能当作不同文件数。
- 本批全部为本地 Kokoro 合成。Commons 原始录音请求持续返回 429，旧裁剪版录音未混入交付。
- 明确关闭合成器内部裁剪，也不使用额外振幅阈值裁剪。每个文件保存原始、保留、输出样本数和首尾补白信息；原始 FLOAT WAV 保存在独立发音素材工作目录中，不发布网站。
- 最终逐文件检查了原始 WAV 和 Ogg 的 SHA256、解码、采样率、完整样本数、非静音、时长和峰值。6,547 个文件全部通过；最大解码峰值 0.989952（低于满幅 1），时长 0.87–2.12 秒，原始波形与 Ogg 对应区间最低相关度 0.983245。Ogg 为有损编码，不声称逐样本数值相同。
- 对 75 个异读词进行了中文首义、G2P 和词典音素核查。核查记录、默认选择及仍有歧义的 13 个词位于发音资产的 `docs/audit/`。这不是全库人工听审，不声称每个词义、时态的读音均已覆盖。
- 发布清单带音频内容校验标识；播放器重新验证清单，并以内容标识区分缓存。`scripts/verify-pronunciation-assets.mjs` 对实际发布文件和构建后的副本核对清单、路径、缓存标识及全部文件 SHA256。

可重复检查：`node scripts/verify-pronunciation-assets.mjs`；构建后执行 `node scripts/verify-pronunciation-assets.mjs dist/vocabulary/pronunciation`。音频维护脚本、依赖和许可说明位于 `scripts/audio/`。

## 回退基线

本地基线标签：`rollback/vocabulary-before-20260915`

本地基线提交：`ec5d51ed3cd9853d20cf5cf6a8e8046e21a4cff8`

本次功能分支：`codex/vocabulary-modes-handwriting-20260915`

发布前线上版本：7

Sites project_id：`appgprj_6a6de59c835881919fd6101b295d1360`

旧 version_id：`appgprj_6a6de59c835881919fd6101b295d1360~appgver_993ac50a81d88191b341e111454ba905`

旧部署：`appgdep_6a6e25ced6f48191be625763e31ea6af`

旧源码提交（按 Sites/Git 返回原值保存）：`8e37d675b39811ce4d7626bae83524e8a560d687`

### 恢复代码/网站

1. 当前工作树有未提交内容时先保存，避免覆盖后续修改。
2. 要恢复本地本次修改前版本：`git switch -c codex/restore-vocabulary-before rollback/vocabulary-before-20260915`。此操作保留功能分支与所有提交，不使用 hard reset。
3. 要恢复本次发布前的网站，使用 Sites 的旧 version_id 重新部署，保持原访问权限。旧线上版本为8月版本；它与9月本地基线不同，不能混为一谈。
4. 需要保留当前其他功能、仅撤回本次升级时，应按本次功能提交逆序 revert，再构建和部署。

### 恢复学习数据

代码回退不会清空浏览器的学习数据，也不会自动撤销已归类单词。发布文件不包含个人浏览器数据。

如需数据恢复，先使用应用设置中的完整备份功能保存当前数据，再按同账号合并恢复。恢复不覆盖已有冲突记录。旧代码无法显示新手写界面，但新数据仍保留，切回新版本可继续读取。

源码发布时保留旧Sites分支历史；8月旧版本的页面改动不覆盖当前9月工作树。
