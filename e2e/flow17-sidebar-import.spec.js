import { test, expect } from "@playwright/test";
import { createAccount, navTo, uniqueUsername } from "./helpers.js";

// Flow 17：2026-08-13 侧栏折叠统一 + 背诵页去导入入口 + 导入词库“全部设熟知”恢复。
// 同时覆盖两个真实根因的回归：embedded tools 不得形成 MutationObserver 自激循环；
// route 不变但工具容器被 rerender 删除后必须能自恢复。

function vocabularyFrame(page) {
  return page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/vocabulary/"));
}

async function waitForFrameByUrl(page, urlPart) {
  let frame = null;
  await expect.poll(() => {
    frame = vocabularyFrame(page);
    return Boolean(frame && frame.url().includes(urlPart));
  }, { timeout: 30000 }).toBe(true);
  return frame;
}

async function seedImportedList(page, username, name, listId = "import:flow17-list") {
  await page.evaluate(async ({ user, listName, id }) => {
    const open = (dbName, version) => new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("importedLists")) {
          const store = db.createObjectStore("importedLists", { keyPath: "id" });
          store.createIndex("username", "username", { unique: false });
        }
        if (!db.objectStoreNames.contains("importedWords")) {
          const store = db.createObjectStore("importedWords", { keyPath: "wordId" });
          store.createIndex("usernameList", ["username", "listKey"], { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const db = await open("KaoyanVocabMemorizeDB", 2);
    const tx = db.transaction(["importedLists", "importedWords"], "readwrite");
    tx.objectStore("importedLists").put({
      id,
      username: user,
      name: listName,
      wordIds: ["import:flow17-1", "import:flow17-2"],
      listKey: "flow17",
      createdAt: Date.now(),
    });
    tx.objectStore("importedWords").put({
      wordId: "import:flow17-1",
      username: user,
      listKey: "flow17",
      english: "alpha",
      chinese: "Alpha",
    });
    tx.objectStore("importedWords").put({
      wordId: "import:flow17-2",
      username: user,
      listKey: "flow17",
      english: "beta",
      chinese: "Beta",
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const bridge = await import("/vocabulary/imported-word-bridge.js");
    await bridge.syncImportedLists(user);
  }, { user: username, listName: name, id: listId });
}

async function openVocabularyLists(page, frame) {
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 30000 }).toBe("#/vocabulary/dashboard");
  const libraryButton = frame.locator("#embeddedDashboardLibrary");
  await expect(libraryButton).toBeVisible({ timeout: 30000 });
  await libraryButton.click();
  await expect.poll(() => frame.evaluate(() => location.hash), { timeout: 30000 }).toBe("#/lists");
}

async function waitForView(page, label) {
  if (label === "首页") {
    await page.locator(".home-page").waitFor({ timeout: 30000 });
  } else if (label === "精读" || label === "完形") {
    await page.locator(".library-page").waitFor({ timeout: 30000 });
  } else if (label === "写作") {
    await page.locator(".writing-library").waitFor({ timeout: 30000 });
  } else if (label === "词库") {
    await page.locator(".vocabulary-page").waitFor({ timeout: 30000 });
    await waitForFrameByUrl(page, "index.html");
  } else if (label === "背诵") {
    await waitForFrameByUrl(page, "memorize.html");
  } else if (label === "复习") {
    await waitForFrameByUrl(page, "review.html");
  }
}

async function installMarker(page, label) {
  const frame = vocabularyFrame(page);
  if (frame) {
    return {
      kind: "frame",
      value: await frame.evaluate(() => {
        window.__flow17Marker = (window.__flow17Marker || 0) + 1;
        return { marker: window.__flow17Marker, url: location.href, hash: location.hash };
      }),
      verify: () => frame.evaluate(() => ({
        marker: window.__flow17Marker,
        url: location.href,
        hash: location.hash,
      })),
    };
  }
  await page.evaluate(() => { window.__flow17Marker = (window.__flow17Marker || 0) + 1; });
  return {
    kind: "page",
    value: await page.evaluate(() => ({ marker: window.__flow17Marker, hash: location.hash })),
    verify: () => page.evaluate(() => ({ marker: window.__flow17Marker, hash: location.hash })),
  };
}

async function collapseAndRestore(page, verify) {
  const rail = page.locator(".ds-rail");
  const content = page.locator(".ds-shell-content");
  await expect(rail).toBeVisible();
  const expandedLeft = (await content.boundingBox()).x;
  expect(expandedLeft).toBeGreaterThan(100);

  await page.locator(".ds-brand").click();
  await page.waitForTimeout(280);
  await expect(page.locator(".ds-shell")).toHaveClass(/ds-shell-collapsed/);
  await expect(rail).toBeVisible();
  await expect(page.locator(".ds-nav-group:visible")).toHaveCount(0);
  await expect(page.locator(".ds-nav > button > span:visible")).toHaveCount(0);
  await expect(page.locator(".ds-nav > button")).toHaveCount(9);
  const collapsedLeft = (await content.boundingBox()).x;
  expect(collapsedLeft).toBeLessThan(expandedLeft - 100);
  const collapsedRail = await rail.boundingBox();
  expect(Math.abs(collapsedRail.width - 64)).toBeLessThanOrEqual(1);
  for (const button of await page.locator(".ds-nav > button").all()) {
    const box = await button.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(48);
  }
  await verify();

  await page.locator(".ds-brand").click();
  await page.waitForTimeout(280);
  await expect(page.locator(".ds-shell")).not.toHaveClass(/ds-shell-collapsed/);
  const restoredLeft = (await content.boundingBox()).x;
  expect(Math.abs(restoredLeft - expandedLeft)).toBeLessThanOrEqual(1);
  expect((await rail.boundingBox()).x).toBe(0);
  await verify();
}

test("Flow A：所有左栏页面均可折叠为图标 rail，当前 view/iframe 不重载不导航", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.setViewportSize({ width: 1280, height: 800 });
  await createAccount(page);

  for (const label of ["首页", "精读", "完形", "写作", "词库", "背诵", "复习"]) {
    if (label !== "首页") await navTo(page, label);
    await waitForView(page, label);
    await page.waitForTimeout(500);
    const marker = await installMarker(page, label);
    await collapseAndRestore(page, async () => {
      const now = await marker.verify();
      expect(now.marker).toBe(marker.value.marker);
      if (marker.kind === "frame") {
        expect(now.url).toBe(marker.value.url);
      } else {
        expect(now.hash).toBe(marker.value.hash);
      }
    });
  }
  expect(errors, `console errors: ${errors.join(" ;; ")}`).toEqual([]);
});

test("Flow A2：折叠 rail 的每个图标沿用真实导航并保持 active 标记", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await createAccount(page);
  await page.locator(".ds-brand").click();
  await expect(page.locator(".ds-shell")).toHaveClass(/ds-shell-collapsed/);
  for (const label of ["精读", "完形", "写作", "词库", "背诵", "复习", "首页"]) {
    const button = page.locator(`.ds-nav > button[aria-label="${label}"]`);
    await button.click();
    await waitForView(page, label);
    await page.waitForTimeout(900);
    await waitForView(page, label);
    await expect(button).toHaveAttribute("aria-current", "page");
    await expect(page.locator(".ds-shell")).toHaveClass(/ds-shell-collapsed/);
  }
});

test("Flow B：背诵页无导入词库入口；/lists 的导入 PDF / Excel 与 import.html 保留", async ({ page }) => {
  await createAccount(page);

  await navTo(page, "背诵");
  const memorizeFrame = await waitForFrameByUrl(page, "memorize.html");
  await memorizeFrame.locator("body").waitFor({ timeout: 15000 });
  await expect(memorizeFrame.locator('a[href="/vocabulary/import.html"]')).toHaveCount(0);
  await expect(memorizeFrame.locator("body")).not.toContainText("导入词库");
  await expect(memorizeFrame.locator("#learnLink")).toHaveCount(0);
  await expect(memorizeFrame.locator("#listSelect")).toBeVisible();

  await navTo(page, "词库");
  const spaFrame = await waitForFrameByUrl(page, "index.html");
  await spaFrame.locator("#root header.h-14").waitFor({ state: "attached", timeout: 30000 });
  const libraryButton = spaFrame.locator("#embeddedDashboardLibrary");
  if (await libraryButton.count()) {
    try {
      await libraryButton.click({ timeout: 8000 });
    } catch {
      await spaFrame.evaluate(() => { location.hash = "#/lists"; });
    }
  } else {
    await spaFrame.evaluate(() => { location.hash = "#/lists"; });
  }
  await expect(spaFrame.locator("#embeddedVocabActions")).toBeAttached({ timeout: 30000 });
  await expect(spaFrame.locator("#embeddedVocabActions")).toContainText("导入 PDF / Excel");
  await expect(spaFrame.locator("#embeddedVocabActions")).toContainText("导出单词表");

  const response = await page.request.get("/vocabulary/import.html");
  expect(response.status()).toBe(200);
});

test("Flow B2：768px 竖屏展开/收起左栏后背诵行与标记按钮完整可见，iframe 不重载", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await createAccount(page, uniqueUsername("flow17-memorize-width"));
  await navTo(page, "背诵");
  const frame = await waitForFrameByUrl(page, "memorize.html");
  await frame.locator(".word-row").first().waitFor({ state: "attached", timeout: 90000 });
  const marker = await installMarker(page, "背诵");
  const verifyGeometry = async () => {
    const metrics = await frame.evaluate(() => {
      const viewport = document.querySelector(".word-viewport");
      const rows = [...document.querySelectorAll(".word-row")].slice(0, 8);
      const viewportRect = viewport.getBoundingClientRect();
      const visibleInside = (rect, bounds) => Boolean(
        rect
        && rect.width > 0
        && rect.height > 0
        && rect.left >= bounds.left - 1
        && rect.right <= bounds.right + 1
        && rect.top >= bounds.top - 1
        && rect.bottom <= bounds.bottom + 1,
      );
      return {
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflow: viewport.scrollWidth - viewport.clientWidth,
        rows: rows.map((row) => {
          const word = row.querySelector(".english");
          const meaning = row.querySelector(".chinese");
          const button = row.querySelector(".mark-button");
          const rowRect = row.getBoundingClientRect();
          const wordRect = word?.getBoundingClientRect();
          const meaningRect = meaning?.getBoundingClientRect();
          const buttonRect = button?.getBoundingClientRect();
          return {
            rowRight: rowRect.right,
            wordVisible: visibleInside(wordRect, rowRect),
            meaningVisible: visibleInside(meaningRect, rowRect),
            wordRight: wordRect?.right || 0,
            meaningRight: meaningRect?.right || 0,
            buttonLeft: buttonRect?.left || 0,
            buttonRight: buttonRect?.right || 0,
            buttonVisible: visibleInside(buttonRect, rowRect),
            viewportRight: viewportRect.right,
          };
        }),
      };
    });
    expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
    expect(metrics.listOverflow).toBeLessThanOrEqual(1);
    expect(metrics.rows.length).toBeGreaterThan(0);
    for (const row of metrics.rows) {
      expect(row.wordVisible).toBe(true);
      expect(row.meaningVisible).toBe(true);
      expect(row.buttonVisible).toBe(true);
      expect(row.wordRight).toBeLessThanOrEqual(row.rowRight + 1);
      expect(row.meaningRight).toBeLessThanOrEqual(row.rowRight + 1);
      expect(row.buttonLeft).toBeGreaterThan(0);
      expect(row.buttonRight).toBeLessThanOrEqual(row.viewportRight + 1);
      expect(row.rowRight).toBeLessThanOrEqual(row.viewportRight + 1);
    }
    const now = await marker.verify();
    expect(now.marker).toBe(marker.value.marker);
    expect(now.url).toBe(marker.value.url);
  };
  await verifyGeometry();
  await collapseAndRestore(page, verifyGeometry);
});

test("Flow B3：背诵虚拟列表滚动时复用重叠行，逻辑条纹背景不翻转", async ({ page }) => {
  await createAccount(page, uniqueUsername("flow17-memorize-scroll"));
  await navTo(page, "背诵");
  const frame = await waitForFrameByUrl(page, "memorize.html");
  await frame.locator(".word-row").first().waitFor({ state: "attached", timeout: 90000 });
  const baseline = await frame.evaluate(() => {
    const rows = [...document.querySelectorAll(".word-row")];
    const row = rows[10];
    row.__flow17StableRow = "stable-row";
    return {
      wordId: row.dataset.wordId,
      background: getComputedStyle(row).backgroundColor,
      alternate: row.classList.contains("is-alternate"),
    };
  });
  await frame.evaluate(() => {
    const viewport = document.querySelector(".word-viewport");
    viewport.scrollTop = 9 * 76;
  });
  await page.waitForTimeout(120);
  const after = await frame.evaluate((wordId) => {
    const row = [...document.querySelectorAll(".word-row")].find((item) => item.dataset.wordId === wordId);
    return {
      sameNode: row?.__flow17StableRow === "stable-row",
      background: row ? getComputedStyle(row).backgroundColor : "",
      alternate: row?.classList.contains("is-alternate"),
    };
  }, baseline.wordId);
  expect(after.sameNode).toBe(true);
  expect(after.background).toBe(baseline.background);
  expect(after.alternate).toBe(baseline.alternate);
});

test("Flow C：导入词库全部设熟知真实生效、原词库保留、重复执行幂等", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow17-import"));
  await seedImportedList(page, username, "Flow17 List");
  await navTo(page, "词库");
  const frame = await waitForFrameByUrl(page, "index.html");
  await openVocabularyLists(page, frame);
  await frame.getByText("Flow17 List").waitFor({ timeout: 45000 });

  const familiarButton = frame.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
    { hasText: "全部设熟知" },
  );
  await expect(familiarButton).toBeVisible({ timeout: 30000 });

  const dialogs = [];
  page.on("dialog", (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    dialog.accept().catch(() => {});
  });
  await frame.evaluate(() => { window.__flow17Gen = 1; });
  await familiarButton.click();
  await expect.poll(() => dialogs.some((d) => d.type === "confirm"), { timeout: 10000 }).toBe(true);
  await expect.poll(
    () => dialogs.some((d) => d.type === "alert" && d.message.includes("已加入 2 个词")),
    { timeout: 15000 },
  ).toBe(true);

  await expect.poll(async () => {
    const current = vocabularyFrame(page);
    if (!current) return false;
    return current.evaluate(() => window.__flow17Gen === undefined).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
  const frameAfter = await waitForFrameByUrl(page, "index.html");
  // Embedded reload restores the host dashboard route. Re-enter the library
  // through its real button before inspecting the persisted classification.
  await openVocabularyLists(page, frameAfter);
  await frameAfter.getByText("熟知词库_Flow17 List").waitFor({ timeout: 30000 });
  await expect(frameAfter.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
    { hasText: "全部设熟知" },
  )).toBeVisible({ timeout: 30000 });

  const data = await frameAfter.evaluate(async (user) => {
    const bridge = await import("/vocabulary/imported-word-bridge.js");
    const imported = await bridge.getImportedMainLists(user);
    const main = await new Promise((resolve) => {
      const req = indexedDB.open("KaoyanVocabDB");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    let familiar = [];
    if (main) {
      const tx = main.transaction("wordLists", "readonly");
      const allReq = tx.objectStore("wordLists").getAll();
      await new Promise((resolve) => {
        allReq.onsuccess = resolve;
        allReq.onerror = resolve;
      });
      familiar = allReq.result.filter((list) => (
        list.type === "familiar" && list.derivedFromImportId === "import:flow17-list"
      ));
      main.close();
    }
    return {
      imported: imported.map((list) => ({ name: list.name, count: list.wordIds.length })),
      familiar,
    };
  }, username);
  expect(data.imported.some((list) => list.name === "Flow17 List")).toBe(true);
  expect(data.familiar.length).toBe(1);
  expect(data.familiar[0].wordIds.length).toBe(2);

  const beforeCount = dialogs.length;
  await frameAfter.evaluate(() => { window.__flow17Gen = 1; });
  await frameAfter.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
  ).click();
  await expect.poll(
    () => dialogs.length > beforeCount
      && dialogs.some((d) => d.type === "alert" && d.message.includes("已加入 0 个词")),
    { timeout: 15000 },
  ).toBe(true);
  await expect.poll(async () => {
    const current = vocabularyFrame(page);
    if (!current) return false;
    return current.evaluate(() => window.__flow17Gen === undefined).catch(() => false);
  }, { timeout: 20000 }).toBe(true);
  const frameFinal = await waitForFrameByUrl(page, "index.html");
  await openVocabularyLists(page, frameFinal);
  await frameFinal.getByText("熟知词库_Flow17 List").waitFor({ timeout: 30000 });
  await expect(frameFinal.locator(".imported-list-classify")).toHaveCount(2);
});

test("Regression 5.1：/lists 下 embedded tools 无 MutationObserver 自激循环，DOM 稳定", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow17-stable"));
  await seedImportedList(page, username, "Stable List");
  await navTo(page, "词库");
  const frame = await waitForFrameByUrl(page, "index.html");
  await openVocabularyLists(page, frame);
  await frame.getByText("Stable List").waitFor({ timeout: 45000 });
  await expect(frame.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
    { hasText: "全部设熟知" },
  )).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1200);

  const stability = await frame.evaluate(async () => {
    const root = document.getElementById("root");
    let toolMutations = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const nodes = [...record.addedNodes, ...record.removedNodes];
        if (nodes.some((node) => node.id === "embeddedVocabActions")) toolMutations += 1;
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    const identities = [];
    for (let i = 0; i < 4; i += 1) {
      identities.push(document.getElementById("embeddedVocabActions"));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    observer.disconnect();
    return {
      toolMutations,
      stable: identities.every((node, index) => index === 0 || node === identities[index - 1]),
      containerCount: document.querySelectorAll("#embeddedVocabActions").length,
    };
  });
  expect(stability.toolMutations).toBe(0);
  expect(stability.stable).toBe(true);
  expect(stability.containerCount).toBe(1);
  expect(await frame.locator(".imported-list-classify").count()).toBe(2);
});

test("Regression 5.2：route 不变但工具容器被删除后自动恢复，真实 rerender 后操作仍完整", async ({ page }) => {
  const username = await createAccount(page, uniqueUsername("flow17-recover"));
  await seedImportedList(page, username, "Recover List");
  await navTo(page, "词库");
  const frame = await waitForFrameByUrl(page, "index.html");
  await openVocabularyLists(page, frame);
  await frame.getByText("Recover List").waitFor({ timeout: 45000 });
  await expect(frame.locator("#embeddedVocabActions")).toBeAttached({ timeout: 30000 });
  await expect(frame.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
    { hasText: "全部设熟知" },
  )).toBeVisible({ timeout: 30000 });

  await frame.evaluate(() => document.getElementById("embeddedVocabActions")?.remove());
  await expect(frame.locator("#embeddedVocabActions")).toBeAttached({ timeout: 30000 });

  let promptValue = "Recover Renamed";
  page.on("dialog", (dialog) => {
    if (dialog.type() === "prompt") {
      dialog.accept(promptValue).catch(() => {});
    } else {
      dialog.accept().catch(() => {});
    }
  });
  await frame.getByRole("button", { name: "重命名" }).click();
  await frame.getByText("Recover Renamed").waitFor({ timeout: 30000 });

  await expect(frame.locator("#embeddedVocabActions")).toBeAttached({ timeout: 30000 });
  await expect(frame.locator("#embeddedVocabActions")).toContainText("导入 PDF / Excel");
  await expect(frame.locator(
    '.imported-list-classify[data-imported-list-classification="familiar"]',
    { hasText: "全部设熟知" },
  )).toBeVisible({ timeout: 30000 });
  expect(await frame.locator("#embeddedVocabActions").count()).toBe(1);
  expect(await frame.locator(".imported-list-classify").count()).toBe(2);
  expect(await frame.evaluate(() => location.hash)).toBe("#/lists");
});
