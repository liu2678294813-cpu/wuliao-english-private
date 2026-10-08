# 发音资产维护（pipeline v2：完整波形）

## 默认行为

`generate_audio.py` 默认 `--trim-policy preserve`：

- 固定默认美音声线 `af_heart`、速度 `0.95`。
- 调用 Kokoro 时明确 `trim=False`，关闭库内部的静音裁剪。
- 不对输出进行任何阈值裁剪，不丢弃模型返回的样本；阈值仅用于测量音量。
- 规范增益，前后分别补40ms/80ms静音；Ogg编码后再次测峰值，必要时衰减重编码使峰值低于0.99。
- 保存 `.raw/*.wav`（FLOAT原始波形）和 `.checkpoints/*.json` 作为本地质检/续跑文件，不发布网站。
- 每条清单记录 `rawSampleCount`、`retainedRawSampleCount`、`outputSampleCount`、`sampleRate`、`trim:false`、`normalizationGain`、`paddingSamples`、原始/发布文件 SHA256 与 `pipelineVersion:2`。

`--trim-policy legacy` 只供复现旧版比较：库内60dB静音裁剪后按峰值0.006/绝对0.001阈值，前60ms后120ms余量。旧版可能删除弱尾部非零信号，不作为正式交付默认。

## 环境与模型

已验证环境：Windows、Python 3.13.2、CPU ONNX Runtime。包版本锁定在 `requirements.txt`；可放到独立虚拟环境或 `pip --target` 目录。Linux/macOS的二进制轮子需使用适合当地Python/平台的版本，未宣称跨平台测试通过。

```powershell
python -m pip install --target <runtime目录> -r <脚本目录>/requirements.txt
```

模型和声线下载URL、文件大小、SHA256在 `model-info.json`。模型约325 MB、声线约28 MB，**不放进Git或站点资源**。下载后核对SHA256。

Windows eSpeak 的文件接口不能可靠读取中文路径，且phonemizer会解析掉普通路径别名。若数据目录含中文，可把资产工作目录临时映射到一个空闲ASCII盘符，例如：

```powershell
subst R: <资产工作目录>
```

然后传 `--espeak-data-path R:/runtime/espeakng_loader/espeak-ng-data`。生成器只对明确传入且含 `phontab` 的路径绕过解析，不自动占用盘符。其他平台或原本全ASCII路径可省略此参数。任务结束、确认无进程使用后执行 `subst R: /D`。

## 生成与续跑

以实际路径替换尖括号。建议先生成到独立staging目录，通过验证后再复制发布资源。

```powershell
python <脚本目录>/generate_audio.py --source-dir <项目>/public/vocabulary/assets --output-dir <资产工作目录>/uncut-release --model <模型目录>/kokoro-v1.0.onnx --voices <模型目录>/voices-v1.0.bin --runtime-dir <runtime目录> --espeak-data-path R:/runtime/espeakng_loader/espeak-ng-data --workers 4 --threads 2 --variant-config <脚本目录>/phoneme-variants.json
```

也可用 `--words-file <words.json>` 替换 `--source-dir`，JSON格式为包含 `english` 字段的数组。所有目录都由参数传入，脚本没有用户机器的固定绝对路径。

重新执行同一命令会检查已有文件的SHA256和处理策略后复用已完成单词；中断时最多重做没有有效检查点的词。新模型/声线或新的处理算法应使用新的输出目录，不混用旧缓存。当前词性配置有47条变体。

可选 `--recorded-sources <脚本目录>/recorded-sources.json` 尝试优先下载已审核的真实录音。仅包含真实验证过的abandon原始来源及CC BY-SA许可元数据。遇429立即停止录音下载并用本地合成补齐；不能把元数据存在当作已下载成功。正式v2批次因429全部使用Kokoro，**不再携带旧裁剪的abandon录音**。

## 验证

```powershell
python <脚本目录>/validate_audio.py --output-dir <资产工作目录>/uncut-release --runtime-dir <runtime目录> --require-raw
```

验证：完整词数、每文件SHA256/解码/时长/峰值/非静音，v2的输出样本数严格等于原始样本数加padding，以及本地原始WAV的hash/样本数/采样率。原始波形与Ogg解码后相应区间做相关度核查，避免明显偏移或丢段；报告最小相关度和最低10个样本。Ogg为有损编码，因此不要求逐样本相等。`--repair-peaks` 只用于修正编码过冲，更新相关元数据和检查点。

失败退出码为1。最终结果在 `validation.json`；这不是人工听审，也不能证明模型每个音素都读对。

## 发布文件

只复制 `index.json`、`manifest.json`、`variants.json`、`audio/`、`licenses/`、`docs/audit/`、`AUDIO-CREDITS.md`、`model-info.json`、`validation.json`。`index.json`供播放端读取，完整manifest用于许可/出处详情。目录下 `.raw/`、`.checkpoints/`、模型、runtime、生成日志均留在本地。

归一化英文键为 `trim().toLowerCase()`；调用方明确传入词性时先查 `index.variants[word][noun|verb|adjective]`，未传词性时先按 `index.defaultPos[word]` 选择词性变体，再退回 `index.entries[word]`。`record` 等无默认词性选择的异读词继续使用基础音频；未覆盖的私人导入词和浏览器不支持Ogg的情况继续使用设备美音朗读兜底。

34词47变体的美式发音配置保留了ARPABET、词典来源和许可信息。调用方传入词性时优先选择对应变体；省略词性时按已审核的`index.defaultPos`选择默认变体。`record`仍保留歧义基础音频。完整保留模型波形解决了处理阶段截音风险，但自动转写和信号校验不能替代人工英语听审。

## 发布清单与缓存版本

最终验证后执行 `python <脚本目录>/build_catalog.py --output-dir <资产工作目录>/uncut-release`。每个播放条目都带 `revision = sha256[:16]`，请求音频时附加 `?v=<revision>`，播放清单请求使用 `cache: no-cache`，避免同一单词文件名在更新音频后命中旧缓存。生成中的目录可使用验证器的 `--allow-partial` 做只读快照检查；完整发布必须不带该选项通过全量校验。

## 完成后的固定顺序

在生成进程正常结束、输出 `complete 6515 / 6515` 后依次执行：

1. `python <脚本目录>/apply_defaults.py --output-dir <完整输出目录> --words-file <完整输出目录>/words.json`：依据已经审核的中文释义和字典音素应用33个默认覆盖，其中75个异读候选中25个有明确词性选择；仍有10个词保留歧义说明。每条清单显示实际默认音频，并将被替换的33条base放到 `basePronunciations` 留存溯源，不修改任何原始WAV或生成检查点。
2. `python <脚本目录>/validate_audio.py --output-dir <完整输出目录> --runtime-dir <runtime目录> --require-raw`：全部文件校验，报告绑定当时manifest/variants的SHA256。需要修复过冲时显式加 `--repair-peaks`，之后重新验证。
3. `python <脚本目录>/build_catalog.py --output-dir <完整输出目录>`：按最终实际默认文件生成path/revision。
4. `python <脚本目录>/package_audio.py --output-dir <完整输出目录> --zip-path <目标zip文件>`：要求验证报告与当前清单hash一致、覆盖完整、全部文件通过，输出CRC检查过的zip及SHA256。

33项选择仅针对已核对的内置词库中文释义。词库释义改变时应用工具会要求重新审核，不静默猜测新词性。显式POS依旧优先于默认选择。

完整目录的6515个默认条目、47个词性变体和33个保留base共6595条溯源记录；其中默认选择与变体有重复路径，实际只有6562个不同音频文件。验证和打包按路径去重，分别报告记录数与真实文件数，不把重复记录当作新增音频。

## 快速回归测试

在安装依赖的Python环境执行 `python <脚本目录>/test_audio_pipeline.py`；若依赖装在独立目录，可先设置 `AUDIO_RUNTIME_DIR`。测试不加载模型，检查很弱的首尾样本没有被移除、原始输入未被修改、原始WAV精确保留、输出样本数/峰值和有效缓存不会重新合成。

## 已有批次只补词性变体

`generate_variants_only.py` 接受 `--output-dir --model --voices --variant-config --runtime-dir --espeak-data-path`，在独立目录生成指定变体及原始WAV，不触碰正在运行的完整批次。每个变体可在配置中选填 `voice`；未填写时沿用命令行 `--voice`。完整批次生成结束后可用 `merge_variants.py --output-dir <完整输出目录> --extras <补充目录1> <补充目录2>` 合并清单及文件，重新执行默认选择、全量验证和打包。
