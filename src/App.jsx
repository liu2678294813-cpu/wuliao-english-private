import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ClozeSummaryPanel from "./ClozeSummaryPanel";
import { listCompletedClozeRecords } from "./clozeLearningArchive";
import ErrorBoundary from "./ErrorBoundary";
import { configureDurableInkStorage, hydrateDurableInk, flushDurableInk } from "./durableInkStorage.js";
import { openWuliaoEnglishDatabase } from "./storage.js";
import { flushPendingSaves, backgroundSave, reportSaveFailure } from "./saveCoordinator.js";
import SaveStatus from "./ui/SaveStatus.jsx";
import TodayTasks from "./TodayTasks.jsx";
import UnknownWordLibrary from "./UnknownWordLibrary";
import AppShell from "./ui/AppShell";
import { BackControllerProvider } from "./ui/BackContext";
import { createBackController } from "./ui/backController";
import ModalShell from "./ui/Overlay";
import SettingsPanel from "./ui/SettingsPanel";
import VocabularyWorkspace from "./ui/VocabularyWorkspace";
import AiProviderSettings from "./ui/AiProviderSettings.jsx";
import { getWritingVisionApiKey } from "./writing/writingVisionConfig.js";
import { createWritingInkFlushBridge } from "./writing/ui/WritingInkComposer.jsx";
import { createWritingAppServices } from "./writing/writingAppServices.js";
import Icon from "./ui/Icon";
import {
  normalizeVocabularyRoute,
  navigationBackTarget,
  PRIMARY_NAV,
  readingHostHash,
  readingRouteFromHost,
  examHostHash,
  examRouteFromHost,
  VOCABULARY_STATIC_PAGES,
  isVocabularySpaRoute,
  vocabularyWorkspaceFor,
  writingHostHash,
  writingRouteFromHost,
} from "./navigation";
import { getAiApiKey } from "./ai";
import { PDF_PARSER_VERSION } from "./pdfParserVersion.js";
import { computeFileFingerprint } from "./fingerprint";
import { importFailureMessage } from "./examImport";
import {
  postgraduateClozeResources,
  postgraduateResources,
  readProgress,
} from "./library";
import { selectCustomLibraryResources } from "./libraryView";

const loadCustomDeepReader = () => import("./CustomDeepReader");
const loadClozeReader = () => import("./ClozeReader");
const loadClozeReviewSession = () => import("./ClozeReviewSession");
const CustomDeepReader = lazy(loadCustomDeepReader);
const ClozeReader = lazy(loadClozeReader);
const ClozeReviewSession = lazy(loadClozeReviewSession);
const DeveloperLab = lazy(() => import("./ui/DeveloperLab"));
const WritingLibrary = lazy(() => import("./writing/ui/WritingLibrary.jsx"));
const WritingWorkspace = lazy(() => import("./writing/ui/WritingWorkspace.jsx"));
const ExamImportEditor = lazy(() => import("./ExamImportEditor"));

function RouteLoading({ label = "正在打开…" }) {
  return <div className="route-loading" role="status" aria-live="polite"><span aria-hidden="true" />{label}</div>;
}
import {
  addCustomPdf,
  claimLegacyCustomPdfs,
  deleteCustomPdf,
  getParseCache,
  listCustomPdfs,
  setParseCache,
  updateCustomPdf,
} from "./storage";
import { getStudyRank, RANKS, studyRankEventName } from "./studyRank";
import {
  CURRENT_USER_KEY,
  getAccount,
  getCurrentUsername,
  listUserItems,
  listAccounts,
  migrateLegacyUserStorage,
  saveAccountPassword,
  setCurrentUsername,
  verifyAccountPassword,
} from "./userData";
import {
  REVIEW_TASKS_UPDATED,
  localDateKey,
} from "./readingReview";
import {
  buildLibraryStatusMap,
  scanLearningState,
} from "./todayTasks";
import { getLearningSnapshot } from "./learningSnapshot";
import { scanClozeLibraryStatuses } from "./clozeLibraryStatus";
import { buildRecentLearning, completedClozeCount } from "./recentLearning";
import { AppEvent } from "./events/eventTypes";
import { emitAppEvent } from "./events/appEvents";
import { createVocabularyBridge, VocabMessageType } from "./vocabulary/vocabularyBridge";
import { ExamCover, ExamHistory, ExamLibrary, ExamResult, ExamSession } from "./exam/ExamScreens";
import {
  ExamResultRepository,
  ExamHandoffRepository,
  ExamSessionRepository,
  ExamStatus,
  ExamTimeoutError,
  answerExamItem,
  abandonExamSession,
  createExamSession,
  createOrUpdateHandoff,
  createSessionController,
  deriveHandoffTargets,
  reconcileSessionOnLoad,
  rebuildTerminalResult,
  submitExam,
  updateSession,
} from "./exam/examCore";
import { preflightX1Paper } from "./exam/examSources";
import {
  examInkRegistryUpsert,
  examSurfaceFlushDecision,
  examSurfaceIdForItem,
  mergeExamInkRegistryWithFlush,
} from "./exam/examInkStorage";
import "./exam/exam.css";
import "./exam/examInk.css";
import ExamInkSurface from "./exam/ExamInkSurface";
import ExamQuestionDrawer from "./exam/ExamQuestionDrawer";

const officialAnalysisCache = new Map();
configureDurableInkStorage(openWuliaoEnglishDatabase);

const vocabularyRouteFromHost = () => {
  const match = /^#\/vocabulary\/(dashboard|lists|learning|export|confusion|screening)$/.exec(window.location.hash);
  return match ? `/${match[1]}` : "";
};

const vocabularyHostHash = (route) => `#/vocabulary/${route.slice(1)}`;

const usesHttpMessagingOrigin = () => window.location.protocol === "http:" || window.location.protocol === "https:";

const isTrustedFrameMessage = (event, frameWindow) => (
  event.source === frameWindow
  && (!usesHttpMessagingOrigin() || event.origin === window.location.origin)
);

const frameMessageTargetOrigin = () => (usesHttpMessagingOrigin() ? window.location.origin : "*");

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
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const markWorkspaceReady = useCallback(() => setWorkspaceReady(true), []);

  async function enterAccount(nextUsername) {
    setWorkspaceReady(false);
    setMode("loading");
    setCurrentUsername(nextUsername);
    migrateLegacyUserStorage(nextUsername);
    await hydrateDurableInk(nextUsername, listUserItems("", nextUsername), (key, value) => {
      const scoped = `wuliao:user:${encodeURIComponent(nextUsername)}:${key}`;
      if (localStorage.getItem(scoped) === value) localStorage.removeItem(scoped);
      if (localStorage.getItem("wuliao_auth_legacy_owner") === nextUsername && localStorage.getItem(key) === value) localStorage.removeItem(key);
    });
    await Promise.all([
      getAiApiKey(),
      getWritingVisionApiKey({ username: nextUsername }),
    ]);
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
    const returnMode = mode;
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
      setMode(returnMode);
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
    return (
      <>
        {children(username, () => {
          setWorkspaceReady(false);
          setCurrentUsername("");
          setUsername("");
          setPassword("");
          listAccounts().then((items) => {
            setAccounts(items);
            setSelected(items[0]?.username || "");
            setMode(items.length ? "login" : "create");
          });
        }, markWorkspaceReady)}
        {!workspaceReady && <BrandLoading />}
      </>
    );
  }

  if (mode === "loading") {
    return <BrandLoading />;
  }

  const isLogin = mode === "login";
  const isUpgrade = mode === "upgrade";
  return (
    <div className="account-gate">
      <form className="account-card" onSubmit={submit}>
        <img className="account-mark" src="/favicon.svg" alt="无聊英语" />
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

function BrandLoading() {
  return (
    <main className="brand-welcome" role="status" aria-live="polite" aria-label="正在恢复本机账号">
      <picture className="brand-welcome-art">
        <source media="(orientation: portrait)" srcSet="/brand/wuliao-english-poster-portrait-1440x2560.webp" />
        <img src="/brand/wuliao-english-poster-landscape-2560x1440.webp" alt="" fetchPriority="high" decoding="sync" />
      </picture>
      <span className="visually-hidden">正在恢复本机账号</span>
      <span className="brand-welcome-progress" aria-hidden="true"><i /></span>
    </main>
  );
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <img className="brand-mark" src="/favicon.svg" alt="" />
      <span>
        <strong>无聊英语</strong>
        {!compact && <small>BORING ENGLISH · DEEP SEA</small>}
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

function RankModal({ summary, onClose }) {
  if (!summary) return null;
  return (
    <ModalShell open onClose={onClose} className="rank-modal-backdrop" label="段位说明">
      <div className="rank-modal">
        <header>
          <div><small>LEARNING RANK</small><h2>段位与达标分数</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭段位说明">×</button>
        </header>
        <p className="rank-modal-score">当前段位 · {summary.rank.name}（{summary.score} 分）</p>
        <div className="rank-modal-list">
          {RANKS.map((rank, index) => {
            const next = RANKS[index + 1];
            const current = rank.name === summary.rank.name;
            const reached = summary.score >= rank.min;
            return (
              <div className={`rank-row ${current ? "current" : ""} ${reached ? "reached" : ""}`} key={rank.name}>
                <span className="rank-row-order">{index + 1}</span>
                <strong>{rank.name}</strong>
                <span>{next ? `${rank.min} – ${next.min - 1} 分` : `${rank.min} 分以上`}</span>
                {current && <em>当前</em>}
              </div>
            );
          })}
        </div>
        <p className="rank-modal-note">词汇熟知与精读完成共同计分，全部数据只保存在当前设备。</p>
      </div>
    </ModalShell>
  );
}

function AiApiModal({ username, textAi, onClose, onSaved }) {
  void textAi;
  const [tab, setTab] = useState("text");

  return (
    <ModalShell open onClose={onClose} className="ai-api-backdrop" label="AI API 设置">
      <div className="ai-api-modal">
        <header>
          <div><h2>AI 模型与 API</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭 AI API 设置">×</button>
        </header>
        <div className="ai-provider-tabs" role="tablist" aria-label="AI 配置类型">
          <button type="button" role="tab" aria-selected={tab === "text"} className={tab === "text" ? "active" : ""} onClick={() => setTab("text")}>文本 AI</button>
          <button type="button" role="tab" aria-selected={tab === "vision"} className={tab === "vision" ? "active" : ""} onClick={() => setTab("vision")}>视觉 AI</button>
        </div>
        <p className="ai-api-hint">两类配置与密钥相互隔离；切换端点后需重新绑定。</p>
        {tab === "text"
          ? <AiProviderSettings key={`${username}:text`} modality="text" username={username} onSaved={onSaved} />
          : <AiProviderSettings key={`${username}:vision`} modality="vision" username={username} onSaved={onSaved} />}
      </div>
    </ModalShell>
  );
}

function formatLocalDate() {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "long",
  }).format(new Date());
}

function HomeOverview({ summary, todayState, onShowRanks, completedCloze = null }) {
  const pendingCount = todayState
    ? todayState.pendingGroups.reduce((total, group) => total + group.difficultCount + group.questionCount, 0)
    : null;
  const clozeReviewCount = todayState?.plan
    ? [...todayState.plan.planned, ...todayState.plan.overflow]
      .filter((candidate) => candidate.type === "cloze-review")
      .length
    : null;
  return (
    <section className="home-overview" aria-label="本机学习概览">
      <h2 className="home-overview-title">学习概览</h2>
      <div className="overview-metrics">
        <article className="overview-score">
          <span>本机学习积分</span>
          <strong>{summary ? <>{summary.score}<span className="overview-score-total"> / {summary.maxScore}</span></> : "读取中"}</strong>
          {summary && <progress className="overview-score-progress" value={summary.score} max={summary.maxScore} aria-label="本机学习积分进度" />}
          <small>{summary ? `当前段位 · ${summary.rank.name}` : "仅统计当前设备的学习记录"}</small>
          {summary && <button type="button" className="overview-rank-detail" onClick={onShowRanks}>段位详情</button>}
        </article>
        <article>
          <strong>{summary ? summary.familiarWords : "—"}</strong>
          <span>熟知词汇 / {summary?.vocabularyTarget || 6515}</span>
        </article>
        <article>
          <strong>{summary ? summary.completed : "—"}</strong>
          <span>已完成精读 / {summary?.readingTarget || postgraduateResources.length}</span>
        </article>
        <article>
          <strong>{completedCloze == null ? "—" : completedCloze}</strong>
          <span>已完成完形 / {postgraduateClozeResources.length}</span>
        </article>
        <article>
          <strong>{clozeReviewCount == null ? "—" : clozeReviewCount}</strong>
          <span>完形待复习</span>
        </article>
        <article>
          <strong>{pendingCount == null ? "—" : pendingCount}</strong>
          <span>待复盘</span>
        </article>
      </div>
    </section>
  );
}

function Home({ onRead, onOpenClozeLibrary, onOpenExam, onOpenExamFollowup, onUpdateExamFollowup, onOpenResource, onOpenCloze, username, onStartReview, onStartClozeReview, onOpenVocabularyReview, onReady }) {
  const [customPdfs, setCustomPdfs] = useState([]);
  const [todayState, setTodayState] = useState(null);
  const [summary, setSummary] = useState(null);
  const [rankModalOpen, setRankModalOpen] = useState(false);

  useEffect(() => {
    let active = true;
    listCustomPdfs().then((items) => {
      if (active) setCustomPdfs(items);
    }).catch(() => {});
    return () => { active = false; };
  }, [username]);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const snapshot = getLearningSnapshot();
      getStudyRank({ scan: snapshot.scan }).then((result) => {
        if (active) setSummary(result);
      });
    };
    refresh();
    window.addEventListener(studyRankEventName, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener(studyRankEventName, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const continueResourceId = todayState?.continueReading?.resourceId || "";
  const recent = useMemo(() => buildRecentLearning({
    resources: postgraduateClozeResources,
    customResources: customPdfs,
    limit: 3,
    excludeResourceIds: continueResourceId ? [continueResourceId] : [],
  }), [username, customPdfs, continueResourceId]);
  const completedCloze = useMemo(() => completedClozeCount({
    resources: postgraduateClozeResources,
    customResources: customPdfs,
  }), [username, customPdfs]);

  return (
    <div className="home-page">
      <main className="home-main">
        <header className="home-greeting">
          <div>
            <h1>今日学习</h1>
            <p><strong>{username}</strong>，从今天的任务开始，稳步完成学习计划。</p>
          </div>
          <time>{formatLocalDate()}</time>
        </header>

        <TodayTasks
          onReady={onReady}
          onOpenResource={onOpenResource}
          onStartReview={onStartReview}
          onStartClozeReview={onStartClozeReview}
          onStateChange={setTodayState}
          onBrowseLibrary={onRead}
          onOpenVocabularyReview={onOpenVocabularyReview}
          onOpenExamFollowup={onOpenExamFollowup}
          onUpdateExamFollowup={onUpdateExamFollowup}
        />

        <HomeOverview summary={summary} todayState={todayState} onShowRanks={() => setRankModalOpen(true)} completedCloze={completedCloze} />

        {rankModalOpen && <RankModal summary={summary} onClose={() => setRankModalOpen(false)} />}

        {recent.length > 0 && (
          <section className="recent-section">
            <div className="section-heading">
              <div><small>RECENT</small><h2>最近学习</h2></div>
            </div>
            <div className="recent-grid">
              {recent.map((item) => {
                if (item.type === "cloze-training") {
                  return (
                    <button key={`cloze-${item.resource.id}`} className="recent-card" onClick={() => onOpenCloze(item.resource)}>
                      <span className="recent-year">{item.resource.year || "—"}</span>
                      <strong>{item.resource.title}</strong>
                      <span>完形训练 · {item.stageLabel || "训练中"}</span>
                    </button>
                  );
                }
                if (item.type === "cloze-review") {
                  const count = (item.task.targetBlankIds || []).length;
                  const answered = Object.keys(item.task.attempts || {}).length;
                  return (
                    <button key={`review-${item.task.taskKey}`} className="recent-card" onClick={() => onStartClozeReview(item.task)}>
                      <span className="recent-year">{item.resource.year || "—"}</span>
                      <strong>{item.resource.title}</strong>
                      <span>{item.task.type === "d7" ? "D+7" : "D+1"} 复习 · {answered}/{count} 空</span>
                    </button>
                  );
                }
                return (
                  <button key={item.resource.id} className="recent-card" onClick={() => onOpenResource(item.resource)}>
                    <span className="recent-year">{item.resource.year}</span>
                    <strong>Text {item.resource.text}</strong>
                    <span>上次读到第 {item.progress.page} / {item.progress.total} 页</span>
                    <ProgressBar progress={item.progress} />
                  </button>
                );
              })}
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

function ResourceCard({ resource, onOpen, onDelete, cardStatus = null, onOpenSummary = null, onOpenCloze = null, mode = "reading" }) {
  const isCustom = resource.kind === "custom";
  const progress = isCustom ? null : readProgress(resource.id);
  const status = resource.conversionStatus || "pending";
  const customMeta = status === "ready"
    ? mode === "cloze"
      ? `${resource.analysis?.clozes?.length || 0} 篇完形 · ${resource.analysis?.clozes?.[0]?.blanks?.length || 0} 空`
      : `${resource.analysis?.passages?.length || 0} 篇 · ${resource.analysis?.totals?.questions || 0} 题`
    : status === "processing"
      ? "正在本地识别与排版"
      : status === "failed"
        ? "转换失败 · 点击重试"
        : mode === "cloze" ? "等待生成完形资料" : "等待生成精读版";
  return (
    <article className={`resource-card ${isCustom ? `custom-resource ${status}` : ""}`}>
      <div className="resource-card-top">
        <span className="resource-badge">{resource.kind === "custom" ? "自定义" : "英语一"}</span>
        {cardStatus?.hasRecords && onOpenSummary && (
          <button type="button" className="resource-summary-button" onClick={onOpenSummary}>
            学习结果
          </button>
        )}
        {onOpenCloze && (
          <button type="button" className="resource-cloze-button" onClick={onOpenCloze}>
            进入完形
          </button>
        )}
        {onDelete && (
          <button className="icon-button subtle" onClick={() => onDelete(resource)} aria-label="删除资料">×</button>
        )}
      </div>
      <button className="resource-open" onClick={() => onOpen(resource)}>
        <strong>{resource.title}</strong>
        <span className="resource-number">{resource.text ? `T${resource.text}` : "PDF"}</span>
        <span>{resource.subtitle}</span>
      </button>
      <div className="resource-meta">
        <span>{isCustom ? customMeta : progress ? `第 ${progress.page}/${progress.total} 页` : "尚未开始"}</span>
        <span>{isCustom ? `${Math.max(0.1, resource.size / 1024 / 1024).toFixed(1)} MB` : "约 15 页"}</span>
      </div>
      {cardStatus?.label && (
        <div className="resource-learning-status">{cardStatus.label}</div>
      )}
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

function ClozeResourceCard({ resource, onOpen, status = null, onOpenSummary = null }) {
  const total = status?.totalBlanks || 20;
  return (
    <article className="resource-card cloze-resource-card">
      <div className="resource-card-top">
        <span className="resource-badge">完形</span>
        {status?.completed && onOpenSummary && (
          <button type="button" className="resource-summary-button" onClick={onOpenSummary}>
            学习结果
          </button>
        )}
      </div>
      <button className="resource-open" type="button" onClick={() => onOpen(resource)}>
        <strong>{resource.title}</strong>
        <span className="resource-number">{resource.year}</span>
        <span>{resource.subtitle}</span>
      </button>
      <div className="resource-meta"><span>{total} 空 · 官方答案</span><span>本地数据</span></div>
      <div className="cloze-resource-note">{status?.label || "尚未开始"}</div>
    </article>
  );
}

function ReadingLibrary(props) {
  return <Library {...props} mode="reading" />;
}

function ClozeLibrary(props) {
  return <Library {...props} mode="cloze" />;
}

function Library({ onBack, onOpen, onOpenCloze, onOpenClozeSummary = null, onUnknownWords, mode }) {
  const [tab, setTab] = useState(mode === "cloze" ? "official" : "postgraduate");
  const [query, setQuery] = useState("");
  const [year, setYear] = useState("all");
  const [customPdfs, setCustomPdfs] = useState([]);
  const [libraryStatus, setLibraryStatus] = useState({});
  const [notice, setNotice] = useState("");
  const [converting, setConverting] = useState(false);
  const [importSession, setImportSession] = useState(null);
  const inputRef = useRef(null);
  const importQueueRef = useRef([]);
  const editorResolveRef = useRef(null);
  const aliveRef = useRef(true);
  const batchResultRef = useRef({ completed: 0, failed: 0, cancelled: 0, errors: [] });

  useEffect(() => {
    // StrictMode 会在开发态执行一次 setup → cleanup → setup；每次 setup 必须恢复 alive，
    // 否则导入队列会在 fingerprint 后误判组件已卸载并永久停在“正在识别”。
    aliveRef.current = true;
    return () => {
      // 组件卸载（用户离开资料库）时终止导入队列：resolve 等待中的编辑器
      // promise 并标记死亡，避免 processImportQueue 永久挂起（R4 修复）。
      aliveRef.current = false;
      editorResolveRef.current?.();
      editorResolveRef.current = null;
    };
  }, []);

  const refreshCustom = () => listCustomPdfs()
    .then(setCustomPdfs)
    .catch((reason) => setNotice(reason instanceof Error ? reason.message : "自定义资料读取失败，请重试"));
  useEffect(() => { refreshCustom(); }, []);
  const refreshStatus = (force = false) => {
    if (mode === "cloze") return;
    setLibraryStatus(buildLibraryStatusMap(scanLearningState({ force }), {
      resources: [...postgraduateResources, ...customPdfs],
    }));
  };
  useEffect(() => {
    if (mode === "cloze") return undefined;
    refreshStatus(true);
    const handle = () => refreshStatus(false);
    window.addEventListener(REVIEW_TASKS_UPDATED, handle);
    const handleFocus = () => refreshStatus(true);
    window.addEventListener("focus", handleFocus);
    const handleAccount = () => refreshStatus(true);
    window.addEventListener("wuliao:account-changed", handleAccount);
    return () => {
      window.removeEventListener(REVIEW_TASKS_UPDATED, handle);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("wuliao:account-changed", handleAccount);
    };
  }, []);
  useEffect(() => {
    refreshStatus(true);
  }, [customPdfs]);

  const filtered = useMemo(() => {
    if (mode === "cloze") return [];
    const term = query.trim().toLowerCase();
    return postgraduateResources.filter((resource) => {
      const matchesYear = year === "all" || resource.year === Number(year);
      const matchesTerm = !term || `${resource.year} text ${resource.text} ${resource.title}`.toLowerCase().includes(term);
      return matchesYear && matchesTerm;
    });
  }, [mode, query, year]);

  const grouped = useMemo(() => {
    return filtered.reduce((groups, resource) => {
      if (!groups[resource.year]) groups[resource.year] = [];
      groups[resource.year].push(resource);
      return groups;
    }, {});
  }, [filtered]);

  const filteredCloze = useMemo(() => {
    if (mode !== "cloze") return [];
    const term = query.trim().toLowerCase();
    return postgraduateClozeResources.filter((resource) => {
      const matchesYear = year === "all" || resource.year === Number(year);
      const matchesTerm = !term || `${resource.year} cloze 完形 ${resource.title}`.toLowerCase().includes(term);
      return matchesYear && matchesTerm;
    });
  }, [mode, query, year]);

  const groupedCloze = useMemo(() => {
    return filteredCloze.reduce((groups, resource) => {
      if (!groups[resource.year]) groups[resource.year] = [];
      groups[resource.year].push(resource);
      return groups;
    }, {});
  }, [filteredCloze]);

  const visibleCustomPdfs = useMemo(
    () => selectCustomLibraryResources(customPdfs, mode),
    [customPdfs, mode],
  );

  const clozeStatusMap = useMemo(() => {
    if (mode !== "cloze") return new Map();
    return scanClozeLibraryStatuses({
      resources: [...postgraduateClozeResources, ...visibleCustomPdfs],
    });
  }, [mode, visibleCustomPdfs]);

  function describeProgress(fileName, progress) {
    if (!progress) return `${fileName}：正在分析试卷`;
    if (progress.phase === "reading") return `${fileName}：读取文件`;
    if (progress.phase === "fingerprint") return `${fileName}：计算文件指纹`;
    if (progress.phase === "ocr-loading") return `${fileName}：正在加载本地 OCR`;
    if (progress.phase === "ocr") return `${fileName}：OCR 第 ${progress.page}/${progress.total} 页（本页 ${progress.pagePercent || 0}%）`;
    if (progress.phase === "text") return `${fileName}：读取 PDF 第 ${progress.page}/${progress.total} 页`;
    if (progress.phase === "quality") return `${fileName}：检查文本质量`;
    if (progress.phase === "structure") return `${fileName}：识别 Section I 与 Text 1–4`;
    if (progress.phase === "done") return `${fileName}：解析完成`;
    return `${fileName}：正在分析文章与习题`;
  }

  // 单个 PDF 解析并保存。返回 { saved, record }；无缓存时打开预览/修正编辑器。
  async function convertResource(resource, { interactive = true } = {}) {
    const processing = await updateCustomPdf(resource.id, {
      conversionStatus: "processing",
      conversionError: "",
    });
    setCustomPdfs((current) => current.map((item) => item.id === resource.id ? processing : item));

    try {
      const fingerprint = resource.fingerprint || await computeFileFingerprint(resource.file);
      const cached = await getParseCache(fingerprint, PDF_PARSER_VERSION);
      if (cached) {
        const ready = await updateCustomPdf(resource.id, {
          analysis: cached,
          fingerprint,
          conversionStatus: "ready",
          convertedAt: Date.now(),
          conversionError: "",
        });
        setCustomPdfs((current) => current.map((item) => item.id === resource.id ? ready : item));
        return { saved: true, record: ready, fromCache: true };
      }

      if (interactive) {
        setImportSession({
          record: resource,
          previousRecord: resource,
          file: resource.file,
          fingerprint,
          cachedAnalysis: null,
          temporary: false,
        });
        await new Promise((resolve) => { editorResolveRef.current = resolve; });
        return { saved: false, record: resource, fromCache: false };
      }

      const { parsePdfFile } = await import("./pdfParser");
      const result = await parsePdfFile(resource.file, (progress) => {
        setNotice(describeProgress(resource.title, progress));
      });
      await setParseCache(fingerprint, PDF_PARSER_VERSION, result.analysis);
      const ready = await updateCustomPdf(resource.id, {
        analysis: result.analysis,
        fingerprint,
        conversionStatus: "ready",
        convertedAt: Date.now(),
        conversionError: "",
      });
      setCustomPdfs((current) => current.map((item) => item.id === resource.id ? ready : item));
      return { saved: true, record: ready, fromCache: false };
    } catch (error) {
      if (error?.code === "cancelled") {
        batchResultRef.current.cancelled += 1;
        return { saved: false, record: resource, fromCache: false };
      }
      const failed = await updateCustomPdf(resource.id, {
        conversionStatus: "failed",
        conversionError: error instanceof Error ? error.message : String(error),
      });
      setCustomPdfs((current) => current.map((item) => item.id === resource.id ? failed : item));
      throw error;
    }
  }

  async function finishImportBatch() {
    if (!aliveRef.current) return;
    const { completed, failed, cancelled } = batchResultRef.current;
    setConverting(false);
    const parts = [];
    if (completed) parts.push(`已保存 ${completed} 份`);
    if (cancelled) parts.push(`${cancelled} 份已取消`);
    if (failed) parts.push(`${failed} 份识别失败，可点击资料重试`);
    if (batchResultRef.current.errors?.[0]) parts.push(batchResultRef.current.errors[0]);
    setNotice(parts.length ? parts.join("，") : "未保存新的资料");
    window.setTimeout(() => setNotice(""), 5200);
  }

  async function processImportQueue() {
    while (importQueueRef.current.length) {
      if (!aliveRef.current) return;
      const file = importQueueRef.current.shift();
      try {
        const fingerprint = await computeFileFingerprint(file);
        if (!aliveRef.current) return;
        const cached = await getParseCache(fingerprint, PDF_PARSER_VERSION);
        const record = await addCustomPdf(file, fingerprint);
        if (!aliveRef.current) return;
        setCustomPdfs((current) => current.some((item) => item.id === record.id) ? current : [record, ...current]);
        if (cached) {
          const ready = await updateCustomPdf(record.id, {
            analysis: cached,
            fingerprint,
            conversionStatus: "ready",
            convertedAt: Date.now(),
            conversionError: "",
          });
          setCustomPdfs((current) => current.map((item) => item.id === ready.id ? ready : item));
          batchResultRef.current.completed += 1;
          continue;
        }
        setImportSession({
          record,
          previousRecord: record,
          file,
          fingerprint,
          cachedAnalysis: null,
          temporary: record.conversionStatus !== "ready",
        });
        await new Promise((resolve) => { editorResolveRef.current = resolve; });
      } catch (error) {
        batchResultRef.current.failed += 1;
        batchResultRef.current.errors.push(importFailureMessage(error));
      }
    }
    await finishImportBatch();
  }

  async function handleUpload(event) {
    const files = [...event.target.files].filter((file) => file.type === "application/pdf" || /\.pdf$/i.test(file.name));
    if (!files.length) return;
    event.target.value = "";
    setTab("custom");
    setConverting(true);
    batchResultRef.current = { completed: 0, failed: 0, cancelled: 0, errors: [] };
    importQueueRef.current = [...importQueueRef.current, ...files];
    await processImportQueue();
  }

  async function handleOpen(resource) {
    if (resource.kind !== "custom" || (resource.conversionStatus === "ready" && resource.analysis?.passages?.length)) {
      onOpen(resource);
      return;
    }

    setConverting(true);
    try {
      const { saved, record } = await convertResource(resource);
      if (saved) {
        setNotice("精读版已生成，正在打开");
        onOpen(record);
      }
    } catch (error) {
      setNotice(`转换失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setConverting(false);
    }
  }

  async function handleOpenClozeResource(resource) {
    if (resource.kind !== "custom") {
      onOpenCloze(resource);
      return;
    }
    if (resource.conversionStatus === "ready") {
      if (resource.analysis?.clozes?.length) onOpenCloze(resource);
      else setNotice("这份 PDF 没有可进入的完形内容");
      return;
    }
    setConverting(true);
    try {
      const { saved, record } = await convertResource(resource);
      if (saved && record.analysis?.clozes?.length) {
        setNotice("完形资料已生成，正在打开");
        onOpenCloze(record);
      } else if (saved) {
        setNotice("识别已完成，但没有发现完形内容");
      }
    } catch (reason) {
      setNotice(`转换失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setConverting(false);
    }
  }

  function handleOpenSummary(resource) {
    onOpen(resource, { summaryInitially: true });
  }

  async function handleDelete(resource) {
    if (!window.confirm(`从自定义库删除“${resource.title}”？`)) return;
    await deleteCustomPdf(resource.id);
    await refreshCustom();
  }

  async function closeImportSession({ discard = true } = {}) {
    const session = importSession;
    setImportSession(null);
    if (discard && session?.record?.id) {
      if (session.temporary) {
        await deleteCustomPdf(session.record.id).catch(() => {});
        setCustomPdfs((current) => current.filter((item) => item.id !== session.record.id));
        batchResultRef.current.cancelled += 1;
      } else if (session.previousRecord) {
        const restored = await updateCustomPdf(session.record.id, {
          conversionStatus: session.previousRecord.conversionStatus || "pending",
          conversionError: session.previousRecord.conversionError || "",
        }).catch(() => null);
        if (restored) setCustomPdfs((current) => current.map((item) => item.id === restored.id ? restored : item));
      }
    }
    editorResolveRef.current?.();
    editorResolveRef.current = null;
  }

  if (importSession) {
    return (
      <Suspense fallback={<RouteLoading label="正在打开导入编辑器…" />}><ExamImportEditor
        record={importSession.record}
        file={importSession.file}
        fingerprint={importSession.fingerprint}
        cachedAnalysis={importSession.cachedAnalysis}
        onClose={closeImportSession}
        onSave={async (analysis) => {
          const ready = await updateCustomPdf(importSession.record.id, {
            analysis,
            fingerprint: importSession.fingerprint,
            conversionStatus: "ready",
            convertedAt: Date.now(),
            conversionError: "",
          });
          setCustomPdfs((current) => current.map((item) => item.id === ready.id ? ready : item));
          batchResultRef.current.completed += 1;
          await closeImportSession({ discard: false });
        }}
      /></Suspense>
    );
  }

  return (
    <div className="library-page">
      <header className="library-header">
        <button className="back-button" onClick={onBack}>← 返回</button>
        <Brand compact />
      </header>
      <div className="library-action-strip">
        <div className="library-header-actions">
          <button className="unknown-library-button" onClick={onUnknownWords}><Icon name="vocabulary" size={17} />陌生词库</button>
          <button className="upload-button" disabled={converting} onClick={() => inputRef.current?.click()}><Icon name="upload" size={17} />{converting ? "正在识别…" : "上传 PDF"}</button>
        </div>
        <input ref={inputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleUpload} />
      </div>

      <main className="library-main">
        <section className="library-intro">
          <div>
            <h1>{mode === "cloze" ? "完形资料库" : "精读资料库"}</h1>
          </div>
          <div className="library-count">
            <strong>{mode === "cloze" ? postgraduateClozeResources.length : postgraduateResources.length}</strong>
            <span>{mode === "cloze" ? "篇考研完形" : "篇考研精读"}</span>
          </div>
        </section>

        <nav className="library-tabs" aria-label="题库分类" role="tablist">
          {(mode === "cloze" ? [
            ["official", "考研真题", String(postgraduateClozeResources.length)],
            ["custom", "自定义库", String(visibleCustomPdfs.length)],
          ] : [
            ["postgraduate", "考研真题", String(postgraduateResources.length)],
            ["gaokao", "高考真题", "保留"],
            ["zhongkao", "中考真题", "保留"],
            ["custom", "自定义库", String(visibleCustomPdfs.length)],
          ]).map(([value, label, count]) => (
            <button
              type="button"
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "active" : ""}
              onClick={() => setTab(value)}
            >
              {label}<span>{count}</span>
            </button>
          ))}
        </nav>

        {tab === "postgraduate" && (
          <>
            <div className="library-tools">
              <label className="search-box"><Icon name="search" size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索年份或 Text" /></label>
              <select value={year} onChange={(event) => setYear(event.target.value)} aria-label="按年份筛选">
                <option value="all">全部年份 · 2007–2023</option>
                {Array.from({ length: 17 }, (_, index) => 2023 - index).map((value) => <option key={value} value={value}>{value} 年</option>)}
              </select>
              <span className="result-count">{filtered.length} 篇</span>
            </div>
            <div className="year-groups">
              {Object.entries(grouped).sort(([a], [b]) => Number(b) - Number(a)).map(([groupYear, resources]) => (
                <section className="year-group" key={groupYear}>
                  <div className="year-heading"><strong>{groupYear}</strong><span>{resources.length} 篇</span></div>
                  <div className="resource-grid">
                    {resources.map((resource) => (
                      <ResourceCard
                        key={resource.id}
                        resource={resource}
                        onOpen={handleOpen}
                        cardStatus={libraryStatus[resource.id]}
                        onOpenSummary={() => handleOpenSummary(resource)}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {mode === "cloze" && tab === "official" && (
          <>
            <div className="library-tools">
              <label className="search-box"><Icon name="search" size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索年份或完形" /></label>
              <select value={year} onChange={(event) => setYear(event.target.value)} aria-label="按年份筛选完形">
                <option value="all">全部年份 · 2007–2023</option>
                {Array.from({ length: 17 }, (_, index) => 2023 - index).map((value) => <option key={value} value={value}>{value} 年</option>)}
              </select>
              <span className="result-count">{filteredCloze.length} 篇</span>
            </div>
            <div className="year-groups">
              {Object.entries(groupedCloze).sort(([a], [b]) => Number(b) - Number(a)).map(([groupYear, resources]) => (
                <section className="year-group" key={groupYear}>
                  <div className="year-heading"><strong>{groupYear}</strong><span>{resources.length} 篇</span></div>
                  <div className="resource-grid">
                    {resources.map((resource) => (
                      <ClozeResourceCard
                        key={resource.id}
                        resource={resource}
                        onOpen={onOpenCloze}
                        status={clozeStatusMap.get(resource.id)}
                        onOpenSummary={onOpenClozeSummary
                          ? () => onOpenClozeSummary(resource)
                          : null}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}

        {(tab === "gaokao" || tab === "zhongkao") && <EmptyLibrary type={tab === "gaokao" ? "高考" : "中考"} />}

        {tab === "custom" && (
          visibleCustomPdfs.length ? (
            <div className="resource-grid custom-grid">
              {visibleCustomPdfs.map((resource) => (
                <ResourceCard
                  key={resource.id}
                  resource={resource}
                  mode={mode}
                  onOpen={mode === "cloze" ? handleOpenClozeResource : handleOpen}
                  onDelete={handleDelete}
                  cardStatus={mode === "cloze" ? clozeStatusMap.get(resource.id) : mode === "reading" ? libraryStatus[resource.id] : null}
                  onOpenSummary={
                    mode === "reading" && resource.conversionStatus === "ready" && resource.analysis?.passages?.length
                      ? () => handleOpenSummary(resource)
                      : mode === "cloze" && cardStatus?.completed && onOpenClozeSummary
                        ? () => onOpenClozeSummary(resource)
                        : null
                  }
                />
              ))}
            </div>
            ) : (
            <button
              type="button"
              className="empty-library-trigger"
              onClick={() => inputRef.current?.click()}
            >
              <EmptyLibrary type="custom" />
            </button>
            )
          )}
      </main>
      {notice && <div className="toast">✓ {notice}</div>}
    </div>
  );
}

function OfficialDeepReader({
  resource,
  onClose,
  reviewTaskKey = "",
  summaryInitially = false,
  summaryTabInitially = "summary",
  onRequestReview = null,
}) {
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
      const { parsePdfFile } = await import("./pdfParser");
      const nextAnalysis = await parsePdfFile(file, (progress) => {
        if (cancelled) return;
        if (progress.phase === "reading") setStatus("正在读取考研真题 PDF");
        if (progress.phase === "text") setStatus(`正在读取文字层（第 ${progress.page}/${progress.total} 页）`);
        if (progress.phase === "quality") setStatus("正在检查文字层");
        if (progress.phase === "structure") setStatus("正在结构化文章");
        if (progress.phase === "done") setStatus("解析完成");
      }, {
        signal: controller.signal,
        parserVersion: PDF_PARSER_VERSION,
        ocrPolicy: "disabled",
      });
      if (cancelled) return;
      officialAnalysisCache.set(resource.id, nextAnalysis.analysis);
      setAnalysis(nextAnalysis.analysis);
    })().catch((reason) => {
      if (!cancelled && reason?.name !== "AbortError" && reason?.code !== "cancelled") {
        console.error("[OfficialDeepReader] workbook parse failed", {
          resourceId: resource.id,
          year: resource.year,
          text: resource.text,
          parserVersion: PDF_PARSER_VERSION,
          code: reason?.code || "unknown",
          pageQuality: reason?.diagnostics?.pageQuality || null,
          cause: reason?.cause || null,
        });
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [analysis, attempt, resource.id, resource.source, resource.text, resource.workbookSource, resource.year]);

  if (analysis) {
    return (
      <CustomDeepReader
        resource={{ ...resource, analysis }}
        onClose={onClose}
        reviewTaskKey={reviewTaskKey}
        summaryInitially={summaryInitially}
        summaryTabInitially={summaryTabInitially}
        onRequestReview={onRequestReview}
      />
    );
  }

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

function WorkspaceApp({ username, onSwitchAccount, onReady }) {
  const leaveTaskRef = useRef(null);
  function leaveAfterSave(action) {
    if (leaveTaskRef.current) return leaveTaskRef.current;
    leaveTaskRef.current = (async () => {
      try {
        await flushPendingSaves();
        await flushDurableInk(username);
        window.dispatchEvent(new Event("wuliao:save-succeeded"));
        action();
      } catch { reportSaveFailure(); }
      finally { leaveTaskRef.current = null; }
    })();
    return leaveTaskRef.current;
  }
  useEffect(() => {
    const flush = () => backgroundSave(async () => { await flushPendingSaves(); await flushDurableInk(username); });
    const hidden = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", hidden); };
  }, [username]);
  const initialHostVocabularyRoute = vocabularyRouteFromHost();
  const initialVocabularyRoute = initialHostVocabularyRoute === "/screening"
    ? "/screening/1"
    : initialHostVocabularyRoute;
  const initialReadingRoute = readingRouteFromHost();
  const initialExamRoute = examRouteFromHost();
  const initialWritingRoute = writingRouteFromHost();
  const [nav, setNav] = useState(() => ({
    view: initialWritingRoute?.view || initialExamRoute?.view || initialReadingRoute?.view || (initialVocabularyRoute ? "vocabulary" : "home"),
    stack: [],
  }));
  const [vocabularyRoute, setVocabularyRoute] = useState(initialVocabularyRoute || "/lists");
  const [vocabularyMode, setVocabularyMode] = useState("spa");
  const [vocabularyStaticPage, setVocabularyStaticPage] = useState("");
  const [vocabularyReloadNonce, setVocabularyReloadNonce] = useState(0);
  const [activeResource, setActiveResource] = useState(null);
  const [activeCloze, setActiveCloze] = useState(null);
  const [activeClozeId, setActiveClozeId] = useState(initialReadingRoute?.view === "cloze" ? initialReadingRoute.resourceId : "");
  const [activeClozeReviewTaskKey, setActiveClozeReviewTaskKey] = useState("");
  const [writingSessionId, setWritingSessionId] = useState(initialWritingRoute?.sessionId || "");
  const [writingImmersive, setWritingImmersive] = useState(false);
  const [clozeSummaryTarget, setClozeSummaryTarget] = useState(null);
  const [restoreChecked, setRestoreChecked] = useState(false);
  const [reviewTaskKey, setReviewTaskKey] = useState("");
  const [readerOptions, setReaderOptions] = useState({});
  const [aiApiOpen, setAiApiOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [labOpen, setLabOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [examYear, setExamYear] = useState(initialExamRoute?.year || null);
  const [examPaper, setExamPaper] = useState(null);
  const [examSession, setExamSession] = useState(null);
  const [examResult, setExamResult] = useState(null);
  const [examHistory, setExamHistory] = useState([]);
  const [examAbandonedHistory, setExamAbandonedHistory] = useState([]);
  const [examLoading, setExamLoading] = useState(false);
  const [examError, setExamError] = useState("");
  const [homeReady, setHomeReady] = useState(false);
  const markHomeReady = useCallback(() => setHomeReady(true), []);
  const objectUrlRef = useRef(null);
  const pendingVocabularyBackRef = useRef(false);
  const vocabularyStaticOriginRef = useRef(null);
  const vocabularyFreshStaticRef = useRef(false);
  const backControllerRef = useRef(null);
  const navRef = useRef(null);
  const appBackRef = useRef(null);
  const activeClozeIdRef = useRef("");
  const writingSessionIdRef = useRef("");
  const writingLeaveBarrierRef = useRef(null);
  if (!backControllerRef.current) backControllerRef.current = createBackController();
  const vocabularyBridgeRef = useRef(null);
  if (!vocabularyBridgeRef.current) {
    vocabularyBridgeRef.current = createVocabularyBridge({
      frameWindow: () => document.querySelector(".vocabulary-frame")?.contentWindow || null,
      messageTargetOrigin: frameMessageTargetOrigin,
      expectedOrigin: usesHttpMessagingOrigin() ? window.location.origin : "",
    });
  }
  const vocabularyBridge = vocabularyBridgeRef.current;
  navRef.current = nav;
  activeClozeIdRef.current = activeClozeId;
  writingSessionIdRef.current = writingSessionId;

  useEffect(() => {
    const preload = () => {
      void Promise.allSettled([
        loadCustomDeepReader(),
        loadClozeReader(),
        loadClozeReviewSession(),
      ]);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(preload, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 1200);
    return () => window.clearTimeout(id);
  }, []);

  const writingInkFlushBridge = useMemo(() => createWritingInkFlushBridge(), [username]);
  const writingServices = useMemo(
    () => createWritingAppServices({ username, inkFlushBridge: writingInkFlushBridge }),
    [username, writingInkFlushBridge],
  );

  const examSessionRepository = useMemo(() => new ExamSessionRepository({ username }), [username]);
  const examResultRepository = useMemo(() => new ExamResultRepository({ username }), [username]);
  const examHandoffRepository = useMemo(() => new ExamHandoffRepository({ username }), [username]);
  const examControllerRef = useRef(null);
  const examSubmittingRef = useRef(false);
  const examSessionRef = useRef(examSession);
  const examMutationQueueRef = useRef(Promise.resolve());
  const examInkFlushesRef = useRef(new Map());
  const examInkRefsRef = useRef({});
  const examInkStatusRef = useRef("complete");
  examSessionRef.current = examSession;

  function resetExamInkRuntime(inkRefs = {}) {
    examInkFlushesRef.current.clear();
    examInkRefsRef.current = { ...(inkRefs || {}) };
    examInkStatusRef.current = "complete";
  }

  // Ink Registry（修改 7）：valid ref → add/update；null → 删除该 surface 的旧 entry。
  // 防止 source-mismatch / damaged / clear / invalid snapshot 后交卷仍引用失效历史 ref。
  function updateExamInkRegistry(surfaceId, ref) {
    examInkRefsRef.current = examInkRegistryUpsert(examInkRefsRef.current, surfaceId, ref);
  }

  function mergeExamInkFlushOutcome(outcome) {
    const merged = mergeExamInkRegistryWithFlush(examInkRefsRef.current, outcome);
    examInkRefsRef.current = merged.registry;
    if (merged.partial) examInkStatusRef.current = "partial";
  }

  useEffect(() => {
    let active = true;
    const auditTerminalResults = async () => {
      const sessions = await examSessionRepository.listAll();
      for (const session of sessions) {
        if (!active || session?.damaged || (session?.status !== ExamStatus.SUBMITTED && session?.status !== ExamStatus.TIMED_OUT)) continue;
        let result = null;
        try {
          result = await examResultRepository.read(session.sessionId);
        } catch {
          if (active) setExamError("检测到损坏的考试 Result，已保持只读且未恢复答题。");
          continue;
        }
        if (result) continue;
        const rebuilt = await rebuildTerminalResult(session);
        if (!rebuilt) {
          if (active) setExamError("终态考试缺少且无法验证 Result，已保持只读 damaged 状态。");
          continue;
        }
        try {
          await examResultRepository.createOnce(rebuilt);
        } catch {
          if (active) setExamError("终态 Result 重建发生指纹冲突，已保持只读 damaged 状态。");
        }
      }
      if (!active) return;
      const records = await examResultRepository.list();
      if (active) setExamHistory(records.map((record) => ({ ...record, handoffTargets: deriveHandoffTargets(record) })));
    };
    auditTerminalResults().catch((error) => console.warn("[X1] terminal result audit failed", error));
    return () => { active = false; };
  }, [examResultRepository, examSessionRepository]);

  async function openExamCover(year) {
    setExamYear(year);
    setExamPaper(null);
    setExamError("");
    setExamLoading(true);
    navigateTo("exam-cover");
    window.history.pushState(window.history.state, "", examHostHash({ view: "exam-cover", year }));
    try {
      const paper = await preflightX1Paper(year, { onProgress: () => {} });
      setExamPaper(paper);
    } catch (error) {
      setExamError(error instanceof Error ? error.message : String(error));
    } finally { setExamLoading(false); }
  }

  async function beginExam() {
    if (!examPaper) return;
    const activeSessions = await examSessionRepository.listActive();
    if (activeSessions.length) {
      setExamError(activeSessions.length > 1 ? "检测到多个未完成考试，需先处理数据冲突。" : "当前账号已有未完成考试，请先继续或放弃。");
      return;
    }
    const session = await createExamSession({ username, year: examPaper.year, items: examPaper.items, sourceFingerprint: examPaper.sourceFingerprint });
    await examSessionRepository.write(session, {});
    resetExamInkRuntime();
    examControllerRef.current = createSessionController(session.sessionId);
    examMutationQueueRef.current = Promise.resolve();
    examSessionRef.current = session;
    setExamSession(session);
    emitAppEvent(AppEvent.EXAM_SESSIONS_UPDATED, { username, sessionId: session.sessionId, reason: "created" });
    navigateTo("exam-session");
    window.history.pushState(window.history.state, "", examHostHash({ view: "exam-session", sessionId: session.sessionId }));
  }

  function enqueueExamMutation(createNext) {
    const operation = examMutationQueueRef.current.catch(() => {}).then(async () => {
      const current = examSessionRef.current;
      if (!current || current.status !== ExamStatus.IN_PROGRESS || !examControllerRef.current?.active) return current;
      const next = await createNext(current);
      const saved = await examSessionRepository.write(next, { expectedRevision: current.revision, controller: examControllerRef.current });
      examSessionRef.current = saved;
      setExamSession(saved);
      emitAppEvent(AppEvent.EXAM_SESSIONS_UPDATED, { username, sessionId: saved.sessionId, reason: "updated" });
      return saved;
    });
    examMutationQueueRef.current = operation.catch(() => {});
    return operation;
  }

  async function handleExamMutationFailure(error) {
    if (error instanceof ExamTimeoutError) {
      await submitCurrentExam(ExamStatus.TIMED_OUT);
      return;
    }
    if (!examControllerRef.current?.active) {
      setExamError("考试数据已发生冲突，当前页面已锁定，请重新加载最新进度。");
      return;
    }
    console.warn("[X1] exam mutation failed", error);
    setExamError(error instanceof Error ? error.message : String(error));
  }

  async function answerExam(itemId, answer) {
    try {
      await enqueueExamMutation((current) => answerExamItem(current, itemId, answer));
    } catch (error) {
      await handleExamMutationFailure(error);
    }
  }

  // Surface Transaction（修改 4/5）：真正的 Surface 切换（cloze ↔ reading / text ↔ text）
  // 必须显式 flush previous Surface 并 merge verified inkRef；同 Surface 内切题（如 Q21 → Q22）
  // 不做额外 flush，避免每答一题都引入 IndexedDB write barrier。
  // 统一通过 examSurfaceIdForItem 判断，杜绝多套 Surface 判断实现。
  async function navigateExam(itemId) {
    try {
      await enqueueExamMutation(async (current) => {
        const previous = current.items.find((entry) => entry.id === current.currentItemId);
        const target = current.items.find((entry) => entry.id === itemId);
        const decision = examSurfaceFlushDecision(previous, target);
        if (decision.shouldFlush) {
          try {
            const outcome = await examInkFlushesRef.current.get(decision.previousSurface)?.();
            if (outcome) mergeExamInkFlushOutcome(outcome);
          } catch {
            // Flush 失败不能阻塞考试导航：标记 partial，保留 last verified inkRef。
            examInkStatusRef.current = "partial";
          }
        }
        return updateSession(current, { currentItemId: itemId, inkRefs: examInkRefsRef.current });
      });
    } catch (error) {
      await handleExamMutationFailure(error);
    }
  }

  async function finishExamSession(session, reason = ExamStatus.SUBMITTED) {
    if (!session || session.status !== ExamStatus.IN_PROGRESS) return;
    if (!examControllerRef.current?.active) return;
    if (examSubmittingRef.current) return;
    examSubmittingRef.current = true;
    let submitted;
    try {
      submitted = await submitExam({ session, sessionRepository: examSessionRepository, resultRepository: examResultRepository, expectedRevision: session.revision, reason, controller: examControllerRef.current, flushInk: async () => {
        const settled = await Promise.allSettled([...examInkFlushesRef.current.values()].map((flush) => flush?.()));
        const inkRefs = { ...examInkRefsRef.current };
        settled.forEach((entry) => {
          if (entry.status === "fulfilled") {
            mergeExamInkFlushOutcome(entry.value);
            Object.assign(inkRefs, entry.value?.inkRefs || {});
          } else examInkStatusRef.current = "partial";
        });
        return { inkRefs: { ...inkRefs, ...examInkRefsRef.current }, inkStatus: examInkStatusRef.current };
      } });
    } finally { examSubmittingRef.current = false; }
    const result = { ...submitted.result, handoffTargets: deriveHandoffTargets(submitted.result) };
    examSessionRef.current = submitted.session;
    setExamSession(submitted.session);
    setExamResult(result);
    setExamHistory((current) => [result, ...current.filter((entry) => entry.id !== result.id)]);
    emitAppEvent(AppEvent.EXAM_SESSIONS_UPDATED, { username, sessionId: submitted.session.sessionId, reason });
    emitAppEvent(AppEvent.EXAM_RESULTS_UPDATED, { username, resultId: result.id, reason });
    navigateTo("exam-result");
    window.history.pushState(window.history.state, "", examHostHash({ view: "exam-result", resultId: result.id }));
  }

  async function submitCurrentExam(reason = ExamStatus.SUBMITTED) {
    await examMutationQueueRef.current;
    if (!examControllerRef.current?.active) return;
    return finishExamSession(examSessionRef.current, reason);
  }

  async function saveExamHandoff(targetIds) {
    if (!examResult) return;
    for (const targetId of targetIds.slice(0, 5)) {
      const current = await examHandoffRepository.read(examResult.id, targetId);
      const next = await createOrUpdateHandoff({ username, examResultId: examResult.id, targetId, current });
      await examHandoffRepository.save(next, { expectedRevision: current?.revision });
    }
    emitAppEvent(AppEvent.EXAM_HANDOFF_UPDATED, { username, resultId: examResult.id, reason: "selected" });
  }

  async function abandonCurrentExam() {
    if (!examSession || examSession.status !== ExamStatus.IN_PROGRESS || !window.confirm("放弃后不能继续答题，确认放弃？")) return;
    let inkStatus = examInkStatusRef.current;
    try {
      await Promise.race([
        Promise.allSettled([...examInkFlushesRef.current.values()].map((flush) => flush?.())).then((entries) => {
          entries.forEach((entry) => {
            if (entry.status === "fulfilled") {
              mergeExamInkFlushOutcome(entry.value);
              if (entry.value?.inkStatus === "partial") inkStatus = "partial";
            } else inkStatus = "partial";
          });
        }),
        new Promise((resolve) => window.setTimeout(() => { inkStatus = "partial"; resolve(); }, 1500)),
      ]);
    } catch { inkStatus = "partial"; }
    const abandoned = await abandonExamSession(examSession, { inkRefs: examInkRefsRef.current, inkStatus });
    await examSessionRepository.write(abandoned, { expectedRevision: examSession.revision, controller: examControllerRef.current });
    setExamSession(abandoned);
    emitAppEvent(AppEvent.EXAM_SESSIONS_UPDATED, { username, sessionId: abandoned.sessionId, reason: "abandoned" });
    navigateTo("exam-library");
  }

  async function loadExamSessionSafely(sessionId, { openView = true } = {}) {
    const activeSessions = await examSessionRepository.listActive();
    if (activeSessions.length > 1) { setExamError("检测到多个未完成考试，已进入冲突保护，不能继续作答。"); return null; }
    const saved = await examSessionRepository.read(sessionId);
    if (!saved) return null;
    if (saved.status !== ExamStatus.IN_PROGRESS) {
      setExamSession(saved);
      const existingResult = await examResultRepository.read(saved.sessionId);
      if (existingResult) {
        const result = { ...existingResult, handoffTargets: deriveHandoffTargets(existingResult) };
        setExamResult(result);
        if (openView) {
          navigateTo("exam-result");
          window.history.replaceState(window.history.state, "", examHostHash({ view: "exam-result", resultId: result.id }));
        }
      }
      return saved;
    }
    resetExamInkRuntime(saved.inkRefs);
    examControllerRef.current = createSessionController(saved.sessionId);
    const fencedResult = await examResultRepository.read(saved.sessionId);
    if (fencedResult) { await finishExamSession(saved, fencedResult.reason); return null; }
    const restored = reconcileSessionOnLoad(saved);
    if (restored.action === "timed_out") { await finishExamSession(restored.session, ExamStatus.TIMED_OUT); return null; }
    setExamSession(restored.session);
    if (openView) navigateTo("exam-session");
    return restored.session;
  }

  async function reloadCurrentExam() {
    if (!examSession?.sessionId) return;
    setExamError("");
    try {
      await loadExamSessionSafely(examSession.sessionId, { openView: true });
    } catch (error) {
      setExamError(error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    let active = true;
    const hydrateExamRoute = async () => {
      const route = examRouteFromHost();
      if (!route) return;
      if (route.view === "exam-cover" && route.year) {
        setExamYear(route.year);
        setExamPaper(null);
        setExamError("");
        setExamLoading(true);
        try {
          const paper = await preflightX1Paper(route.year, { onProgress: () => {} });
          if (active) setExamPaper(paper);
        } catch (error) {
          if (active) setExamError(error instanceof Error ? error.message : String(error));
        } finally {
          if (active) setExamLoading(false);
        }
        return;
      }
      if (route.view === "exam-session" && route.sessionId) {
        await loadExamSessionSafely(route.sessionId, { openView: false });
        return;
      }
      if (route.view === "exam-result" && route.resultId) {
        const records = await examResultRepository.list();
        const result = records.find((entry) => entry.id === route.resultId);
        if (active && result) setExamResult({ ...result, handoffTargets: deriveHandoffTargets(result) });
      }
    };
    hydrateExamRoute().catch((error) => {
      if (active) setExamError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [username]);

  async function openExamFollowup(record) {
    if (!record?.examResultId || !record?.targetId) return;
    const current = await examHandoffRepository.read(record.examResultId, record.targetId);
    if (current?.status === "selected") {
      const next = await createOrUpdateHandoff({ username, examResultId: current.examResultId, targetId: current.targetId, status: "started", current });
      await examHandoffRepository.save(next, { expectedRevision: current.revision });
      emitAppEvent(AppEvent.EXAM_HANDOFF_UPDATED, { username, resultId: current.examResultId, reason: "started" });
    }
    const resourceId = String(record.targetId).replace(/^(?:cloze|reading):/, "");
    const cloze = postgraduateClozeResources.find((resource) => resource.id === resourceId);
    if (cloze) { openCloze(cloze); return; }
    const reading = postgraduateResources.find((resource) => resource.id === resourceId);
    if (reading) openResource(reading);
  }

  async function updateExamFollowup(record, status) {
    if (!record?.examResultId || !record?.targetId) return;
    const current = await examHandoffRepository.read(record.examResultId, record.targetId);
    if (!current || current.status === status) return;
    const next = await createOrUpdateHandoff({
      username,
      examResultId: current.examResultId,
      targetId: current.targetId,
      status,
      current,
    });
    await examHandoffRepository.save(next, { expectedRevision: current.revision });
    emitAppEvent(AppEvent.EXAM_HANDOFF_UPDATED, { username, resultId: current.examResultId, reason: status });
  }

  useEffect(() => {
    let active = true;
    const restore = async () => {
      if (examRouteFromHost()?.view === "exam-session") return;
      const activeSessions = await examSessionRepository.listActive();
      if (activeSessions.length > 1) { if (active) setExamError("检测到多个未完成考试，已停止考试入口；请在数据恢复页处理冲突。"); return; }
      const candidate = activeSessions[0]?.sessionId;
      if (!candidate) return;
      try {
        await loadExamSessionSafely(candidate, { openView: false });
      } catch (error) { console.warn("[X1] session restore failed", error); }
    };
    restore();
    return () => { active = false; };
  }, [username]);

  useEffect(() => {
    let active = true;
    examSessionRepository.listAll().then((sessions) => {
      if (active) setExamAbandonedHistory(sessions.filter((session) => session?.status === ExamStatus.ABANDONED || session?.damaged));
    }).catch(() => {});
    return () => { active = false; };
  }, [examSessionRepository, examSession]);

  useEffect(() => {
    const onStorage = (event) => {
      const controller = examControllerRef.current;
      if (controller?.observeStorageEvent(event, username)) {
        setExamError("考试数据已在另一运行环境变更，请重新加载最新进度。");
        return;
      }
      if (controller?.observeResultStorageEvent(event, username)) {
        setExamError("另一运行环境已生成本次考试结果，正在锁定并恢复终态。");
        loadExamSessionSafely(controller.sessionId, { openView: true }).catch((error) => {
          setExamError(error instanceof Error ? error.message : String(error));
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [username]);


  function refreshAiConfiguration() {
    getAiApiKey().then((value) => setAiConfigured(Boolean(value)));
  }

  useEffect(() => {
    let active = true;
    getAiApiKey().then((value) => {
      if (active) setAiConfigured(Boolean(value));
    });
    return () => { active = false; };
  }, []);

  function navigateTo(next) {
    startTransition(() => {
      setNav((current) => (
        current.view === next
          ? current
          : { view: next, stack: [...current.stack, current.view] }
      ));
    });
  }

  function openWritingSession(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) return;
    setWritingSessionId(id);
    setWritingImmersive(false);
    navigateTo("writing-session");
    window.history.pushState(window.history.state, "", writingHostHash({ view: "writing-session", sessionId: id }));
  }

  function closeWritingWorkspace(saved = false) {
    if (saved !== true) return leaveAfterSave(() => closeWritingWorkspace(true));
    setWritingImmersive(false);
    setWritingSessionId("");
    window.history.replaceState(window.history.state, "", writingHostHash({ view: "writing-library" }));
    setNav({ view: "writing-library", stack: [] });
  }

  function goBack(saved = false) {
    if (saved !== true) return leaveAfterSave(() => goBack(true));
    const current = navRef.current;
    const destination = navigationBackTarget(current.stack);
    if (destination === "writing-library") {
      window.history.replaceState(window.history.state, "", writingHostHash({ view: "writing-library" }));
      setWritingSessionId("");
    } else if (destination === "library" || destination === "cloze-library") {
      window.history.replaceState(window.history.state, "", readingHostHash({ view: destination }));
    } else if (readingRouteFromHost()) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    } else if (destination === "exam-library" || destination === "exam-history") {
      window.history.replaceState(window.history.state, "", examHostHash({ view: destination }));
    } else if (examRouteFromHost() && !String(destination).startsWith("exam-")) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    } else if (writingRouteFromHost() && !String(destination).startsWith("writing-")) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    setNav(current.stack.length
      ? { view: destination, stack: current.stack.slice(0, -1) }
      : { view: "home", stack: [] });
  }

  function syncVocabularyHostRoute(route, { replace = true } = {}) {
    if (!isVocabularySpaRoute(route)) return;
    const normalized = normalizeVocabularyRoute(route);
    const method = replace ? "replaceState" : "pushState";
    window.history[method](window.history.state, "", vocabularyHostHash(normalized));
    setVocabularyRoute(route);
  }

  function openResource(resource, options = {}) {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    let prepared = resource;
    if (resource.kind === "custom") {
      const source = URL.createObjectURL(resource.file);
      objectUrlRef.current = source;
      prepared = { ...resource, source };
    }
    setActiveResource(prepared);
    setReaderOptions(options);
    navigateTo("reader");
  }

  function openCloze(resource) {
    setActiveCloze(resource);
    setActiveClozeId(resource.id);
    window.history.replaceState(window.history.state, "", readingHostHash({ view: "cloze", resourceId: resource.id }));
    navigateTo("cloze");
  }

  function closeCloze(saved = false) {
    if (saved !== true) return leaveAfterSave(() => closeCloze(true));
    const destination = navigationBackTarget(navRef.current.stack);
    if (destination === "library" || destination === "cloze-library") {
      window.history.replaceState(window.history.state, "", readingHostHash({ view: destination }));
    } else {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    setActiveCloze(null);
    setActiveClozeId("");
    goBack(true);
  }

  // E 阶段：打开完形长期复习会话（D+1 / D+7）。
  async function openClozeReview(task) {
    const official = postgraduateClozeResources.find((resource) => resource.id === task.resourceId);
    let resource = official || null;
    if (!resource) {
      const custom = await listCustomPdfs();
      resource = custom.find((item) => item.id === task.resourceId) || null;
    }
    if (!resource) return false;
    setActiveClozeReviewTaskKey(task.taskKey);
    navigateTo("cloze-review");
    return true;
  }

  // R6：打开"本篇完形学习结果"。completedAt 为 null 时由结果页自行解析最新完成记录。
  function openClozeLearningSummary({ resourceId, clozeId = "", completedAt = null }) {
    setClozeSummaryTarget({ resourceId, clozeId, completedAt });
  }

  // R6 入口 B：资料卡"学习结果"——按该资源最新完成记录即时派生，零 backfill。
  function openClozeSummaryForResource(resource) {
    const latest = listCompletedClozeRecords().find((record) => (
      String(record.resourceId) === String(resource.id)
    ));
    if (latest) openClozeLearningSummary({ resourceId: latest.resourceId, clozeId: latest.clozeId, completedAt: latest.completedAt });
  }

  function startClozeReviewFromSummary(task) {
    setClozeSummaryTarget(null);
    openClozeReview(task);
  }

  function closeClozeReview(saved = false) {
    if (saved !== true) return leaveAfterSave(() => closeClozeReview(true));
    setActiveClozeReviewTaskKey("");
    goBack(true);
  }

  function closeReader(saved = false) {
    if (saved !== true) return leaveAfterSave(() => closeReader(true));
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setActiveResource(null);
    setReviewTaskKey("");
    setReaderOptions({});
    goBack(true);
  }

  useEffect(() => {
    if (restoreChecked) return;
    if (nav.view !== "cloze" || activeCloze) {
      setRestoreChecked(true);
      return;
    }
    if (!activeClozeId) {
      setRestoreChecked(true);
      return;
    }
    const official = postgraduateClozeResources.find((resource) => resource.id === activeClozeId);
    if (official) {
      setActiveCloze(official);
      setRestoreChecked(true);
      return;
    }
    listCustomPdfs().then((items) => {
      const custom = items.find((resource) => resource.id === activeClozeId);
      if (custom) setActiveCloze(custom);
      setRestoreChecked(true);
    }).catch(() => setRestoreChecked(true));
  }, [restoreChecked, nav.view, activeCloze, activeClozeId]);

  useEffect(() => {
    if (!restoreChecked) return;
    if (nav.view !== "home" || homeReady) onReady?.();
  }, [homeReady, nav.view, onReady, restoreChecked]);

  async function startReview(task) {
    const official = postgraduateResources.find((resource) => resource.id === task.resourceId);
    let resource = official || null;
    if (!resource) {
      const custom = await listCustomPdfs();
      resource = custom.find((item) => item.id === task.resourceId) || null;
    }
    if (!resource) return false;
    setReviewTaskKey(task.taskKey);
    openResource(resource);
    return true;
  }

  function openVocabularyWorkspace(workspace) {
    if (workspace.kind === "static") {
      if (vocabularyRouteFromHost()) {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
      }
      vocabularyStaticOriginRef.current = null;
      vocabularyFreshStaticRef.current = true;
      setVocabularyMode("static");
      setVocabularyStaticPage(workspace.page);
      navigateTo("vocabulary");
      return;
    }
    syncVocabularyHostRoute(workspace.route, { replace: false });
    setVocabularyMode("spa");
    setVocabularyStaticPage("");
    navigateTo("vocabulary");
  }

  function openVocabularyReview() {
    openVocabularyWorkspace({
      kind: "static",
      page: "review",
      src: `/vocabulary/review.html?embedded=1&date=${encodeURIComponent(localDateKey())}`,
      label: "复习",
    });
  }

  function closeVocabulary() {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    goBack();
  }

  function handleVocabularyRouteChange(route) {
    if (!isVocabularySpaRoute(route)) return;
    if (vocabularyFreshStaticRef.current) return;
    if (vocabularyMode === "static") {
      vocabularyStaticOriginRef.current = { kind: "static", page: vocabularyStaticPage };
    }
    setVocabularyMode("spa");
    setVocabularyStaticPage("");
    syncVocabularyHostRoute(route);
  }

  function navigateFromShell(view, route = "", page = "", afterWritingBarrier = false, saved = false) {
    if (!saved) return leaveAfterSave(() => navigateFromShell(view, route, page, afterWritingBarrier, true));
    if (!afterWritingBarrier && navRef.current.view === "writing-session" && writingLeaveBarrierRef.current) {
      Promise.resolve(writingLeaveBarrierRef.current())
        .then(() => navigateFromShell(view, route, page, true, true))
        .catch(() => {});
      return;
    }
    if (view === "vocabulary") {
      const currentFrame = document.querySelector(".vocabulary-frame");
      const currentFramePath = currentFrame?.contentWindow?.location?.pathname || "";
      const currentFrameIsStatic = /\/vocabulary\/(memorize|review|import)\.html/.test(currentFramePath);
      const item = PRIMARY_NAV.find((entry) => (
        entry.view === "vocabulary"
        && (page ? entry.page === page : entry.route === route)
      ));
      const workspace = vocabularyWorkspaceFor(item);
      if (!workspace) return;
      if (workspace.kind === "static") {
        if (vocabularyRouteFromHost()) {
          window.history.replaceState(
            window.history.state,
            "",
            window.location.pathname + window.location.search,
          );
        }
        vocabularyStaticOriginRef.current = null;
        vocabularyFreshStaticRef.current = true;
        setVocabularyMode("static");
        setVocabularyStaticPage(workspace.page);
        if (nav.view !== "vocabulary") navigateTo("vocabulary");
        return;
      }
      vocabularyStaticOriginRef.current = null;
      vocabularyFreshStaticRef.current = false;
      syncVocabularyHostRoute(workspace.route, {
        replace: nav.view === "vocabulary" && vocabularyMode === "spa",
      });
      setVocabularyMode("spa");
      setVocabularyStaticPage("");
      if (nav.view === "vocabulary" && (currentFrameIsStatic || vocabularyMode !== "spa")) {
        setVocabularyReloadNonce((value) => value + 1);
      }
      if (nav.view !== "vocabulary") navigateTo("vocabulary");
      return;
    }
    if (view === "library" || view === "cloze-library") {
      if (vocabularyRouteFromHost()) {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
      }
      window.history.replaceState(window.history.state, "", readingHostHash({ view }));
      startTransition(() => setNav({ view, stack: [] }));
      return;
    }
    if (view === "writing-library") {
      setWritingSessionId("");
      window.history.replaceState(window.history.state, "", writingHostHash({ view }));
      startTransition(() => setNav({ view, stack: [] }));
      return;
    }
    if (view === "exam-library") {
      if (vocabularyRouteFromHost() || readingRouteFromHost()) {
        window.history.replaceState(
          window.history.state,
          "",
          window.location.pathname + window.location.search,
        );
      }
      navigateTo("exam-library");
      window.history.replaceState(window.history.state, "", examHostHash({ view: "exam-library" }));
      return;
    }
    if (vocabularyRouteFromHost()) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      );
    }
    setNav({ view, stack: [] });
  }

  function handleStaticPageMessage(page) {
    if (!VOCABULARY_STATIC_PAGES[page]) return;
    if (vocabularyStaticOriginRef.current?.kind === "static"
      && vocabularyStaticOriginRef.current.page === page) {
      vocabularyStaticOriginRef.current = null;
    }
    if (vocabularyFreshStaticRef.current) {
      vocabularyFreshStaticRef.current = false;
    } else if (!vocabularyStaticOriginRef.current) {
      vocabularyStaticOriginRef.current = vocabularyMode === "spa"
        ? { kind: "spa", route: vocabularyRoute }
        : { kind: "static", page: vocabularyStaticPage };
    }
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    setVocabularyMode("static");
    setVocabularyStaticPage(page);
  }

  function handleHardwareBackResponse(atRoot) {
    pendingVocabularyBackRef.current = false;
    if (atRoot) closeVocabulary();
  }

  function handleFrameMessage(event) {
    const frameWindow = document.querySelector(".vocabulary-frame")?.contentWindow;
    if (!frameWindow || !isTrustedFrameMessage(event, frameWindow)) return;
    if (event.data?.type === "wuliao:vocabulary-static") {
      handleStaticPageMessage(event.data.page);
      return;
    }
    if (event.data?.type === "wuliao:vocabulary-back") {
      closeVocabulary();
      return;
    }
    if (event.data?.type !== "wuliao:hardware-back-response") return;
    handleHardwareBackResponse(event.data.atRoot);
  }

  function handleAppBack() {
    if (backControllerRef.current.handle()) return true;
    const currentView = navRef.current.view;
    if (currentView === "home") return false;
    if (currentView === "vocabulary") {
        const frameWindow = document.querySelector(".vocabulary-frame")?.contentWindow;
        const framePath = frameWindow?.location?.pathname || "";
        const isStaticFrame = /\/vocabulary\/(memorize|review|import)\.html/.test(framePath);
        if (isStaticFrame) {
          const origin = vocabularyStaticOriginRef.current;
          if (origin?.kind === "spa" && isVocabularySpaRoute(origin.route)) {
            setVocabularyMode("spa");
            setVocabularyStaticPage("");
            syncVocabularyHostRoute(origin.route, { replace: true });
            setVocabularyReloadNonce((value) => value + 1);
            return true;
          }
          if (origin?.kind === "static" && VOCABULARY_STATIC_PAGES[origin.page]) {
            setVocabularyMode("static");
            setVocabularyStaticPage(origin.page);
            setVocabularyReloadNonce((value) => value + 1);
            return true;
          }
          closeVocabulary();
          return true;
        }
        if (!frameWindow) {
          goBack();
          return true;
        }
        pendingVocabularyBackRef.current = true;
        vocabularyBridge.send(VocabMessageType.HARDWARE_BACK);
        window.setTimeout(() => {
          if (pendingVocabularyBackRef.current) {
            pendingVocabularyBackRef.current = false;
            closeVocabulary();
          }
        }, 260);
        return true;
    }
    if (currentView === "cloze") {
      closeCloze();
      return true;
    }
    if (currentView === "cloze-review") {
      closeClozeReview();
      return true;
    }
    if (currentView === "exam-session") {
      if (!window.confirm("退出考试并保留进度？计时不会暂停。")) return true;
      navigateTo("exam-library");
      window.history.replaceState(window.history.state, "", examHostHash({ view: "exam-library" }));
      return true;
    }
    if (currentView === "writing-session") {
      closeWritingWorkspace();
      return true;
    }
    goBack();
    return true;
  }

  appBackRef.current = handleAppBack;

  useEffect(() => {
    const handleHardwareBack = () => appBackRef.current?.() === true;
    window.__wuliaoHandleHardwareBack = handleHardwareBack;
    const onMessage = (event) => {
      vocabularyBridge.handleMessage(event);
      handleFrameMessage(event);
    };
    window.addEventListener("message", onMessage);
    return () => {
      delete window.__wuliaoHandleHardwareBack;
      window.removeEventListener("message", onMessage);
    };
  }, [nav.view]);

  useEffect(() => {
    const off = vocabularyBridge.on(({ type, payload }) => {
      if (type === VocabMessageType.SESSION_UPDATED) {
        emitAppEvent(AppEvent.VOCABULARY_SESSION_UPDATED);
        return;
      }
      if (type === VocabMessageType.BACK) {
        closeVocabulary();
        return;
      }
      if (type === VocabMessageType.ROUTE_CHANGED) {
        handleVocabularyRouteChange(payload.route);
        return;
      }
      if (type === VocabMessageType.STATIC_PAGE) {
        handleStaticPageMessage(payload.page);
        return;
      }
      if (type === VocabMessageType.HARDWARE_BACK_RESPONSE) {
        handleHardwareBackResponse(payload.atRoot);
      }
    });
    return off;
  }, [vocabularyMode, vocabularyRoute, vocabularyStaticPage]);

  useEffect(() => {
    function restoreCurrentHostLocation() {
      const currentView = navRef.current.view;
      if (currentView === "library" || currentView === "cloze-library") {
        window.history.replaceState(window.history.state, "", readingHostHash({ view: currentView }));
        return;
      }
      if (currentView === "cloze" && activeClozeIdRef.current) {
        window.history.replaceState(
          window.history.state,
          "",
          readingHostHash({ view: "cloze", resourceId: activeClozeIdRef.current }),
        );
        return;
      }
      if (currentView === "writing-library" || currentView === "writing-session") {
        window.history.replaceState(window.history.state, "", writingHostHash({ view: currentView, sessionId: writingSessionIdRef.current }));
        return;
      }
      if (readingRouteFromHost() || writingRouteFromHost() || vocabularyRouteFromHost()) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
      }
    }

    const restoreHostNavigation = () => {
      if (backControllerRef.current.handle()) {
        restoreCurrentHostLocation();
        return;
      }
      const currentView = navRef.current.view;
      if (currentView === "reader" || currentView === "cloze" || currentView === "cloze-review" || currentView === "writing-session") {
        if (appBackRef.current?.()) {
          return;
        }
      }
      const reading = readingRouteFromHost();
      const exam = examRouteFromHost();
      const writing = writingRouteFromHost();
      if (writing) {
        setWritingSessionId(writing.sessionId || "");
        setNav({ view: writing.view, stack: writing.view === "writing-session" ? ["writing-library"] : [] });
        return;
      }
      if (exam) {
        if (exam.view === "exam-cover") setExamYear(exam.year);
        if (exam.view === "exam-session" && exam.sessionId) {
          loadExamSessionSafely(exam.sessionId, { openView: false }).catch(() => {});
        }
        if (exam.view === "exam-result" && exam.resultId) {
          examResultRepository.list().then((records) => { const result = records.find((entry) => entry.id === exam.resultId); if (result) setExamResult({ ...result, handoffTargets: deriveHandoffTargets(result) }); }).catch(() => {});
        }
        setNav({ view: exam.view, stack: ["home"] });
        return;
      }
      if (reading) {
        if (reading.view === "cloze" && reading.resourceId) {
          setActiveClozeId(reading.resourceId);
          setActiveCloze(null);
          setRestoreChecked(false);
        }
        setNav({ view: reading.view, stack: ["home"] });
        return;
      }
      const route = vocabularyRouteFromHost();
      if (route) {
        setVocabularyRoute(route === "/screening" ? "/screening/1" : route);
        setVocabularyMode("spa");
        setVocabularyStaticPage("");
        setNav({ view: "vocabulary", stack: ["home"] });
        return;
      }
      setNav({ view: "home", stack: [] });
    };
    window.addEventListener("popstate", restoreHostNavigation);
    return () => window.removeEventListener("popstate", restoreHostNavigation);
  }, []);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  let content = null;
  if (nav.view === "writing-library") {
    content = <WritingLibrary services={writingServices} username={username} onOpenSession={openWritingSession} onConfigureTextAi={() => setAiApiOpen(true)} />;
  } else if (nav.view === "writing-session") {
    content = <WritingWorkspace sessionId={writingSessionId} username={username} services={writingServices} inkFlushBridge={writingInkFlushBridge} onBack={closeWritingWorkspace} onImmersiveChange={setWritingImmersive} hostLeaveBarrierRef={writingLeaveBarrierRef} />;
  } else if (nav.view === "exam-library") {
    content = <ExamLibrary years={Array.from({ length: 17 }, (_, index) => 2007 + index)} activeSession={examSession?.status === ExamStatus.IN_PROGRESS ? examSession : null} onStart={openExamCover} onContinue={() => { navigateTo("exam-session"); window.history.replaceState(window.history.state, "", examHostHash({ view: "exam-session", sessionId: examSession?.sessionId })); }} onAbandon={abandonCurrentExam} completedCount={examHistory.filter((entry) => !entry.damaged).length} latestResult={examHistory.find((entry) => !entry.damaged) || null} onHistory={() => { navigateTo("exam-history"); window.history.replaceState(window.history.state, "", examHostHash({ view: "exam-history" })); }} />;
  } else if (nav.view === "exam-cover") {
    content = <ExamCover year={examYear} loading={examLoading} error={examError} onBegin={beginExam} onBack={goBack} />;
  } else if (nav.view === "exam-session" && examSession) {
    content = <ExamSession session={examSession} disabled={!examControllerRef.current?.active} conflictMessage={examError} onReload={reloadCurrentExam} onAnswer={answerExam} onNavigate={navigateExam} onSubmit={() => submitCurrentExam(ExamStatus.SUBMITTED)} onTimeout={() => submitCurrentExam(ExamStatus.TIMED_OUT)} onBack={goBack} ExamInkSurface={ExamInkSurface} examInkProps={(item) => {
      const surfaceId = examSurfaceIdForItem(item);
      return {
        username,
        sessionId: examSession.sessionId,
        surfaceId,
        sourceFingerprint: item.passageFingerprint || examSession.sourceFingerprint,
        disabled: examControllerRef.current && !examControllerRef.current.active,
        onFlushHandleChange: (flush) => { if (flush) examInkFlushesRef.current.set(surfaceId, flush); else examInkFlushesRef.current.delete(surfaceId); },
        onInkRefChange: (ref) => updateExamInkRegistry(surfaceId, ref),
      };
    }} ExamQuestionDrawer={ExamQuestionDrawer} />;
  } else if (nav.view === "exam-result" && examResult) {
    content = <ExamResult result={examResult} onHandoff={saveExamHandoff} onStartHandoff={(target) => openExamFollowup({ examResultId: examResult.id, targetId: target.targetId })} onHistory={() => { navigateTo("exam-history"); window.history.pushState(window.history.state, "", examHostHash({ view: "exam-history" })); }} onBack={() => navigateFromShell("library")} />;
  } else if (nav.view === "exam-history") {
    content = <ExamHistory results={[...examHistory, ...examAbandonedHistory]} onOpen={(result) => { setExamResult(result); navigateTo("exam-result"); window.history.pushState(window.history.state, "", examHostHash({ view: "exam-result", resultId: result.id })); }} onBack={goBack} />;
  } else if (nav.view === "reader" && activeResource) {
    const readerProps = {
      onClose: closeReader,
      reviewTaskKey,
      summaryInitially: Boolean(readerOptions.summaryInitially),
      summaryTabInitially: readerOptions.reviewTab ? "review" : "summary",
      onRequestReview: startReview,
    };
    content = activeResource.kind === "custom" && activeResource.analysis?.passages?.length
      ? <CustomDeepReader resource={activeResource} {...readerProps} />
      : <OfficialDeepReader key={activeResource.id} resource={activeResource} {...readerProps} />;
  } else if (nav.view === "cloze" && activeCloze) {
    content = (
      <ClozeReader
        resource={activeCloze}
        onClose={closeCloze}
        onShowLearningSummary={(resourceId, clozeId) => openClozeLearningSummary({ resourceId, clozeId })}
      />
    );
  } else if (nav.view === "cloze-review" && activeClozeReviewTaskKey) {
    content = (
      <ClozeReviewSession
        key={activeClozeReviewTaskKey}
        taskKey={activeClozeReviewTaskKey}
        onClose={closeClozeReview}
      />
    );
  } else if (nav.view === "library") {
    content = (
      <ReadingLibrary
        onBack={goBack}
        onOpen={openResource}
        onOpenCloze={openCloze}
        onOpenClozeSummary={openClozeSummaryForResource}
        onUnknownWords={() => navigateTo("unknown-words")}
      />
    );
  } else if (nav.view === "cloze-library") {
    content = (
      <ClozeLibrary
        onBack={goBack}
        onOpen={openResource}
        onOpenCloze={openCloze}
        onOpenClozeSummary={openClozeSummaryForResource}
        onUnknownWords={() => navigateTo("unknown-words")}
      />
    );
  } else if (nav.view === "unknown-words") {
    content = <UnknownWordLibrary onBack={goBack} />;
  } else if (nav.view === "vocabulary") {
    const vocabularyWorkspace = vocabularyMode === "static"
      ? (() => {
        const page = VOCABULARY_STATIC_PAGES[vocabularyStaticPage] || VOCABULARY_STATIC_PAGES.memorize;
        return { kind: "static", page: page.key, src: page.src, label: page.label, nonce: vocabularyReloadNonce };
      })()
      : { kind: "spa", route: vocabularyRoute, src: `/vocabulary/index.html#${vocabularyRoute}`, label: "单词训练", nonce: vocabularyReloadNonce };
    content = (
      <VocabularyWorkspace
        onBack={closeVocabulary}
        workspace={vocabularyWorkspace}
        route={vocabularyRoute}
        onRouteChange={handleVocabularyRouteChange}
        bridge={vocabularyBridge}
      />
    );
  } else {
      content = (
      <Home
        onReady={markHomeReady}
        onRead={() => navigateFromShell("library")}
        onOpenClozeLibrary={() => navigateFromShell("cloze-library")}
        onOpenExam={() => { navigateTo("exam-library"); window.history.pushState(window.history.state, "", examHostHash({ view: "exam-library" })); }}
        onOpenExamFollowup={openExamFollowup}
        onUpdateExamFollowup={updateExamFollowup}
        onOpenResource={openResource}
        onOpenCloze={openCloze}
        username={username}
        onStartReview={startReview}
        onStartClozeReview={openClozeReview}
        onOpenVocabularyReview={openVocabularyReview}
      />
    );
  }
  const immersive = nav.view === "reader" || nav.view === "cloze" || nav.view === "cloze-review" || nav.view === "exam-session" || (nav.view === "writing-session" && writingImmersive);
  return (
    <ErrorBoundary>
      <BackControllerProvider controller={backControllerRef.current}>
        <AppShell
          activeView={nav.view}
          mode={immersive ? "immersive" : "workspace"}
          vocabularyRoute={vocabularyRoute}
          vocabularyMode={vocabularyMode}
          vocabularyStaticPage={vocabularyStaticPage}
          username={username}
          aiConfigured={aiConfigured}
          onNavigate={navigateFromShell}
          onOpenAiApi={() => setAiApiOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          onSwitchAccount={() => leaveAfterSave(onSwitchAccount)}
        >
          <ErrorBoundary
            key={nav.view}
            onReset={() => {
              window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
              setNav({ view: "home", stack: [] });
            }}
          >
            <Suspense fallback={<RouteLoading />}>{content}</Suspense>
            <SaveStatus username={username} showSaved={nav.view === "reader" || nav.view === "cloze"} />
          </ErrorBoundary>
        </AppShell>
        {aiApiOpen && (
          <AiApiModal
            username={username}
            textAi={writingServices.textAi}
            onClose={() => setAiApiOpen(false)}
            onSaved={refreshAiConfiguration}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            username={username}
            onClose={() => setSettingsOpen(false)}
            onSwitchAccount={() => leaveAfterSave(onSwitchAccount)}
            onOpenDeveloperLab={() => {
              setSettingsOpen(false);
              setLabOpen(true);
            }}
          />
        )}
        {labOpen && (
          <Suspense fallback={<RouteLoading label="正在打开开发者实验室…" />}><DeveloperLab
            onClose={() => setLabOpen(false)}
          /></Suspense>
        )}
        {clozeSummaryTarget && (
          <ClozeSummaryPanel
            resourceId={clozeSummaryTarget.resourceId}
            clozeId={clozeSummaryTarget.clozeId}
            completedAt={clozeSummaryTarget.completedAt}
            onClose={() => setClozeSummaryTarget(null)}
            onStartReview={startClozeReviewFromSummary}
          />
        )}
      </BackControllerProvider>
    </ErrorBoundary>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AccountGate>
        {(username, onSwitchAccount, onReady) => (
          <WorkspaceApp key={username} username={username} onSwitchAccount={onSwitchAccount} onReady={onReady} />
        )}
      </AccountGate>
    </ErrorBoundary>
  );
}
