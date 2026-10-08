import { Fragment, useLayoutEffect, useRef, useState } from "react";
import Icon from "./Icon";
import { isNavGroup, isVocabularyRouteActive, isWritingView, navLeaves, PRIMARY_NAV } from "../navigation";

function itemIsActive(item, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) {
  if (item.view === "writing-library") return isWritingView(activeView);
  if (item.view !== activeView) return false;
  if (item.view !== "vocabulary") return true;
  if (item.kind === "static") {
    return vocabularyMode === "static" && item.page === vocabularyStaticPage;
  }
  return vocabularyMode === "spa" && isVocabularyRouteActive(item.route, vocabularyRoute);
}

export default function AppShell({
  activeView,
  mode = "workspace",
  vocabularyRoute,
  vocabularyMode = "spa",
  vocabularyStaticPage = "",
  username,
  aiConfigured,
  longSentenceTrainingEnabled = true,
  onNavigate,
  onOpenAiApi,
  onOpenSettings,
  children,
}) {
  const immersive = mode === "immersive";
  const visibleNav = longSentenceTrainingEnabled ? PRIMARY_NAV : PRIMARY_NAV.filter((item) => item.id !== "long-sentence");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const contentRef = useRef(null);
  const shellMotionRef = useRef(null);
  const navigate = (view, route = "", page = "") => {
    onNavigate(view, route, page);
  };

  // 品牌区只负责切换 AppShell 自己的左侧 rail；不承担返回首页职责。
  const onBrandClick = () => {
    shellMotionRef.current = {
      contentLeft: contentRef.current?.getBoundingClientRect().left ?? 0,
    };
    contentRef.current?.getAnimations?.().forEach((animation) => animation.cancel());
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  useLayoutEffect(() => {
    const snapshot = shellMotionRef.current;
    shellMotionRef.current = null;
    if (!snapshot || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const content = contentRef.current;
    const nextContentLeft = content?.getBoundingClientRect().left ?? snapshot.contentLeft;
    const contentDelta = snapshot.contentLeft - nextContentLeft;
    if (content && Math.abs(contentDelta) > 0.5) {
      content.animate([
        { transform: `translateX(${contentDelta}px)` },
        { transform: "translateX(0)" },
      ], { duration: 200, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }, [sidebarCollapsed]);

  return (
    <div className={`ds-shell ds-shell-${mode} ${!immersive && sidebarCollapsed ? "ds-shell-collapsed" : ""}`.trim()}>
      {!immersive && <aside className="ds-rail">
        <button
          className="ds-brand"
          type="button"
          onClick={onBrandClick}
          aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
          title={sidebarCollapsed ? "展开侧栏" : undefined}
        >
          <img src="/favicon.svg" alt="" />
          <span><strong>无聊英语</strong><small>DEEP SEA STUDY</small></span>
        </button>
        <nav className="ds-nav" aria-label="主导航">
          {visibleNav.map((item) => (
            <Fragment key={item.id}>
              {isNavGroup(item) ? (
                <>
                  <div className="ds-nav-group">{item.label}</div>
                  {item.children.map((child) => (
                    <button
                      type="button"
                      key={child.id}
                      className={itemIsActive(child, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "is-active" : ""}
                      aria-current={itemIsActive(child, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "page" : undefined}
                      aria-label={child.label}
                      title={sidebarCollapsed ? child.label : undefined}
                      onClick={() => navigate(child.view, child.route, child.page)}
                    >
                      <Icon name={child.icon} />
                      <span>{child.label}</span>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {item.id === "vocabulary-home" && <div className="ds-nav-group">单词</div>}
                  <button
                    type="button"
                    className={itemIsActive(item, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "is-active" : ""}
                    aria-current={itemIsActive(item, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "page" : undefined}
                    aria-label={item.label}
                    title={sidebarCollapsed ? item.label : undefined}
                    onClick={() => navigate(item.view, item.route, item.page)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                </>
              )}
            </Fragment>
          ))}
        </nav>
        <div className="ds-rail-footer">
          <button className="ds-settings" type="button" onClick={onOpenSettings} aria-label="设置" title={sidebarCollapsed ? "设置" : undefined}>
            <Icon name="settings" />
            <span><strong>设置</strong><small>账号、备份与本地信息</small></span>
          </button>
          <button className={`ds-ai-api ${aiConfigured ? "is-configured" : ""}`} type="button" onClick={onOpenAiApi} aria-label="AI API" title={sidebarCollapsed ? "AI API" : undefined}>
            <Icon name="api" />
            <span><strong>AI API</strong><small>{aiConfigured ? "已配置本机密钥" : "配置本机密钥"}</small></span>
          </button>
        </div>
      </aside>}

      {!immersive && <header className="ds-mobile-header">
        <button className="ds-mobile-brand" type="button" onClick={() => navigate("home")}>
          <img src="/favicon.svg" alt="" />
          <strong>无聊英语</strong>
        </button>
        <div className="ds-mobile-actions">
          <button type="button" className="ds-mobile-settings" onClick={onOpenSettings} aria-label="打开设置">
            <Icon name="settings" size={19} />
          </button>
          <button type="button" className={`ds-mobile-ai ${aiConfigured ? "is-configured" : ""}`} onClick={onOpenAiApi} aria-label="打开 AI API 设置">
            <Icon name="api" size={19} />
          </button>
        </div>
      </header>}

      <div ref={contentRef} className={`ds-shell-content ds-shell-view-${activeView}`}>{children}</div>

      {!immersive && <nav className="ds-bottom-nav" aria-label="移动端主导航">
        {navLeaves(visibleNav).map((item) => (
          <button
            key={item.id}
            type="button"
            className={itemIsActive(item, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "is-active" : ""}
            aria-current={itemIsActive(item, activeView, vocabularyRoute, vocabularyMode, vocabularyStaticPage) ? "page" : undefined}
            onClick={() => navigate(item.view, item.route, item.page)}
          >
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>}
    </div>
  );
}
