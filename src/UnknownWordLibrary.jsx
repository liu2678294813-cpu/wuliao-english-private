import { useEffect, useMemo, useState } from "react";
import { deleteUnknownWord, listUnknownWords, updateUnknownWordMeaning } from "./storage";
import { unknownWordSourceType } from "./clozeUnknownWords";

const SOURCE_FILTERS = [
  { id: "all", label: "全部" },
  { id: "reading", label: "精读" },
  { id: "cloze", label: "完形" },
];

export default function UnknownWordLibrary({ onBack }) {
  const [words, setWords] = useState([]);
  const [notice, setNotice] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");

  const refresh = () => listUnknownWords().then(setWords);

  useEffect(() => {
    refresh();
    window.addEventListener("wuliao:unknown-words-updated", refresh);
    return () => window.removeEventListener("wuliao:unknown-words-updated", refresh);
  }, []);

  const filteredWords = useMemo(() => (
    sourceFilter === "all"
      ? words
      : words.filter((word) => unknownWordSourceType(word) === sourceFilter)
  ), [words, sourceFilter]);

  const groups = useMemo(() => filteredWords.reduce((result, word) => {
    const year = word.year || "自定义资料";
    const chapter = word.chapter || word.passageLabel || "未命名章节";
    result[year] ||= {};
    result[year][chapter] ||= [];
    result[year][chapter].push(word);
    return result;
  }, {}), [filteredWords]);

  async function editMeaning(word) {
    const meaning = window.prompt(`修改 ${word.word} 的中文释义`, word.meaning || "");
    if (meaning === null) return;
    await updateUnknownWordMeaning(word.id, meaning);
    setNotice("释义已更新");
    window.setTimeout(() => setNotice(""), 1500);
  }

  async function removeWord(word) {
    if (!window.confirm(`从陌生词库删除“${word.word}”？`)) return;
    await deleteUnknownWord(word.id);
    setNotice("已删除陌生词");
    window.setTimeout(() => setNotice(""), 1500);
  }

  return (
    <div className="unknown-library-page">
      <header className="library-header unknown-library-header">
        <button className="back-button" onClick={onBack}>← 返回</button>
        <div className="unknown-library-title"><small>UNKNOWN WORDS</small><strong>陌生词库</strong></div>
        <span className="unknown-library-count">{filteredWords.length} 词</span>
      </header>
      <main className="unknown-library-main">
        <section className="library-intro unknown-library-intro">
          <div><p className="eyebrow">READ · MARK · REVIEW</p><h1>陌生词库</h1></div>
        </section>
        <div className="unknown-source-filter" role="tablist" aria-label="按来源筛选">
          {SOURCE_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={sourceFilter === item.id}
              className={sourceFilter === item.id ? "is-active" : ""}
              onClick={() => setSourceFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {!filteredWords.length && (
          <div className="empty-library"><span>词</span><h3>这里还没有陌生词</h3><p>进入精读或完形的可标记阶段，将不熟悉的英文词加入陌生词库。</p></div>
        )}
        {Object.entries(groups)
          .sort(([left], [right]) => String(right).localeCompare(String(left), "zh-CN", { numeric: true }))
          .map(([year, chapters]) => (
            <section className="unknown-year-group" key={year}>
              <div className="year-heading"><strong>{year}</strong><span>{year === "自定义资料" ? "本地资料" : "考研英语（一）"}</span></div>
              {Object.entries(chapters).map(([chapter, chapterWords]) => (
                <article className="unknown-chapter" key={`${year}-${chapter}`}>
                  <header><h2>{chapter}</h2><span>{chapterWords.length} 词</span></header>
                  <div className="unknown-word-grid">
                    {chapterWords
                      .sort((a, b) => a.word.localeCompare(b.word, "en"))
                      .map((word) => (
                        <div className="unknown-word-card" key={word.id}>
                          <button className="unknown-word-copy" onClick={() => editMeaning(word)}>
                            <strong>{word.word}</strong><span>{word.meaning || "释义未收录 · 点此补充"}</span>
                          </button>
                          <button className="unknown-word-delete" onClick={() => removeWord(word)} aria-label={`删除 ${word.word}`}>×</button>
                        </div>
                      ))}
                  </div>
                </article>
              ))}
            </section>
          ))}
      </main>
      {notice && <div className="toast">✓ {notice}</div>}
    </div>
  );
}
