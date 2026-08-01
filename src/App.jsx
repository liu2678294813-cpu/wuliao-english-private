import { useEffect, useMemo, useRef, useState } from "react";
import CustomDeepReader from "./CustomDeepReader";
import UnknownWordLibrary from "./UnknownWordLibrary";
import { parsePdfFile } from "./pdfParser";
import {
  getRecentProgress,
  postgraduateResources,
  readProgress,
} from "./library";
import {
  addCustomPdf,
  claimLegacyCustomPdfs,
  deleteCustomPdf,
  listCustomPdfs,
  updateCustomPdf,
} from "./storage";
import { getStudyRank, studyRankEventName } from "./studyRank";
import {
  CURRENT_USER_KEY,
  getAccount,
  getCurrentUsername,
  listAccounts,
  migrateLegacyUserStorage,
  saveAccountPassword,
  setCurrentUsername,
  verifyAccountPassword,
} from "./userData";

const officialAnalysisCache = new Map();

function AccountGate({ children }) {
  const [username, setUsername] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [mode, setMode] = useState("loading");
  const [selected, setSelected] = useState("");
  const [accountName, setAccountName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function enterAccount(nextUsername) {
    setCurrentUsername(nextUsername);
    migrateLegacyUserStorage(nextUsername);
    await claimLegacyCustomPdfs(nextUsername);
    setUsername(nextUsername);
    setMode("ready");
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const knownAccounts = await listAccounts();
      if (!active) return;
      setAccounts(knownAccounts);
      const remembered = getCurrentUsername();
      if (remembered) {
        const account = await getAccount(remembered);
        if (!active) return;
        if (account?.passwordHash) {
          await enterAccount(remembered);
          return;
        }
        setSelected(remembered);
        setMode("upgrade");
        return;
      }
      if (knownAccounts.length) {
        setSelected(knownAccounts[0].username);
        setMode("login");
      } else {
        setMode("create");
      }
    })().catch((reason) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setMode("create");
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === CURRENT_USER_KEY && !event.newValue) {
        setUsername("");
        listAccounts().then((items) => {
          setAccounts(items);
          setSelected(items[0]?.username || "");
          setMode(items.length ? "login" : "create");
        });
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") {
        if (!selected) throw new Error("请选择账号");
        if (!await verifyAccountPassword(selected, password)) throw new Error("密码不正确");
        await enterAccount(selected);
        return;
      }
      const targetUsername = mode === "upgrade" ? selected : accountName.trim();
      if (password !== confirmation) throw new Error("两次输入的密码不一致");
      await saveAccountPassword(targetUsername, password, { createOnly: mode === "create" });
      await enterAccount(targetUsername);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setError("");
    setPassword("");
    setConfirmation("");
  }

  if (mode === "ready" && username) {
    return children(username, () => {
      setCurrentUsername("");
      setUsername("");
      setPassword("");
      listAccounts().then((items) => {
        setAccounts(items);
        setSelected(items[0]?.username || "");
        setMode(items.length ? "login" : "create");
      });
    });
  }

  if (mode === "loading") {
    return <div className="account-gate"><div className="account-card"><span className="account-mark">无</span><strong>正在读取本机账号…</strong></div></div>;
  }

  const isLogin = mode === "login";
  const isUpgrade = mode === "upgrade";
  return (
    <div className="account-gate">
      <form className="account-card" onSubmit={submit}>
        <span className="account-mark">无</span>
        <p className="eyebrow">LOCAL ACCOUNT</p>
        <h1>{isLogin ? "登录无聊英语" : isUpgrade ? "为现有账号设置密码" : "创建本机账号"}</h1>
        <p>{isUpgrade ? `现有学习数据将无损归入账号 ${selected}` : "各账号的精读、笔迹、词库与进度彼此独立。"}</p>
        {isLogin ? (
          <label>账号
            <select value={selected} onChange={(event) => setSelected(event.target.value)}>
              {accounts.map((account) => <option key={account.username} value={account.username}>{account.username}</option>)}
            </select>
          </label>
        ) : isUpgrade ? (
          <div className="account-fixed-name"><span>当前账号</span><strong>{selected}</strong></div>
        ) : (
          <label>账号名<input value={accountName} onChange={(event) => setAccountName(event.target.value)} autoComplete="username" autoFocus /></label>
        )}
        <label>密码<input type="password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={isLogin ? "current-password" : "new-password"} placeholder="至少 6 个字符" /></label>
        {!isLogin && <label>确认密码<input type="password" minLength={6} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /></label>}
        {error && <div className="account-error">{error}</div>}
        <button className="primary-button account-submit" type="submit" disabled={busy}>{busy ? "正在处理…" : isLogin ? "登录" : "保存并进入 App"}</button>
        <div className="account-actions">
          {isLogin && <button type="button" onClick={() => switchMode("create")}>创建新账号</button>}
          {mode === "create" && accounts.length > 0 && <button type="button" onClick={() => switchMode("login")}>返回登录</button>}
        </div>
        <small>密码仅保存在当前设备的加盐派生值中，不会上传云端。</small>
      </form>
    </div>
  );
}

function AccountButton({ username, onSwitch }) {
  return <button type="button" className="account-pill" onClick={onSwitch}><span>账</span><strong>{username}</strong><small>切换</small></button>;
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark">无</span>
      <span>
        <strong>无聊英语</strong>
        {!compact && <small>WULIAO ENGLISH</small>}
      </span>
    </div>
  );
}

function ProgressBar({ progress }) {
  const percent = progress?.total
    ? Math.round((progress.page / progress.total) * 100)
    : 0;
  return (
    <div className="progress-track" aria-label={`学习进度 ${percent}%`}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

function StudyRankCard() {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let active = true;
    const refresh = () => getStudyRank().then((result) => {
      if (active) setSummary(result);
    });
    refresh();
    window.addEventListener(studyRankEventName, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener(studyRankEventName, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  if (!summary) return null;
  const completionPercent = Math.round(summary.completionRate * 100);
  return (
    <section className="study-rank-card" aria-label="本机学习段位">
      <div className="rank-emblem"><small>本机段位</small><strong>{summary.rank.name}</strong><span>{summary.score} / {summary.maxScore}</span></div>
      <div className="rank-main">
        <div className="rank-heading">
          <div><small>LEARNING RANK</small><h2>每一次真正完成，都会留下刻度。</h2></div>
          <span>{summary.nextRank ? `距「${summary.nextRank.name}」还差 ${summary.nextRank.min - summary.score} 分` : "已到最高段位"}</span>
        </div>
        <div className="rank-progress"><span style={{ width: `${summary.progress}%` }} /></div>
        <div className="rank-stats">
          <div><strong>{summary.vocabularyScore} / {summary.vocabularyMaxScore}</strong><span>词汇实力 · 熟知 {summary.familiarWords} / {summary.vocabularyTarget}</span></div>
          <div><strong>{summary.readingScore} / {summary.readingMaxScore}</strong><span>精读进度 · 完成 {summary.completed} / {summary.readingTarget}</span></div>
          <div><strong>{completionPercent}%</strong><span>阅读完成率 · 仅供参考</span></div>
        </div>
      </div>
    </section>
  );
}

function Home({ onRead, onVocabulary, onOpenResource, username, onSwitchAccount }) {
  const recent = getRecentProgress();
  return (
    <div className="home-page">
      <header className="home-header">
        <Brand />
        <AccountButton username={username} onSwitch={onSwitchAccount} />
      </header>

      <main className="home-main">
        <section className="hero-copy">
          <p className="eyebrow">READ · MARK · REVIEW</p>
          <h1>把真题读慢一点，<br /><em>反而走得更快。</em></h1>
          <p className="hero-description">
            原文、做题、笔译、订正、重做与复读，在同一个安静的学习空间里完成。
          </p>
          <div className="hero-stats">
            <div><strong>{postgraduateResources.length}</strong><span>篇考研精读</span></div>
            <div><strong>17</strong><span>年真题跨度</span></div>
            <div><strong>0</strong><span>份资料上传云端</span></div>
          </div>
        </section>

        <section className="entry-grid" aria-label="学习模块">
          <button className="entry-card reading-entry" onClick={onRead}>
            <span className="entry-index">01</span>
            <span className="entry-icon">阅</span>
            <span className="entry-content">
              <small>READING WORKSPACE</small>
              <strong>阅读训练</strong>
              <span>进入真题库与自定义 PDF 精读</span>
            </span>
            <span className="entry-arrow">→</span>
          </button>
          <button className="entry-card vocabulary-entry" onClick={onVocabulary}>
            <span className="entry-index">02</span>
            <span className="entry-icon">词</span>
            <span className="entry-content">
              <small>VOCABULARY REVIEW</small>
              <strong>单词背诵</strong>
              <span>进入词库筛查、学习与背词训练</span>
            </span>
            <span className="entry-arrow">→</span>
          </button>
        </section>

        <StudyRankCard />

        {recent.length > 0 && (
          <section className="recent-section">
            <div className="section-heading">
              <div><small>RECENT</small><h2>继续上次的精读</h2></div>
            </div>
            <div className="recent-grid">
              {recent.map(({ resource, progress }) => (
                <button key={resource.id} className="recent-card" onClick={() => onOpenResource(resource)}>
                  <span className="recent-year">{resource.year}</span>
                  <strong>Text {resource.text}</strong>
                  <span>上次读到第 {progress.page} / {progress.total} 页</span>
                  <ProgressBar progress={progress} />
                </button>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="home-footer">
        <span>无聊英语 · 精读训练初版</span>
        <span>PDF 解析、笔迹与答题记录均保存在本机</span>
      </footer>
    </div>
  );
}

function ResourceCard({ resource, onOpen, onDelete }) {
  const isCustom = resource.kind === "custom";
  const progress = isCustom ? null : readProgress(resource.id);
  const status = resource.conversionStatus || "pending";
  const customMeta = status === "ready"
    ? `${resource.analysis?.passages?.length || 0} 篇 · ${resource.analysis?.totals?.questions || 0} 题`
    : status === "processing"
      ? "正在本地识别与排版"
      : status === "failed"
        ? "转换失败 · 点击重试"
        : "等待生成精读版";
  return (
    <article className={`resource-card ${isCustom ? `custom-resource ${status}` : ""}`}>
      <div className="resource-card-top">
        <span className="resource-badge">{resource.kind === "custom" ? "自定义" : "英语一"}</span>
        {onDelete && (
          <button className="icon-button subtle" onClick={() => onDelete(resource)} aria-label="删除资料">×</button>
        )}
      </div>
      <button className="resource-open" onClick={() => onOpen(resource)}>
        <span className="resource-number">{resource.text ? `T${resource.text}` : "PDF"}</span>
        <strong>{resource.title}</strong>
        <span>{resource.subtitle}</span>
      </button>
      <div className="resource-meta">
        <span>{isCustom ? customMeta : progress ? `第 ${progress.page}/${progress.total} 页` : "尚未开始"}</span>
        <span>{isCustom ? `${Math.max(0.1, resource.size / 1024 / 1024).toFixed(1)} MB` : "约 15 页"}</span>
      </div>
      {isCustom ? (
        <div className="conversion-track" aria-label={customMeta}>
          <span className={`conversion-dot ${status}`} />
          <small>{status === "ready" ? (resource.analysis?.method === "ocr" ? "离线 OCR 已完成" : "本地文本识别已完成") : customMeta}</small>
        </div>
      ) : <ProgressBar progress={progress} />}
    </article>
  );
}

function EmptyLibrary({ type }) {
  const copy = type === "custom"
    ? { mark: "PDF", title: "这里还没有你的资料", text: "上传 PDF 后会自动进入自定义库，原文件不会离开本机。" }
    : { mark: "—", title: `${type}题库本轮保持不变`, text: "按当前需求，本次只接入考研精读库，没有改动这一题库。" };
  return (
    <div className="empty-library">
      <span>{copy.mark}</span>
      <h3>{copy.title}</h3>
      <p>{copy.text}</p>
    </div>
  );
}

function Library({ onBack, onOpen, onUnknownWords }) {
  const [tab, setTab] = useState("postgraduate");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("all");
  const [customPdfs, setCustomPdfs] = useState([]);
  const [notice, setNotice] = useState("");
  const [converting, setConverting] = useState(false);
  const inputRef = useRef(null);

  const refreshCustom = () => listCustomPdfs().then(setCustomPdfs);
  useEffect(() => { refreshCustom(); }, []);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return postgraduateResources.filter((resource) => {
      const matchesYear = year === "all" || resource.year === Number(year);
      const matchesTerm = !term || `${resource.year} text ${resource.text} ${resource.title}`.toLowerCase().includes(term);
      return matchesYear && matchesTerm;
    });
  }, [query, year]);

  const grouped = useMemo(() => {
    return filtered.reduce((groups, resource) => {
      if (!groups[resource.year]) groups[resource.year] = [];
      groups[resource.year].push(resource);
      return groups;
    }, {});
  }, [filtered]);

  function describeProgress(fileName, progress) {
    if (progress.phase === "ocr-loading") return `${fileName}：正在加载本地 OCR`;
    if (progress.phase === "ocr") return `${fileName}：OCR 第 ${progress.page}/${progress.total} 页（本页 ${progress.pagePercent || 0}%）`;
    if (progress.phase === "text") return `${fileName}：读取 PDF 第 ${progress.page}/${progress.total} 页`;
    if (progress.phase === "done") return `${fileName}：精读版生成完成`;
    return `${fileName}：正在分析文章与习题`;
  }

  async function convertResource(resource) {
    const processing = await updateCustomPdf(resource.id, {
      conversionStatus: "processing",
      conversionError: "",
    });
    setCustomPdfs((current) => current.map((item) => item.id === resource.id ? processing : item));

    try {
      const analysis = await parsePdfFile(resource.file, (progress) => {
        setNotice(describeProgress(resource.title, progress));
      });
      const ready = await updateCustomPdf(resource.id, {
        analysis,
        conversionStatus: "ready",
        convertedAt: Date.now(),
        conversionError: "",
      });
      setCustomPdfs((current) => current.map((item) => item.id === resource.id ? ready : item));
      return ready;
    } catch (error) {
      const failed = await updateCustomPdf(resource.id, {
        conversionStatus: "failed",
        conversionError: error instanceof Error ? error.message : String(error),
      });
      setCustomPdfs((current) => current.map((item) => item.id === resource.id ? failed : item));
      throw error;
    }
  }

  async function handleUpload(event) {
    const files = [...event.target.files].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!files.length) return;
    event.target.value = "";
    setTab("custom");
    setConverting(true);

    let completed = 0;
    let failed = 0;
    for (const file of files) {
      const record = await addCustomPdf(file);
      setCustomPdfs((current) => [record, ...current]);
      try {
        await convertResource(record);
        completed += 1;
      } catch {
        failed += 1;
      }
    }

    setConverting(false);
    setNotice(failed
      ? `已生成 ${completed} 份精读版，${failed} 份识别失败，可点击资料重试`
      : `已将 ${completed} 份 PDF 转换为连续精读版`);
    window.setTimeout(() => setNotice(""), 5200);
  }

  async function handleOpen(resource) {
    if (resource.kind !== "custom" || (resource.conversionStatus === "ready" && resource.analysis?.passages?.length)) {
      onOpen(resource);
      return;
    }

    setConverting(true);
    try {
      const ready = await convertResource(resource);
      setNotice("精读版已生成，正在打开");
      onOpen(ready);
    } catch (error) {
      setNotice(`转换失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setConverting(false);
    }
  }

  async function handleDelete(resource) {
    if (!window.confirm(`从自定义库删除“${resource.title}”？`)) return;
    await deleteCustomPdf(resource.id);
    await refreshCustom();
  }

  return (
    <div className="library-page">
      <header className="library-header">
        <button className="back-button" onClick={onBack}>← 返回首页</button>
        <Brand compact />
        <div className="library-header-actions">
          <button className="unknown-library-button" onClick={onUnknownWords}>陌生词库</button>
          <button className="upload-button" disabled={converting} onClick={() => inputRef.current?.click()}>{converting ? "正在识别…" : "＋ 上传 PDF"}</button>
        </div>
        <input ref={inputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleUpload} />
      </header>

      <main className="library-main">
        <section className="library-intro">
          <div>
            <p className="eyebrow">READING LIBRARY</p>
            <h1>精读资料库</h1>
            <p>选一篇，按完整流程安静地做完。所有学习记录只留在当前设备。</p>
          </div>
          <div className="library-count"><strong>{postgraduateResources.length}</strong><span>篇考研精读</span></div>
        </section>

        <nav className="library-tabs" aria-label="题库分类">
          {[
            ["postgraduate", "考研真题", String(postgraduateResources.length)],
            ["gaokao", "高考真题", "保留"],
            ["zhongkao", "中考真题", "保留"],
            ["custom", "自定义库", String(customPdfs.length)],
          ].map(([value, label, count]) => (
            <button key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>
              {label}<span>{count}</span>
            </button>
          ))}
        </nav>

        {tab === "postgraduate" && (
          <>
            <div className="library-tools">
              <label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索年份或 Text" /></label>
              <select value={year} onChange={(event) => setYear(event.target.value)} aria-label="按年份筛选">
                <option value="all">全部年份 · 2007–2023</option>
                {Array.from({ length: 17 }, (_, index) => 2023 - index).map((value) => <option key={value} value={value}>{value} 年</option>)}
              </select>
              <span className="result-count">{filtered.length} 篇</span>
            </div>
            <div className="year-groups">
              {Object.entries(grouped).sort(([a], [b]) => Number(b) - Number(a)).map(([groupYear, resources]) => (
                <section className="year-group" key={groupYear}>
                  <div className="year-heading"><strong>{groupYear}</strong><span>英语（一）Part A</span></div>
                  <div className="resource-grid">
                    {resources.map((resource) => <ResourceCard key={resource.id} resource={resource} onOpen={handleOpen} />)}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {(tab === "gaokao" || tab === "zhongkao") && <EmptyLibrary type={tab === "gaokao" ? "高考" : "中考"} />}

        {tab === "custom" && (
          customPdfs.length ? (
            <div className="resource-grid custom-grid">
              {customPdfs.map((resource) => <ResourceCard key={resource.id} resource={resource} onOpen={handleOpen} onDelete={handleDelete} />)}
            </div>
          ) : (
            <div onClick={() => inputRef.current?.click()} role="button" tabIndex={0}><EmptyLibrary type="custom" /></div>
          )
        )}
      </main>
      {notice && <div className="toast">✓ {notice}</div>}
    </div>
  );
}

function VocabularyWorkspace({ onBack }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="vocabulary-page">
      <header className="vocabulary-shell-header">
        <button className="back-button light" onClick={onBack}>← 无聊英语</button>
        <div className="vocabulary-shell-title">
          <small>VOCABULARY WORKSPACE</small>
          <strong>单词训练</strong>
        </div>
        <div className="reader-status"><span /> 本地数据</div>
      </header>
      <div className="vocabulary-frame-wrap">
        {!loaded && <div className="vocabulary-frame-loading"><span>词</span><strong>正在载入单词软件…</strong></div>}
        <iframe
          className={`vocabulary-frame ${loaded ? "loaded" : ""}`}
          title="无聊英语单词训练"
          src="/vocabulary/index.html#/dashboard"
          onLoad={() => setLoaded(true)}
        />
      </div>
    </div>
  );
}

function OfficialDeepReader({ resource, onClose }) {
  const [analysis, setAnalysis] = useState(() => officialAnalysisCache.get(resource.id) || null);
  const [status, setStatus] = useState("正在读取考研真题 PDF");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (analysis) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    setError("");

    (async () => {
      const workbookSource = resource.workbookSource || resource.source;
      const response = await fetch(workbookSource, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`PDF 文件读取失败（${response.status}）`);
      const file = new File(
        [await response.blob()],
        `${resource.year}-text-${resource.text}.pdf`,
        { type: "application/pdf" },
      );
      const nextAnalysis = await parsePdfFile(file, (progress) => {
        if (cancelled) return;
        if (progress.phase === "text") setStatus(`正在结构化第 ${progress.page}/${progress.total} 页`);
        if (progress.phase === "ocr-loading") setStatus("正在加载本地 OCR");
        if (progress.phase === "ocr") setStatus(`OCR 第 ${progress.page}/${progress.total} 页`);
      });
      if (cancelled) return;
      officialAnalysisCache.set(resource.id, nextAnalysis);
      setAnalysis(nextAnalysis);
    })().catch((reason) => {
      if (!cancelled && reason?.name !== "AbortError") {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [analysis, attempt, resource.id, resource.source, resource.text, resource.workbookSource, resource.year]);

  if (analysis) return <CustomDeepReader resource={{ ...resource, analysis }} onClose={onClose} />;

  return (
    <div className="placeholder-page reader-prepare-page">
      <button className="back-button" onClick={onClose}>← 资料库</button>
      <div className="placeholder-card">
        <span>阅</span>
        <p className="eyebrow">STRUCTURED READER</p>
        <h1>{resource.title}</h1>
        <p>{error ? `转换失败：${error}` : status}</p>
        {error && <button className="primary-button" onClick={() => setAttempt((value) => value + 1)}>重新转换</button>}
      </div>
    </div>
  );
}

function WorkspaceApp({ username, onSwitchAccount }) {
  const [view, setView] = useState(() => window.location.hash.startsWith("#/") ? "vocabulary" : "home");
  const [activeResource, setActiveResource] = useState(null);
  const objectUrlRef = useRef(null);

  function openResource(resource) {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    let prepared = resource;
    if (resource.kind === "custom") {
      const source = URL.createObjectURL(resource.file);
      objectUrlRef.current = source;
      prepared = { ...resource, source };
    }
    setActiveResource(prepared);
    setView("reader");
  }

  function closeReader() {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setActiveResource(null);
    setView("library");
  }

  function openVocabulary() {
    window.history.replaceState(null, "", window.location.pathname);
    setView("vocabulary");
  }

  function returnHome() {
    window.history.replaceState(null, "", window.location.pathname);
    setView("home");
  }

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  if (view === "reader" && activeResource) {
    if (activeResource.kind === "custom" && activeResource.analysis?.passages?.length) {
      return <CustomDeepReader resource={activeResource} onClose={closeReader} />;
    }
    return <OfficialDeepReader resource={activeResource} onClose={closeReader} />;
  }
  if (view === "library") return <Library onBack={() => setView("home")} onOpen={openResource} onUnknownWords={() => setView("unknown-words")} />;
  if (view === "unknown-words") return <UnknownWordLibrary onBack={() => setView("library")} />;
  if (view === "vocabulary") return <VocabularyWorkspace onBack={returnHome} />;
  return <Home onRead={() => setView("library")} onVocabulary={openVocabulary} onOpenResource={openResource} username={username} onSwitchAccount={onSwitchAccount} />;
}

export default function App() {
  return <AccountGate>{(username, onSwitchAccount) => <WorkspaceApp key={username} username={username} onSwitchAccount={onSwitchAccount} />}</AccountGate>;
}
