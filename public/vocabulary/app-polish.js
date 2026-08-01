(() => {
  const APP_NAME = "无聊英语 · 单词训练";
  const AUTO_SPEAK_KEY = "wuliao:vocabulary:auto-pronounce";
  const routes = [
    { label: "首页", symbol: "⌂", href: "#/dashboard", match: "/dashboard" },
    { label: "词库", symbol: "▤", href: "#/lists", match: "/lists" },
    { label: "筛查", symbol: "✓", href: "#/screening/1", match: "/screening" },
    { label: "学习", symbol: "▣", href: "#/learning", match: "/learning" },
  ];
  let lastAutoSpokenWord = "";
  let autoSpeakTimer = 0;
  let importedListToolsTimer = 0;
  let importedListToolsRunning = false;

  const appHeaderExists = () => document.querySelector("#root header.h-14");

  const syncBranding = () => {
    document.title = APP_NAME;
    document.querySelectorAll("#root h1").forEach((heading) => {
      if (heading.textContent.trim() === "考研词汇筛查系统") {
        heading.textContent = APP_NAME;
      }
    });
  };

  const syncRouteState = () => {
    const route = appHeaderExists() ? currentRoute() : "/login";
    document.body.dataset.appRoute = route.split("/").filter(Boolean)[0] || "login";
  };

  const currentRoute = () => location.hash.replace(/^#/, "") || "/dashboard";

  const updateActiveState = () => {
    const route = currentRoute();
    document.querySelectorAll("#mobileAppNav [data-route]").forEach((item) => {
      item.classList.toggle("is-active", route.startsWith(item.dataset.route));
    });
  };

  const closePanel = () => {
    const panel = document.querySelector(".app-more-panel");
    const button = document.querySelector(".app-nav-more");
    if (panel) panel.hidden = true;
    if (button) button.classList.remove("is-active");
  };

  const createNavigation = () => {
    if (document.getElementById("mobileAppNav")) return;

    const nav = document.createElement("nav");
    nav.id = "mobileAppNav";
    nav.setAttribute("aria-label", "功能导航");
    nav.innerHTML = routes.map((route) => `
      <a class="app-nav-link" href="${route.href}" data-route="${route.match}">
        <span class="app-nav-symbol" aria-hidden="true">${route.symbol}</span>
        <span>${route.label}</span>
      </a>
    `).join("") + `
      <button class="app-nav-more" type="button" aria-expanded="false">
        <span class="app-nav-symbol" aria-hidden="true">•••</span>
        <span>更多</span>
      </button>
    `;

    const panel = document.createElement("div");
    panel.className = "app-more-panel";
    panel.hidden = true;
    panel.innerHTML = `
      <a href="#/export">导出单词表</a>
      <a href="#/confusion">混淆词对照</a>
      <a href="/vocabulary/memorize.html">背词训练</a>
      <a href="/vocabulary/review.html">今日复习</a>
      <a href="/vocabulary/import.html">导入 PDF / Excel 词库</a>
      <label class="app-auto-speak"><input type="checkbox"><span>下一词自动读音</span></label>
    `;

    const moreButton = nav.querySelector(".app-nav-more");
    moreButton.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      moreButton.setAttribute("aria-expanded", String(!panel.hidden));
      moreButton.classList.toggle("is-active", !panel.hidden);
    });

    nav.addEventListener("click", (event) => {
      if (event.target.closest("a")) closePanel();
    });
    panel.addEventListener("click", closePanel);
    const autoSpeakToggle = panel.querySelector(".app-auto-speak input");
    autoSpeakToggle.checked = localStorage.getItem(AUTO_SPEAK_KEY) === "true";
    autoSpeakToggle.addEventListener("click", (event) => event.stopPropagation());
    autoSpeakToggle.addEventListener("change", () => {
      localStorage.setItem(AUTO_SPEAK_KEY, String(autoSpeakToggle.checked));
      lastAutoSpokenWord = "";
      if (autoSpeakToggle.checked) maybeSpeakCurrentWord();
    });
    document.body.append(nav, panel);
    updateActiveState();
  };

  const syncNavigation = () => {
    syncBranding();
    syncRouteState();
    if (appHeaderExists()) {
      createNavigation();
      updateActiveState();
      maybeSpeakCurrentWord();
      scheduleImportedListTools();
      return;
    }
    document.getElementById("mobileAppNav")?.remove();
    document.querySelector(".app-more-panel")?.remove();
  };

  const cardForImportedList = (list) => [...document.querySelectorAll("#root main .space-y-2 > .bg-white")]
    .find((card) => card.textContent.includes(list.name)
      && card.textContent.includes(`第 ${list.round} 轮 · ${list.wordIds.length} 词`));

  const installImportedListTools = async () => {
    if (importedListToolsRunning || !currentRoute().startsWith("/lists")) return;
    const username = localStorage.getItem("kaoyan_vocab_current_user") || "";
    if (!username) return;
    importedListToolsRunning = true;
    try {
      const bridge = await import("/vocabulary/imported-word-bridge.js");
      const lists = await bridge.getImportedMainLists(username);
      lists.forEach((list) => {
        const card = cardForImportedList(list);
        const actions = card?.querySelector(".flex.items-center.gap-2.ml-4");
        if (!actions || actions.querySelector(`[data-remove-familiar-list-id=\"${list.id}\"]`)) return;
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
    } catch (error) {
      console.error("Imported list tools failed", error);
    } finally {
      importedListToolsRunning = false;
    }
  };

  const scheduleImportedListTools = () => {
    window.clearTimeout(importedListToolsTimer);
    importedListToolsTimer = window.setTimeout(installImportedListTools, 80);
  };

  const speakWord = (word) => {
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
    if (!word || word === lastAutoSpokenWord) return;
    lastAutoSpokenWord = word;
    window.clearTimeout(autoSpeakTimer);
    autoSpeakTimer = window.setTimeout(() => speakWord(word), 120);
  };

  window.addEventListener("hashchange", () => {
    closePanel();
    lastAutoSpokenWord = "";
    syncRouteState();
    updateActiveState();
    maybeSpeakCurrentWord();
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#mobileAppNav, .app-more-panel")) closePanel();
    if (document.body.dataset.appRoute !== "screening") return;
    const wordHeading = event.target.closest("#root main h2");
    const word = wordHeading?.textContent.trim();
    if (word && /^[A-Za-z][A-Za-z' -]*$/.test(word)) speakWord(word);
  });

  syncNavigation();
  new MutationObserver(syncNavigation).observe(document.getElementById("root"), { childList: true, subtree: true, characterData: true });
})();
