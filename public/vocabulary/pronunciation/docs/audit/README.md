# 异读词与读音复核（75词）

这是词库中文首义、默认读音和字典音素的比对，并纳入全量音频自动筛查结果；**不是人工逐条听审报告**。ASR差异仅作候选，不能单独证明读音错。

- 全词表共有33个显式默认读音选择；75个异读候选中25个有明确默认选择，10个仍保留歧义标记。47条词性变体使用美式读音音素；address/decrease/estimate/increase 均有名词与动词变体。appal/appall 的标准美音为 /əˈpɔːl/，参照 CMUdict 对 appall 的 AO1 记录及 Oxford 对 appal/北美拼写 appall 的说明。
- affect、ashore、appal、appall、fox、clasp、clout、laugh、mouth 曾出现自动转写近音词；按词典音素重制或调整声线，原始默认音频留存到 `basePronunciations`。
- 默认合成声线为 af_heart；clasp、clout、laugh 的逐词变体使用 af_bella，mouth 使用 af_sarah。音频清单记录每个文件实际声线。
- 未覆盖候选 converse、incense、use：当前可读取词库无这些拼写。
- 明确保留歧义：conflict, contrast, export, import, insult, progress, protest, record, transfer, transport。
- lead/read/wind/tear/resume/invalid 的当前读音与首义匹配；read 过去式、lead 金属、wind 缠绕、tear 撕裂、resume 简历等别义仍需上下文。
- [CMUdict 来源](https://github.com/cmusphinx/cmudict)；[alternate 的 Cambridge 美音/英音及词性对照](https://dictionary.cambridge.org/us/pronunciation/english/alternate)。

## 逐词记录

“保留”只表示本次文字核对未发现明确冲突；不代表声学验证了正确发音。

| 单词 | 来源中文 | 原自动音素 | 决定 |
|---|---|---|---|
| absent | 缺席的；缺席；不参加 | ˈæbsənt | 首义匹配，保留base |
| abstract | 抽象的；非具体的；深奥的 | ˈæbstɹækt | 首义匹配，保留base |
| accent | 口音；腔调；强调 | ˈæksənt | 首义匹配，保留base |
| address | 地址；网址；演说 | ɐdɹˈɛs | 默认 noun /ˈædres/；verb /əˈdres/ 变体 |
| advocate | 提倡；主张；提倡者 | ˈædvəkˌeɪt | 首义匹配，保留base |
| affect | 影响；感动；假装 | ɐfˈɛkt | 默认 verb /əˈfekt/；按词典音素重合成 |
| alternate | 交替的；轮流的；间隔的 | ɔːltˈɜːnət | 默认 adjective / ˈɔltəɹnət |
| appropriate | 适当的；恰当的；拨出 | ɐpɹˈoʊpɹɪət | 首义匹配，保留base |
| associate | 把联系在一起；与交往；同事 | ɐsˈoʊsɪˌeɪt | 首义匹配，保留base |
| attribute | 由引起；把归因于；认为是创作的 | ˈætɹɪbjˌuːt | 默认 verb / ətɹˈɪbjˌut |
| close | 关闭；使接近；接近的 | klˈoʊs | 默认 verb / klˈoʊz |
| compact | 紧密的；小型的；协定 | kəmpˈækt | 首义匹配，保留base |
| compound | 化合物；大院；复合的 | kˈɑːmpaʊnd | 首义匹配，保留base |
| compress | 压缩；压榨；外科 | kəmpɹˈɛs | 首义匹配，保留base |
| conduct | 实施；表现；指挥 | kˈɑːndʌkt | 默认 verb / kɑndˈʌkt |
| conflict | 冲突；矛盾；抵触 | kˈɑːnflɪkt | 歧义，保留base |
| console | 安慰；慰问；控制台 | kˈɑːnsoʊl | 默认 verb / kənsˈoʊl |
| content | 内容；含量；目录 | kˈɑːntɛnt | 默认 noun / kˈɑntɛnt |
| contest | 比赛；竞赛；竞争 | kˈɑːntɛst | 首义匹配，保留base |
| contract | 合同；契约；使 | kˈɑːntɹækt | 默认 noun / kˈɑntɹˌækt |
| contrast | 对照；反差；对立 | kˈɑːntɹæst | 歧义，保留base |
| convict | 定罪；宣判有罪；罪犯 | kˈɑːnvɪkt | 默认 verb / kənvˈɪkt |
| coordinate | 协调；使配合；搭配 | koʊˈɔːɹdᵻnət | 默认 verb / koʊˈɔɹdənˌeɪt |
| decrease | 减少；降低 | dˈiːkɹiːs | 默认 verb /dɪˈkriːs/；noun /ˈdiːkriːs/ 变体 |
| defect | 毛病；缺陷；叛逃 | dˈiːfɛkt | 首义匹配，保留base |
| delegate | 委派；授权；代表 | dˈɛlɪɡˌeɪt | 首义匹配，保留base |
| deliberate | 深思熟虑的；故意的；深思熟虑 | dᵻlˈɪbɚɹət | 首义匹配，保留base |
| desert | 沙漠；荒漠；抛弃 | dˈɛzɚt | 首义匹配，保留base |
| digest | 摘要；文摘；消化 | daɪdʒˈɛst | 默认 noun / dˈaɪdʒɛst |
| discharge | 放出；排出；开除 | dɪstʃˈɑːɹdʒ | 首义匹配，保留base |
| discount | 折扣；贴现率；打折扣 | dˈɪskaʊnt | 首义匹配，保留base |
| document | 文件；公文；文献 | dˈɑːkjuːmənt | 首义匹配，保留base |
| duplicate | 复制；复印；再做一次 | dˈuːplᵻkˌeɪt | 首义匹配，保留base |
| elaborate | 精心制作；详尽阐述；精心制作的 | ᵻlˈæbɚɹˌeɪt | 首义匹配，保留base |
| entrance | 入口；进入；到场 | ˈɛntɹəns | 首义匹配，保留base |
| estimate | 估算；估价 | ˈɛstᵻmət | 默认 verb /ˈes.tə.meɪt/；noun /ˈes.tə.mət/ 变体 |
| excuse | 饶恕；借口；致歉 | ɛkskjˈuːs | 默认 verb / ɪkskjˈuz |
| export | 输出；出口 | ˈɛkspɔːɹt | 歧义，保留base |
| extract | 提取物；摘录；精华 | ˈɛkstɹækt | 首义匹配，保留base |
| frequent | 频繁的；经常发生的 | fɹˈiːkwənt | 首义匹配，保留base |
| graduate | 大学毕业生；学士学位获得者；毕业 | ɡɹˈædʒuːət | 首义匹配，保留base |
| house | 房子；房屋 | hˈaʊs | 首义匹配，保留base |
| impact | 冲击；力；影响力 | ˈɪmpækt | 首义匹配，保留base |
| import | 进口；输入；重要性 | ɪmpˈɔːɹt | 歧义，保留base |
| increase | 增加；增长；增多 | ˈɪŋkɹiːs | 默认 verb /ɪnˈkriːs/；noun /ˈɪŋkriːs/ 变体 |
| insult | 侮辱；辱骂 | ˈɪnsʌlt | 歧义，保留base |
| intimate | 亲密的；私密的 | ˈɪntᵻmət | 首义匹配，保留base |
| invalid | 无效的；作废的；病弱者 | ɪnvˈælɪd | 首义匹配，保留base |
| lead | 领导；带领；导致 | lˈiːd | 首义匹配，保留base |
| live | 生活；居住；活着 | lˈaɪv | 默认 verb / lˈɪv |
| minute | 分钟；一会儿；微小的 | mˈɪnɪt | 首义匹配，保留base |
| moderate | 中等的；适度的；温和的 | mˈɑːdɚɹət | 首义匹配，保留base |
| object | 物体；目的；对象 | ˈɑːbdʒɛkt | 默认 noun / ˈɑbdʒɛkt |
| perfect | 完备的；完美的；使完美 | pˈɜːfɛkt | 首义匹配，保留base |
| permit | 允许；准许；通行证 | pˈɜːmɪt | 默认 verb / pəɹmˈɪt |
| present | 目前；礼物；在场的 | pɹˈɛzənt | 默认 noun / pɹˈɛzənt |
| produce | 生产；生育；制造 | pɹədˈuːs | 默认 verb / pɹədˈus |
| progress | 进展；进步；缓慢前进 | pɹˈɑːɡɹɛs | 歧义，保留base |
| project | 计划；方案；项目 | pɹˈɑːdʒɛkt | 默认 noun / pɹˈɑdʒɛkt |
| protest | 抗议；抗议活动 | pɹˈoʊtɛst | 歧义，保留base |
| read | 读；阅读 | ɹˈiːd | 首义匹配，保留base |
| rebel | 反抗；造反；叛逆者 | ɹˈɛbəl | 默认 verb / ɹɪbˈɛl |
| record | 记录；唱片；录制 | ɹˈɛkɚd | 歧义，保留base |
| refuse | 拒绝；不接受；废料 | ɹᵻfjˈuːz | 首义匹配，保留base |
| reject | 拒绝；驳回；被拒之人 | ɹᵻdʒˈɛkt | 首义匹配，保留base |
| resume | 中断后；继续；重新开始 | ɹᵻzˈuːm | 首义匹配，保留base |
| separate | 分开的；分离的；单独的 | sˈɛpɹət | 首义匹配，保留base |
| subject | 主题；话题；学科 | sˈʌbdʒɛkt | 默认 noun / sˈʌbdʒɪkt |
| suspect | 猜想；怀疑；嫌疑犯 | sˈʌspɛkt | 默认 verb / səspˈɛkt |
| tear | 眼泪；泪水；撕裂 | tˈɪɹ | 首义匹配，保留base |
| transfer | 转移；转让；调任 | tɹˈænsfɜː | 歧义，保留base |
| transport | 运输 | tɹˈænspɔːɹt | 歧义，保留base |
| upset | 推翻；打乱；使心烦 | ʌpsˈɛt | 首义匹配，保留base |
| wind | 风；蜿蜒；缠绕 | wˈɪnd | 首义匹配，保留base |
| wound | 伤口；创伤；使受伤 | wˈuːnd | 首义匹配，保留base |

## 默认读音来源

- [address（美音名词/动词）](https://dictionary.cambridge.org/us/dictionary/english/address)
- [decrease（美音动词/名词）](https://dictionary.cambridge.org/us/dictionary/english/decrease)
- [estimate（美音动词/名词）](https://dictionary.cambridge.org/us/dictionary/english/estimate)
- [increase（美音动词/名词）](https://dictionary.cambridge.org/us/dictionary/english/increase)
- [affect（美音动词）](https://dictionary.cambridge.org/us/dictionary/english/affect)
- [ashore（美音）](https://dictionary.cambridge.org/us/dictionary/english/ashore)
- [appall（美音；英式拼法 appal）](https://dictionary.cambridge.org/us/dictionary/english/appall)；[Oxford 对 appal 与北美拼写 appall 的说明](https://www.oxfordlearnersdictionaries.com/us/definition/english/appal)
- [fox（美音）](https://dictionary.cambridge.org/us/dictionary/english/fox)
- [clasp（美音）](https://dictionary.cambridge.org/us/dictionary/english/clasp)
- [clout（美音）](https://dictionary.cambridge.org/us/dictionary/english/clout)
- [laugh（美音）](https://dictionary.cambridge.org/us/dictionary/english/laugh)
- [mouth（美音名词）](https://dictionary.cambridge.org/us/dictionary/english/mouth)

## 自动音频筛查中重生成的条目

自动筛查先对6,547个旧音频做批量ASR，再将704个错词/漏词候选逐条单音频识别；其中243个候选在基础模型单条复核时还原为预期单词。小型模型又复核其中461个候选，56个转写成预期单词。首轮ASR差异都只是候选，不单独证明读错。

新增的15个词性变体不在旧批次中，另以基础与小型模型逐条转写：基础模型8/15、小型模型10/15 转写成目标拼写；affect、ashore、appal、appall、fox 两种模型仍都转写成近音词。clasp 与 mouth 两种模型均转写成目标词，clout 与 laugh 只有小型模型转写成目标词。机器转写仍不能确认重音和每个音素。

### 全量逐文件复核（2026-10-05）

对当前发布清单的6,562个不同Ogg逐个、单文件运行 Whisper small（CPU/int8）：目标拼写归一化匹配5,597个；转写不一致965个，均列为复听候选；解码失败0个、空转写0个。逐条识别记录与当前发布Ogg的SHA256为6,562/6,562精确匹配，且路径无缺失、无多余、无重复。appal/appall 两个修正后的音频均按最终哈希重新识别；模型仍转写为 “Apollo”（置信度0.491），这只是近音筛查结果，不构成音素判错。**完整人工逐条听审未完成**，机器拼写匹配也不能证明重音、元音细节和整体清晰度。

按目标词典音素显式合成或修订的读音如下：

| 单词 | 词典目标音标 | 处理 |
|---|---|---|
| affect | /əˈfekt/ | 动词默认；保留旧base |
| ashore | /əˈʃɔːr/ | 副词默认；保留旧base |
| appal / appall | /əˈpɔːl/ (`AH0 P AO1 L`) | 动词默认；按字典音素更正 /ɑ/ 为 /ɔ/ 并重制；分别保留旧base |
| fox | /fɑːks/ | 名词默认；保留旧base |
| clasp | /klæsp/ | 动词默认；af_bella声线；保留旧base |
| clout | /klaʊt/ | 名词默认；af_bella声线；保留旧base |
| laugh | /læf/ | 动词默认；af_bella声线；保留旧base |
| mouth | /maʊθ/ | 名词默认；af_sarah声线；保留旧base |

早期候选报告中的近音转写包括 affect/effect、ashore/assure、appal/appall/Epile/Apollo、fox/Vox。appal/appall 的旧Ogg随后按字典音素重新合成；当前哈希绑定的全量逐条 Whisper small 仍将两者转写为 Apollo。其余目标读音仍需人耳确认实际声学结果；这些ASR混淆不单独证明读错或修复。
