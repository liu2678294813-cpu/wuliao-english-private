import { readUnknownWordList } from "./unknown-word-list.js";
import {
  UNKNOWN_SORTS, buildUnknownWordStats, readUnknownExportHistory, readUnknownSort,
  recordUnknownExport, saveUnknownSort, undoUnknownExport, unknownExportSelection,
} from "./unknown-word-order.js";

function articleLabel(article) {
  return article.year === "自定义资料" && article.label !== article.chapter
    ? article.label + " · " + article.chapter
    : article.year + " · " + article.chapter;
}

function articleCounts(stats, exported) {
  const counts = new Map(stats.articles.map(({ id }) => [id, { new: 0, exported: 0 }]));
  for (const mark of stats.marks) {
    counts.get(mark.articleId)[exported.has(mark.id) ? "exported" : "new"]++;
  }
  return counts;
}

export function UnknownExportOptions({ react, username, name, generate }) {
  const { createElement: h, useEffect, useMemo, useRef, useState } = react;
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState(() => readUnknownExportHistory(username));
  const [scope, setScope] = useState("new");
  const [order, setOrder] = useState(() => readUnknownSort(username, "export"));
  const [format, setFormat] = useState("bilingual");
  const [omitted, setOmitted] = useState(new Set());
  const [query, setQuery] = useState("");
  const [backfill, setBackfill] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const current = useRef(false);
  const stats = useMemo(() => buildUnknownWordStats(snapshot?.records || [], username), [snapshot, username]);
  const counts = useMemo(() => articleCounts(stats, history.exported), [stats, history]);
  const selected = useMemo(() => new Set(stats.articles.filter(({ id }) => !omitted.has(id)).map(({ id }) => id)), [stats, omitted]);
  const sample = useMemo(() => unknownExportSelection(stats, selected, scope, history.exported, order), [stats, selected, scope, history, order]);

  useEffect(() => {
    current.current = true;
    let generation = 0;
    const reload = async () => {
      const revision = ++generation;
      const next = await readUnknownWordList(username);
      if (current.current && revision === generation) setSnapshot(next);
    };
    const refreshHistory = () => setHistory(readUnknownExportHistory(username));
    window.addEventListener("storage", refreshHistory);
    window.addEventListener("wuliao:unknown-words-refresh", reload);
    window.addEventListener("focus", reload);
    void reload();
    return () => {
      current.current = false;
      generation++;
      window.removeEventListener("storage", refreshHistory);
      window.removeEventListener("wuliao:unknown-words-refresh", reload);
      window.removeEventListener("focus", reload);
    };
  }, [username]);

  function persist(batch, type) {
    recordUnknownExport(username, batch, type);
    setHistory(readUnknownExportHistory(username));
  }

  function setArticles(ids, checked) {
    setOmitted((previous) => {
      const next = new Set(previous);
      for (const id of ids) checked ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function download() {
    if (busy || !sample.entries.length) return;
    setNotice("");
    setBusy(true);
    try {
      await generate(name, sample.entries, format, order, stats.articles, () =>
        current.current && localStorage.getItem("kaoyan_vocab_current_user")?.trim() === username);
    } catch (error) {
      if (current.current) setNotice(error.message || "PDF 生成失败，请重试");
      return;
    } finally {
      if (current.current) setBusy(false);
    }
    try {
      persist(sample.marks, "download");
      setNotice("已发起下载，并记录 " + sample.marks.length + " 个标记");
    } catch {
      if (current.current) setNotice("已发起下载。导出记录保存失败，请释放本地存储空间后重试。");
    }
  }

  const visibleGroups = new Map();
  const search = query.trim().toLowerCase();
  for (const article of stats.articles) {
    if (search && ![article.year, article.chapter, article.label, article.source].some((value) => value.toLowerCase().includes(search))) continue;
    if (!visibleGroups.has(article.year)) visibleGroups.set(article.year, []);
    visibleGroups.get(article.year).push(article);
  }

  function selectField(label, value, onChange, options) {
    return h("label", { className: "unknown-export-field" }, label,
      h("select", { value, onChange: (event) => onChange(event.target.value) },
        options.map(([id, text]) => h("option", { key: id, value: id }, text))));
  }

  if (!snapshot || snapshot.error) {
    return h("p", { role: "status" }, snapshot?.error || "正在读取陌生词库…");
  }

  return h("section", { className: "unknown-export-options", "aria-label": "陌生词导出选项" },
    h("fieldset", { disabled: busy || Boolean(backfill) },
      h("div", { className: "unknown-export-fields" },
        selectField("导出状态", scope, setScope, [["new", "仅未导出"], ["all", "全部"], ["exported", "仅已导出"]]),
        selectField("单词排序", order, (value) => {
          try { saveUnknownSort(username, "export", value); setOrder(value); }
          catch { setNotice("排序设置保存失败，请重试"); }
        }, UNKNOWN_SORTS),
        selectField("导出格式", format, setFormat, [["bilingual", "中英双语版"], ["english-only", "纯英文版"]])),
      h("div", { className: "unknown-export-articles" },
        h("div", { className: "unknown-export-tools" },
          h("h3", null, "文章范围"),
          h("button", { type: "button", onClick: () => setOmitted(new Set()) }, "全选"),
          h("button", { type: "button", onClick: () => setOmitted(new Set(stats.articles.map(({ id }) => id))) }, "取消全选")),
        h("input", { type: "search", "aria-label": "搜索文章", placeholder: "搜索年份或文章名", value: query,
          onChange: (event) => setQuery(event.target.value) }),
        h("div", { className: "unknown-export-scroll" },
          visibleGroups.size === 0 && h("p", null, search ? "没有匹配的文章" : "暂无陌生词标记"),
          [...visibleGroups].map(([year, articles]) => {
            const ids = articles.map(({ id }) => id);
            const allSelected = ids.every((id) => selected.has(id));
            return h("div", { key: year, className: "unknown-export-year" },
              h("button", { type: "button", onClick: () => setArticles(ids, !allSelected),
                "aria-label": (allSelected ? "取消 " : "选择 ") + year + (search ? " 匹配文章" : " 全部文章") },
              year + " · " + (allSelected ? "取消本组" : "选中本组")),
              articles.map((article) => {
                const count = counts.get(article.id);
                return h("label", { className: "unknown-export-article", key: article.id },
                  h("input", { type: "checkbox", checked: selected.has(article.id),
                    onChange: (event) => setArticles([article.id], event.target.checked) }),
                  h("span", null, article.chapter, article.label !== article.chapter &&
                    h("small", { className: "unknown-export-subtitle" }, article.label)),
                  h("small", { className: "unknown-export-count" }, "未导出 " + count.new + " · 已导出 " + count.exported));
              }));
          }))),
      h("p", { className: "unknown-export-summary", "aria-live": "polite" },
        "已选 " + selected.size + " 篇 · 本次 " + sample.marks.length + " 个标记 · PDF 共 " + sample.entries.length + " 条"),
      h("button", { type: "button", className: "unknown-export-primary", onClick: download, disabled: !sample.entries.length },
        busy ? "生成中…" : "下载 PDF"),
      h("div", { className: "unknown-export-tools" },
        h("button", { type: "button", disabled: !selected.size, onClick: () => {
          setNotice("");
          setBackfill(unknownExportSelection(stats, selected, "new", history.exported, order).marks);
        } }, "补记以前的导出"),
        h("button", { type: "button", "aria-expanded": historyOpen, onClick: () => setHistoryOpen(!historyOpen) }, "导出记录"))),
    Boolean(backfill) && h("div", { className: "unknown-export-confirm" },
      h("p", null, "将所选 " + selected.size + " 篇中当前 " + backfill.length
        + " 个未导出的标记记为已导出。以前导出后新加的标记也在这个范围内。"),
      h("div", { className: "unknown-export-tools" },
        h("button", { type: "button", disabled: !backfill.length, onClick: () => {
          try {
            persist(backfill, "backfill");
            setNotice("已补记 " + backfill.length + " 个标记");
            setBackfill(null);
          } catch { setNotice("补记保存失败，请重试"); }
        } }, "确认补记"),
        h("button", { type: "button", onClick: () => setBackfill(null) }, "取消"))),
    historyOpen && h("div", { className: "unknown-export-history", "aria-label": "导出记录明细" },
      history.batches.length === 0 && h("p", null, "暂无导出记录"),
      history.batches.map((batch) => h("div", { className: "unknown-export-tools", key: batch.id },
        h("span", null, (batch.type === "download" ? "下载" : "补记") + " · " + batch.marks.length
          + " 个标记 · " + new Date(batch.createdAt).toLocaleString("zh-CN")),
        h("button", { type: "button", disabled: busy, onClick: () => {
          try {
            undoUnknownExport(username, batch.id);
            setHistory(readUnknownExportHistory(username));
            setNotice("已撤销该批记录");
          } catch { setNotice("撤销失败，请重试"); }
        } }, "撤销")))),
    notice && h("p", { role: "status" }, notice));
}

export function createUnknownPdfGenerator({ createDocument, fontkit, standardFonts, loadChinese, color, download }) {
  return async (name, entries, format, order, articles, isCurrent) => {
    const document = await createDocument();
    document.registerFontkit(fontkit);
    const english = await document.embedFont(standardFonts.HelveticaBold);
    const chinese = await document.embedFont(await loadChinese(), { subset: true });
    const labels = new Map(articles.map((article) => [article.id, articleLabel(article)]));
    const byArticle = order === "article";
    const bilingual = format === "bilingual";
    const width = 595.28;
    const height = 841.89;
    const margin = 29;
    const gap = 22;
    const longDefinition = entries.some(({ chinese: meaning }) => chinese.widthOfTextAtSize(meaning, 7) > 125);
    const columns = byArticle || (bilingual && longDefinition) ? 1 : bilingual ? 2 : 4;
    const columnWidth = (width - 2 * margin - (columns - 1) * gap) / columns;
    let page = document.addPage([width, height]);
    let row = 0;
    let column = 0;
    let article = null;
    const rowsPerPage = 43;

    function draw(value, font, x, y, preferredSize, available, ink) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (!text) return;
      const size = Math.min(preferredSize, preferredSize * available / font.widthOfTextAtSize(text, preferredSize));
      page.drawText(text, { x, y, size, font, color: ink });
    }

    for (const entry of entries) {
      const beginsArticle = byArticle && article !== entry.sources[0];
      const hasOtherSources = byArticle && entry.sources.length > 1;
      const space = 1 + Number(beginsArticle) + Number(hasOtherSources);
      if (row + space > rowsPerPage) {
        row = 0;
        column++;
        if (column === columns) { page = document.addPage([width, height]); column = 0; }
      }
      const x = margin + column * (columnWidth + gap);
      if (byArticle && (beginsArticle || row === 0)) {
        article = entry.sources[0];
        draw("【文章】" + labels.get(article), chinese, x, height - 36 - row * 18, 11, columnWidth, color(.09, .36, .37));
        row++;
      }
      const y = height - 36 - row * 18;
      const englishWidth = bilingual ? Math.min(172, columnWidth * .42) : columnWidth;
      draw(entry.english, english, x, y, 10.5, englishWidth, color(.05, .05, .05));
      if (bilingual) {
        draw(entry.chinese, chinese, x + englishWidth + 7, y, 10, columnWidth - englishWidth - 7, color(.05, .05, .05));
      }
      row++;
      if (hasOtherSources) {
        draw("【另见】" + entry.sources.slice(1).map((id) => labels.get(id)).join("；"),
          chinese, x, height - 36 - row * 18, 8, columnWidth, color(.30, .36, .40));
        row++;
      }
    }
    const bytes = await document.save({ useObjectStreams: true, addDefaultPage: false });
    if (!isCurrent()) throw new Error("导出页面已关闭或账号已切换");
    const safeName = name.replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 80) || "陌生词库";
    download(bytes, safeName + (bilingual ? "_双语.pdf" : "_英文.pdf"));
  };
}

