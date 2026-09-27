(() => {
  const APP_NAME = "无聊英语 · 单词训练";
  const AUTO_SPEAK_KEY = "wuliao:vocabulary:auto-pronounce";
  const SHUFFLE_KEY = "wuliao:vocabulary:shuffle-screening";
  const SHUFFLE_BAR_ID = "shuffleToggleBar";
  const CURRENT_LEARNING_LIST_KEY = "wuliao:vocabulary:current-learning-list";
  const HOST_ROUTES = new Set(["/dashboard", "/lists", "/screening", "/learning", "/export", "/confusion"]);
  const EMBEDDED_TOOLS_ID = "embeddedVocabActions";
  const EMBEDDED_DASHBOARD_LIBRARY_ID = "embeddedDashboardLibrary";
  const IMPORTED_LIST_CARD_SELECTOR = "#root main .space-y-2 > .bg-white";
  const IMPORTED_LIST_ACTIONS_SELECTOR = ".flex.items-center.gap-2.ml-4";
  const IMPORTED_LIST_NAME_SELECTOR = ".font-medium.text-gray-900";
  const IMPORTED_LIST_META_SELECTOR = ".text-xs.text-gray-400";
  const IMPORTED_LIST_TOOLS_MIN_INTERVAL_MS = 300;
  const IMPORTED_LIST_TOOLS_RETRY_LIMIT = 10;
  const IMPORTED_LIST_TOOLS_RETRY_DELAY_MS = 200;
  const IS_HOSTED = window.parent !== window;
  const EMBEDDED_INITIAL_HISTORY_LENGTH = history.length;
  let embeddedHasPreviousDocument = false;
  try {
    embeddedHasPreviousDocument = sessionStorage.getItem("wuliao:vocab:embedded-fresh") !== "1";
    sessionStorage.removeItem("wuliao:vocab:embedded-fresh");
  } catch {
    // Storage unavailable: fall back to route stack only.
  }
  const isStartupRoute = (route) => ["/", "/login"].includes(String(route).split("?")[0]);
  const initialRoute = location.hash.replace(/^#/, "") || "/dashboard";
  let routeStack = isStartupRoute(initialRoute) ? [] : [initialRoute];
  let lastReportedHostRoute = "";

  const usesHttpMessagingOrigin = () => location.protocol === "http:" || location.protocol === "https:";
  const parentMessageTargetOrigin = () => usesHttpMessagingOrigin() ? location.origin : "*";
  const isTrustedParentMessage = (event) => event.source === window.parent
    && (!usesHttpMessagingOrigin() || event.origin === location.origin);

  const sendHardwareBackResponse = (atRoot) => {
    if (window.VocabularyBridge?.respondHardwareBack) {
      window.VocabularyBridge.respondHardwareBack(atRoot);
      return;
    }
    window.parent.postMessage(
      { type: "wuliao:hardware-back-response", atRoot },
      parentMessageTargetOrigin(),
    );
  };

  const normalizeHostRoute = (route) => {
    const value = String(route || "");
    if (/^\/screening(?:\/|$)/.test(value)) return "/screening";
    if (/^\/learning(?:\/|$)/.test(value)) return "/learning";
    if (/^\/export(?:\/|$)/.test(value)) return "/export";
    return value;
  };

  const reportHostRoute = (route) => {
    const normalized = normalizeHostRoute(route);
    if (window.parent === window || !HOST_ROUTES.has(normalized) || normalized === lastReportedHostRoute) return;
    lastReportedHostRoute = normalized;
    if (window.VocabularyBridge?.reportRoute) {
      window.VocabularyBridge.reportRoute(route);
      return;
    }
    window.parent.postMessage(
      { type: "wuliao:vocabulary-route", route },
      parentMessageTargetOrigin(),
    );
  };

  const screeningHref = () => {
    const listId = localStorage.getItem(CURRENT_LEARNING_LIST_KEY);
    return listId ? `#/screening/1?sourceListId=${encodeURIComponent(listId)}` : "#/screening/1";
  };

  const updateScreeningHref = () => {
    const link = document.querySelector('#mobileAppNav a[data-route="/screening"]');
    if (link) link.setAttribute("href", screeningHref());
  };

  const rememberLearningList = (route) => {
    const match = /^\/learning\/([^/?#]+)/.exec(route);
    if (match?.[1]) {
      localStorage.setItem(CURRENT_LEARNING_LIST_KEY, match[1]);
      updateScreeningHref();
    }
  };

  const trackRoute = (route) => {
    // Authentication and initial redirects are not pages the user can return to.
    if (isStartupRoute(route)) return;
    const previous = routeStack[routeStack.length - 1];
    if (previous === route) return;
    routeStack.push(route);
    if (routeStack.length > 50) routeStack.shift();
  };

  const routes = [
    { label: "主页", symbol: "⌂", href: "#/dashboard", match: "/dashboard" },
    { label: "词库", symbol: "▤", href: "#/lists", match: "/lists" },
    { label: "筛查", symbol: "✓", href: screeningHref(), match: "/screening" },
    { label: "学习单词", symbol: "▣", href: "#/learning", match: "/learning" },
  ];
  let lastAutoSpokenWord = "";
  let autoSpeakTimer = 0;
  let embeddedToolsRoute = "";
  let importedListToolsTimer = 0;
  let importedListToolsLastRunAt = 0;
  let importedListToolsRunning = false;
  let importedListToolsRetryCount = 0;

  const appHeaderExists = () => document.querySelector("#root header.h-14");

  const syncBranding = () => {
    document.title = APP_NAME;
  };

  const syncRouteState = () => {
    const route = appHeaderExists() ? currentRoute() : "/login";
    document.body.dataset.appRoute = route.split("/").filter(Boolean)[0] || "login";
    if (appHeaderExists()) trackRoute(route);
    reportHostRoute(route);
  };

  const stripScreeningLetters = () => {
    if (window.__wuliaoScreeningContext) return;
    if (!currentRoute().startsWith("/screening")) return;
    document.querySelectorAll("#root main .grid button").forEach((button) => {
      const label = button.textContent.trim();
      if (/^[A-L][.、]\s*/.test(label)) {
        button.textContent = label.replace(/^[A-L][.、]\s*/, "");
      }
    });
  };

  // 2026-08-13：删除词库主页“最近词库”整块（稳定语义定位标题文本，禁止 nth-child）。
  const removeRecentLibrarySection = () => {
    if (!currentRoute().startsWith("/dashboard")) return;
    const main = document.querySelector("#root main");
    if (!main) return;
    const heading = [...main.querySelectorAll("h1, h2, h3")]
      .find((node) => node.textContent.trim() === "最近词库");
    if (!heading) return;
    let node = heading.parentElement;
    while (node && node !== main && node.children.length <= 1) {
      node = node.parentElement;
    }
    if (node && node !== main) {
      node.remove();
      return;
    }
    if (heading.parentElement && heading.parentElement !== main) {
      heading.parentElement.remove();
    }
  };

  const installShuffleToggle = () => {
    if (!currentRoute().startsWith("/screening")) {
      document.getElementById(SHUFFLE_BAR_ID)?.remove();
      return;
    }
    if (document.getElementById(SHUFFLE_BAR_ID)) return;
    const bar = document.createElement("div");
    bar.id = SHUFFLE_BAR_ID;
    bar.className = "shuffle-toggle-bar";
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = localStorage.getItem(SHUFFLE_KEY) === "true";
    input.addEventListener("change", () => {
      localStorage.setItem(SHUFFLE_KEY, String(input.checked));
      window.dispatchEvent(new Event("wuliao:shuffle-restart"));
    });
    label.append(input, document.createTextNode("乱序筛查"));
    bar.append(label);
    document.body.append(bar);
  };

  const currentRoute = () => location.hash.replace(/^#/, "").split("?")[0] || "/dashboard";

  const updateActiveState = () => {
    const route = currentRoute();
    document.querySelectorAll("#mobileAppNav [data-route]").forEach((item) => {
      item.classList.toggle("is-active", route.startsWith(item.dataset.route));
    });
  };

  const renameVocabularyLabels = () => {
    document.querySelectorAll("#root aside a").forEach((link) => {
      const href = link.getAttribute("href") || "";
      if (href.endsWith("/dashboard")) link.textContent = "主页";
      else if (href.endsWith("/lists")) link.textContent = "词库";
      else if (href.includes("/screening")) link.textContent = "筛查";
      else if (href.endsWith("/learning")) link.textContent = "学习单词";
      else if (href.endsWith("/export")) link.textContent = "导出单词表";
      else if (href.endsWith("/confusion")) link.textContent = "混淆词对照";
    });
  };

  const removeEmbeddedWorkspaceTools = () => {
    document.getElementById(EMBEDDED_TOOLS_ID)?.remove();
    document.getElementById(EMBEDDED_DASHBOARD_LIBRARY_ID)?.remove();
    document.querySelector(".embedded-dashboard-heading")?.classList.remove("embedded-dashboard-heading");
    embeddedToolsRoute = "";
  };

  const embeddedBack = () => {
    const previous = routeStack[routeStack.length - 2];
    if (previous) {
      routeStack.pop();
      location.hash = previous;
      return;
    }
    if (history.length > EMBEDDED_INITIAL_HISTORY_LENGTH) {
      history.back();
      return;
    }
    if (window.VocabularyBridge?.requestBack) {
      window.VocabularyBridge.requestBack();
      return;
    }
    window.parent.postMessage({ type: "wuliao:vocabulary-back" }, parentMessageTargetOrigin());
  };

  const applyPendingLearnTarget = () => {
    const target = sessionStorage.getItem("wuliao:vocab:learn-target");
    if (!target || !appHeaderExists()) return;
    const route = currentRoute();
    if (route.startsWith("/login")) return;
    sessionStorage.removeItem("wuliao:vocab:learn-target");
    if (!route.startsWith("/learning")) {
      const hashIndex = target.indexOf("#");
      const hashTarget = hashIndex >= 0 ? target.slice(hashIndex + 1) : target;
      location.hash = hashTarget;
    }
  };

  const installEmbeddedWorkspaceTools = () => {
    if (!IS_HOSTED || !appHeaderExists()) return;
    const route = currentRoute();
    const toolsExist = route === "/dashboard"
      ? Boolean(document.getElementById(EMBEDDED_DASHBOARD_LIBRARY_ID))
      : Boolean(document.getElementById(EMBEDDED_TOOLS_ID));
    if (embeddedToolsRoute === route && toolsExist) return;
    removeEmbeddedWorkspaceTools();
    const container = document.createElement("div");
    container.id = EMBEDDED_TOOLS_ID;
    container.className = "embedded-vocab-actions";

    const addButton = (label, onClick) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "embedded-vocab-action";
      button.textContent = label;
      button.addEventListener("click", onClick);
      container.append(button);
      return button;
    };

    if (route === "/dashboard") {
      const heading = [...document.querySelectorAll("#root main h1, #root main h2")]
        .find((item) => /^(仪表板|仪表盘)$/.test(item.textContent.trim()));
      if (heading?.parentElement) {
        heading.textContent = "仪表盘";
        heading.parentElement.classList.add("embedded-dashboard-heading");
        const button = addButton("词库", () => { location.hash = "#/lists"; });
        button.id = EMBEDDED_DASHBOARD_LIBRARY_ID;
        heading.insertAdjacentElement("afterend", button);
        embeddedToolsRoute = route;
      }
    } else if (route === "/lists") {
      addButton("导入 PDF / Excel", () => {
        location.href = "/vocabulary/import.html?embedded=1";
      });
      addButton("导出单词表", () => {
        location.hash = "#/export";
      });
    } else if (route.startsWith("/learning")) {
      const from = new URLSearchParams(location.hash.split("?")[1] || "").get("from");
      addButton("混淆词对照", () => {
        location.hash = "#/confusion";
      });
      addButton(from === "memorize" ? "返回背诵" : "返回", embeddedBack);
    } else if (route === "/confusion") {
      const previous = routeStack[routeStack.length - 2];
      addButton("返回学习单词", () => {
        if (previous && previous.startsWith("/learning")) location.hash = previous;
        else location.hash = "#/learning";
      });
    }

    if (container.childElementCount > 0) {
      const main = document.querySelector("#root main");
      if (main) {
        main.prepend(container);
        embeddedToolsRoute = route;
      }
    }
  };

  const closePanel = () => {
    const panel = document.querySelector(".app-more-panel");
    const button = document.querySelector(".app-nav-more");
    if (panel) panel.hidden = true;
    if (button) button.classList.remove("is-active");
  };

  const createNavigation = () => {
    if (IS_HOSTED) return;
    if (document.getElementById("mobileAppNav")) return;

    const nav = document.createElement("nav");
    nav.id = "mobileAppNav";
    nav.setAttribute("aria-label", "功能导航");
    routes.forEach((route) => {
      const link = document.createElement("a");
      link.className = "app-nav-link";
      link.href = route.href;
      link.dataset.route = route.match;
      const symbol = document.createElement("span");
      symbol.className = "app-nav-symbol";
      symbol.setAttribute("aria-hidden", "true");
      symbol.textContent = route.symbol;
      const label = document.createElement("span");
      label.textContent = route.label;
      link.append(symbol, label);
      nav.append(link);
    });

    const moreButton = document.createElement("button");
    moreButton.className = "app-nav-more";
    moreButton.type = "button";
    moreButton.setAttribute("aria-expanded", "false");
    const moreSymbol = document.createElement("span");
    moreSymbol.className = "app-nav-symbol";
    moreSymbol.setAttribute("aria-hidden", "true");
    moreSymbol.textContent = "⋯";
    const moreLabel = document.createElement("span");
    moreLabel.textContent = "更多";
    moreButton.append(moreSymbol, moreLabel);
    nav.append(moreButton);

    const panel = document.createElement("div");
    panel.className = "app-more-panel";
    panel.hidden = true;
    [
      ["#/export", "导出单词表"],
      ["#/confusion", "混淆词对照"],
      ["/vocabulary/memorize.html", "背词训练"],
      ["/vocabulary/review.html", "今日复习"],
      ["/vocabulary/import.html", "导入 PDF / Excel 词库"],
    ].forEach(([href, label]) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      panel.append(link);
    });
    const autoSpeakLabel = document.createElement("label");
    autoSpeakLabel.className = "app-auto-speak";
    const autoSpeakInput = document.createElement("input");
    autoSpeakInput.type = "checkbox";
    const autoSpeakText = document.createElement("span");
    autoSpeakText.textContent = "下一词自动读音";
    autoSpeakLabel.append(autoSpeakInput, autoSpeakText);
    panel.append(autoSpeakLabel);

    moreButton.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      moreButton.setAttribute("aria-expanded", String(!panel.hidden));
      moreButton.classList.toggle("is-active", !panel.hidden);
    });

    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) closePanel();
    });
    panel.addEventListener("click", closePanel);
    const autoSpeakToggle = autoSpeakInput;
    autoSpeakToggle.checked = localStorage.getItem(AUTO_SPEAK_KEY) === "true";
    autoSpeakToggle.addEventListener("click", (event) => event.stopPropagation());
    autoSpeakToggle.addEventListener("change", () => {
      localStorage.setItem(AUTO_SPEAK_KEY, String(autoSpeakToggle.checked));
      lastAutoSpokenWord = "";
      if (autoSpeakToggle.checked) maybeSpeakCurrentWord();
    });
    document.body.append(nav, panel);
    updateScreeningHref();
    updateActiveState();
  };

  const syncNavigation = () => {
    document.documentElement.classList.toggle("vocab-embedded", IS_HOSTED);
    renameVocabularyLabels();
    syncBranding();
    syncRouteState();
    removeRecentLibrarySection();
    stripScreeningLetters();
    installShuffleToggle();
    if (appHeaderExists()) {
      if (IS_HOSTED) {
        document.getElementById("mobileAppNav")?.remove();
        document.querySelector(".app-more-panel")?.remove();
      } else {
        createNavigation();
      }
      updateActiveState();
      applyPendingLearnTarget();
      installEmbeddedWorkspaceTools();
      maybeSpeakCurrentWord();
      scheduleImportedListTools();
      return;
    }
    document.getElementById("mobileAppNav")?.remove();
    document.querySelector(".app-more-panel")?.remove();
    removeEmbeddedWorkspaceTools();
  };

  // 集中式语义定位：卡片内名称节点精确匹配 + 元信息行包含轮次/数量，
  // 不依赖整卡 substring、lastElementChild 或 nth-child。
  const cardForImportedList = (list) => [...document.querySelectorAll(IMPORTED_LIST_CARD_SELECTOR)]
    .find((card) => {
      const name = card.querySelector(IMPORTED_LIST_NAME_SELECTOR)?.textContent.trim();
      if (name !== list.name) return false;
      const meta = card.querySelector(IMPORTED_LIST_META_SELECTOR)?.textContent || card.textContent;
      return meta.includes(`第 ${list.round} 轮 · ${list.wordIds.length} 词`);
    });

  const installImportedListTools = async () => {
    window.clearTimeout(importedListToolsTimer);
    importedListToolsTimer = 0;
    if (importedListToolsRunning || !currentRoute().startsWith("/lists")) return;
    const username = localStorage.getItem("kaoyan_vocab_current_user") || "";
    if (!username) return;
    importedListToolsRunning = true;
    try {
      const bridge = await import("/vocabulary/imported-word-bridge.js");
      const lists = await bridge.getImportedMainLists(username);
      let pending = false;
      lists.forEach((list) => {
        const card = cardForImportedList(list);
        const actions = card?.querySelector(IMPORTED_LIST_ACTIONS_SELECTOR);
        if (!actions || actions.querySelector(`[data-remove-familiar-list-id=\"${list.id}\"]`)) return;
        pending = true;
        card.classList.add("has-imported-list-actions");

        const addClassificationButton = (targetType, label) => {
          const actionButton = document.createElement("button");
          actionButton.type = "button";
          actionButton.className = "imported-list-classify";
          actionButton.dataset.importedListClassification = targetType;
          actionButton.textContent = label;
          actionButton.addEventListener("click", async () => {
            if (!window.confirm(`\u628a\u300c${list.name}\u300d\u4e2d\u7684\u5168\u90e8\u8bcd\u52a0\u5165\u201c${label}\u201d\u5417\uff1f\u539f\u5bfc\u5165\u8bcd\u5e93\u4f1a\u4fdd\u7559\u3002`)) return;
            actionButton.disabled = true;
            actionButton.textContent = "\u6b63\u5728\u52a0\u5165\u2026";
            try {
              const result = await bridge.addImportedWordsToClassificationList(list.id, targetType);
              window.alert(`\u5df2\u52a0\u5165 ${result.added} \u4e2a\u8bcd\uff0c\u8be5\u8bcd\u5e93\u5171 ${result.total} \u8bcd\u3002`);
              window.location.reload();
            } catch (error) {
              window.alert(error?.message || "\u8bcd\u5e93\u5f52\u7c7b\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002");
              actionButton.disabled = false;
              actionButton.textContent = label;
            }
          });
          actions.insertBefore(actionButton, actions.lastElementChild);
        };

        addClassificationButton("familiar", "\u5168\u90e8\u8bbe\u719f\u77e5");
        addClassificationButton("raw", "\u5168\u90e8\u52a0\u5165\u751f\u8bcd");

        const button = document.createElement("button");
        button.type = "button";
        button.className = "imported-list-remove-familiar";
        button.dataset.removeFamiliarListId = String(list.id);
        button.textContent = "删除熟知词";
        button.addEventListener("click", async () => {
          if (!window.confirm(`删除「${list.name}」中此前筛为熟知的词吗？仅会从这个导入词库移除，学习与筛查记录会保留。`)) return;
          button.disabled = true;
          button.textContent = "正在删除…";
          try {
            const result = await bridge.removeFamiliarWordsFromImportedListForMainRecord(list.id);
            window.alert(result.removed
              ? `已删除 ${result.removed} 个熟知词，剩余 ${result.remaining} 词。`
              : "这个词库暂时没有可删除的熟知词。");
            window.location.reload();
          } catch (error) {
            window.alert(error?.message || "删除熟知词失败，请重试");
            button.disabled = false;
            button.textContent = "删除熟知词";
          }
        });
        actions.insertBefore(button, actions.lastElementChild);
      });
      // 有界 retry 只处理“卡片/操作容器尚未渲染”的异步延迟；
      // 主触发仍是 route/DOM mutation 驱动的 scheduleImportedListTools()。
      if (pending && importedListToolsRetryCount < IMPORTED_LIST_TOOLS_RETRY_LIMIT) {
        importedListToolsRetryCount += 1;
        window.clearTimeout(importedListToolsTimer);
        importedListToolsTimer = window.setTimeout(installImportedListTools, IMPORTED_LIST_TOOLS_RETRY_DELAY_MS);
      } else {
        importedListToolsRetryCount = 0;
      }
    } catch (error) {
      console.error("Imported list tools failed", error);
    } finally {
      importedListToolsRunning = false;
      importedListToolsLastRunAt = Date.now();
    }
  };

  const scheduleImportedListTools = () => {
    if (!currentRoute().startsWith("/lists")) return;
    // 节流式调度：pending timer 一旦挂起就不再被高频 mutation 清除/重置，
    // 因此持续 DOM 变更结束（或达到最小间隔）后 installer 一定能够执行。
    if (importedListToolsTimer) return;
    const now = Date.now();
    const wait = Math.max(0, IMPORTED_LIST_TOOLS_MIN_INTERVAL_MS - (now - importedListToolsLastRunAt));
    importedListToolsTimer = window.setTimeout(installImportedListTools, wait);
  };

  const speakWord = (word) => {
    if (window.WuliaoPronunciation) { window.WuliaoPronunciation.speak(word).catch(() => {}); return; }
    if (window.AndroidSpeech?.speak) {
      window.AndroidSpeech.speak(word);
      return;
    }
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = "en-US";
    utterance.rate = 0.86;
    const englishVoice = window.speechSynthesis.getVoices().find((voice) => /^en(-|_)/i.test(voice.lang));
    if (englishVoice) utterance.voice = englishVoice;
    window.speechSynthesis.speak(utterance);
  };

  const currentScreeningWord = () => [...document.querySelectorAll("#root main h2")]
    .map((heading) => heading.textContent.trim())
    .find((word) => /^[A-Za-z][A-Za-z' -]*$/.test(word)) || "";

  const maybeSpeakCurrentWord = () => {
    if (!currentRoute().startsWith("/screening") || localStorage.getItem(AUTO_SPEAK_KEY) !== "true") return;
    const word = currentScreeningWord();
    const questionId = window.__wuliaoDisplayedQuestion?.id || word;
    if (!word || questionId === lastAutoSpokenWord) return;
    lastAutoSpokenWord = questionId;
    window.clearTimeout(autoSpeakTimer);
    autoSpeakTimer = window.setTimeout(() => {
      if (currentRoute().startsWith("/screening") && currentScreeningWord() === word
        && (window.__wuliaoDisplayedQuestion?.id || word) === questionId
        && localStorage.getItem(AUTO_SPEAK_KEY) === "true") speakWord(word);
    }, 120);
  };

  window.addEventListener("hashchange", () => {
    window.clearTimeout(autoSpeakTimer);
    closePanel();
    lastAutoSpokenWord = "";
    const route = currentRoute();
    rememberLearningList(route);
    trackRoute(route);
    syncRouteState();
    updateActiveState();
    maybeSpeakCurrentWord();
  });
  const handleParentNavigate = (route) => {
    if (!HOST_ROUTES.has(normalizeHostRoute(route))) return;
    if (currentRoute() !== route) location.hash = route;
    else reportHostRoute(route);
  };

  const handleParentAutoPronounce = (enabledValue) => {
    const enabled = Boolean(enabledValue);
    localStorage.setItem(AUTO_SPEAK_KEY, String(enabled));
    lastAutoSpokenWord = "";
    if (enabled) maybeSpeakCurrentWord();
  };

  const handleParentShuffle = (enabledValue) => {
    const enabled = Boolean(enabledValue);
    localStorage.setItem(SHUFFLE_KEY, String(enabled));
    window.dispatchEvent(new Event("wuliao:shuffle-restart"));
  };

  const handleParentHardwareBack = () => {
    const route = currentRoute();
    const previous = routeStack[routeStack.length - 2];
    const cleanPrevious = String(previous || "").split("?")[0];
    if (sessionStorage.getItem("wuliao:vocab:learn-from") === "memorize"
      && (!cleanPrevious || cleanPrevious === "/dashboard" || cleanPrevious.startsWith("/learning"))) {
      sessionStorage.removeItem("wuliao:vocab:learn-from");
      location.href = "/vocabulary/memorize.html?embedded=1";
      sendHardwareBackResponse(false);
      return;
    }
    if (!previous) {
      if (embeddedHasPreviousDocument) {
        history.back();
        sendHardwareBackResponse(false);
        return;
      }
      sendHardwareBackResponse(true);
      return;
    }
    routeStack.pop();
    location.hash = previous;
    sendHardwareBackResponse(false);
  };

  window.addEventListener("message", (event) => {
    if (!isTrustedParentMessage(event)) return;
    const type = event.data?.type;
    if (type === "wuliao:vocabulary-navigate") {
      handleParentNavigate(event.data.route);
      return;
    }
    if (type === "wuliao:vocabulary-auto-pronounce") {
      handleParentAutoPronounce(event.data.enabled);
      return;
    }
    if (type === "wuliao:vocabulary-shuffle") {
      handleParentShuffle(event.data.enabled);
      return;
    }
    if (type === "wuliao:hardware-back") {
      handleParentHardwareBack();
    }
  });

  // 新协议父消息由 vocabulary-bridge-adapter.js 转换为旧格式 CustomEvent；
  // 业务脚本同时监听 postMessage（旧 bundle 兼容）与 CustomEvent（新协议）。
  window.addEventListener("wuliao:vocabulary-navigate", (event) => handleParentNavigate(event.detail?.route));
  window.addEventListener("wuliao:vocabulary-auto-pronounce", (event) => handleParentAutoPronounce(event.detail?.enabled));
  window.addEventListener("wuliao:vocabulary-shuffle", (event) => handleParentShuffle(event.detail?.enabled));
  window.addEventListener("wuliao:hardware-back", () => handleParentHardwareBack());
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#mobileAppNav, .app-more-panel")) closePanel();
    if (document.body.dataset.appRoute !== "screening") return;
    const wordHeading = event.target.closest("#root main h2");
    const word = wordHeading?.textContent.trim();
    if (word && /^[A-Za-z][A-Za-z' -]*$/.test(word)) speakWord(word);
  });

  let syncScheduled = false;
  const scheduleSyncNavigation = () => {
    if (syncScheduled) return;
    syncScheduled = true;
    window.requestAnimationFrame(() => {
      syncScheduled = false;
      syncNavigation();
    });
  };
  const navigationObserver = new MutationObserver(scheduleSyncNavigation);
  syncNavigation();
  navigationObserver.observe(document.getElementById("root"), { childList: true, subtree: true });
})();
