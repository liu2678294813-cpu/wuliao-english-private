# 异读词文字审计（75词）

这是词库中文首义、自动音素和字典音素的比对，**不是人工试听报告**。所有合成音频仍可能存在音色、音素、重音及词义适配问题。

- 20 个默认词性选择有中文首义依据；32 条词性变体使用 CMU 美音音素。
- 未覆盖候选 converse、incense、use：当前可读取词库无这些拼写。
- 明确保留歧义：conflict, contrast, decrease, estimate, export, import, increase, insult, progress, protest, record, transfer, transport。
- lead/read/wind/tear/resume/invalid 的当前读音与首义匹配；read 过去式、lead 金属、wind 缠绕、tear 撕裂、resume 简历等别义仍需上下文。
- [CMUdict 来源](https://github.com/cmusphinx/cmudict)；[alternate 的 Cambridge 美音/英音及词性对照](https://dictionary.cambridge.org/us/pronunciation/english/alternate)。

## 逐词记录

“保留”只表示本次文字核对未发现明确冲突；不代表声学验证了正确发音。

| 单词 | 来源中文 | 原自动音素 | 决定 |
|---|---|---|---|
| absent | 缺席的；缺席；不参加 | ˈæbsənt | 首义匹配，保留base |
| abstract | 抽象的；非具体的；深奥的 | ˈæbstɹækt | 首义匹配，保留base |
| accent | 口音；腔调；强调 | ˈæksənt | 首义匹配，保留base |
| address | 地址；网址；演说 | ɐdɹˈɛs | 首义匹配，保留base |
| advocate | 提倡；主张；提倡者 | ˈædvəkˌeɪt | 首义匹配，保留base |
| affect | 影响；感动；假装 | ɐfˈɛkt | 首义匹配，保留base |
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
| decrease | 减少；降低 | dˈiːkɹiːs | 歧义，保留base |
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
| estimate | 估算；估价 | ˈɛstᵻmət | 歧义，保留base |
| excuse | 饶恕；借口；致歉 | ɛkskjˈuːs | 默认 verb / ɪkskjˈuz |
| export | 输出；出口 | ˈɛkspɔːɹt | 歧义，保留base |
| extract | 提取物；摘录；精华 | ˈɛkstɹækt | 首义匹配，保留base |
| frequent | 频繁的；经常发生的 | fɹˈiːkwənt | 首义匹配，保留base |
| graduate | 大学毕业生；学士学位获得者；毕业 | ɡɹˈædʒuːət | 首义匹配，保留base |
| house | 房子；房屋 | hˈaʊs | 首义匹配，保留base |
| impact | 冲击；力；影响力 | ˈɪmpækt | 首义匹配，保留base |
| import | 进口；输入；重要性 | ɪmpˈɔːɹt | 歧义，保留base |
| increase | 增加；增长；增多 | ˈɪŋkɹiːs | 歧义，保留base |
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
