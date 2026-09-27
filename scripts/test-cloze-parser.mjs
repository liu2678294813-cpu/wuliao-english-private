import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildClozeFromPages,
  parseClozeSection,
  normalizeCloze,
} from "../src/clozeParser.js";
import {
  parseClozeAnswerSheet,
  getClozeOfficialAnswerKey,
  YEAR_CLOZE_KEYS,
} from "../src/clozeAnswerKeys.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures", "cloze");
const ASSET_DIR = join(__dirname, "..", "public", "library", "postgraduate");

async function loadPages(year) {
  return JSON.parse(await readFile(join(FIXTURE_DIR, `${year}-pages.json`), "utf8"));
}

async function loadAnswerPage(year) {
  return readFile(join(FIXTURE_DIR, `${year}-answerpage.txt`), "utf8");
}

// ---------------- 正常情况（真实 OCR 夹具） ----------------

test("2010 真题：识别 Section I，20 空，每空 4 选项，A/B/C/D 顺序", async () => {
  const pages = await loadPages(2010);
  const cloze = buildClozeFromPages(pages, "2010");
  assert.ok(cloze, "应识别到 Section I");
  assert.equal(cloze.type, "cloze");
  assert.equal(cloze.label, "Section I · Use of English");
  assert.equal(cloze.blanks.length, 20, "应得到 20 空");
  assert.equal(cloze.detectedBlanks, 20, "正文应检测到 20 个空位");
  for (const blank of cloze.blanks) {
    assert.equal(blank.options.length, 4, `空 ${blank.number} 应有 4 选项`);
    assert.deepEqual(
      blank.options.map((o) => o.key),
      ["A", "B", "C", "D"],
      `空 ${blank.number} 选项顺序应为 A/B/C/D`,
    );
  }
});

test("2007 真题：20 空，正文空位顺序正确，选项不被拼入正文", async () => {
  const pages = await loadPages(2007);
  const cloze = buildClozeFromPages(pages, "2007");
  assert.ok(cloze);
  assert.equal(cloze.blanks.length, 20);
  assert.equal(cloze.detectedBlanks, 20);
  const blankNumbers = cloze.paragraphs
    .flatMap((p) => p.segments)
    .filter((s) => s.type === "blank")
    .map((s) => s.number);
  for (let i = 0; i < blankNumbers.length; i += 1) {
    assert.equal(blankNumbers[i], i + 1, `正文第 ${i + 1} 个空位应为空 ${i + 1}`);
  }
  // 正文不应包含选项文字
  const passageText = cloze.paragraphs.map((p) => p.text).join(" ");
  assert.ok(!/\[A\]\s*\w+/.test(passageText), "正文不应混入选项");
});

test("2009 真题：正文含 I.Q. 等数字陷阱不误判为空位", async () => {
  const pages = await loadPages(2009);
  const cloze = buildClozeFromPages(pages, "2009");
  assert.ok(cloze);
  assert.equal(cloze.blanks.length, 20);
});

test("2016 真题：Section | Use of English（I→|）变体可识别", async () => {
  const pages = await loadPages(2016);
  const cloze = buildClozeFromPages(pages, "2016");
  assert.ok(cloze, "应识别 OCR 变体 Section | Use of English");
  assert.equal(cloze.blanks.length, 20);
  assert.equal(cloze.detectedBlanks, 20);
});

test("2023 真实 OCR marker：第 4 空逗号题号与第 15 空竖线括号不串项", async () => {
  const pages = await loadPages(2023);
  const cloze = buildClozeFromPages(pages, "2023");
  assert.equal(cloze.detectedBlanks, 20);
  assert.deepEqual(
    cloze.blanks[3].options.map((option) => option.text),
    ["classify", "record", "describe", "connect"],
  );
  assert.deepEqual(
    cloze.blanks[14].options.map((option) => option.text),
    ["aided", "invested", "failed", "competed"],
  );
});

test("通用 OCR marker normalization 覆盖缺括号、竖线、重复字母与 D7", () => {
  const text = `Section I Use of English
Directions: Choose. (10 points)
A sufficiently long English passage includes 1 one blank and continues with enough words for parsing.
I. [ A] alpha | B] beta [| C] gamma [ D] delta
2. [AA] apple [B] berry [C|] citrus D7 date
3. [A] able [B] bold [CJ] calm [D] direct`;
  const cloze = parseClozeSection(text, "marker-variants");
  assert.deepEqual(cloze.blanks[0].options.map((option) => option.text), ["alpha", "beta", "gamma", "delta"]);
  assert.deepEqual(cloze.blanks[1].options.map((option) => option.text), ["apple", "berry", "citrus", "date"]);
  assert.deepEqual(cloze.blanks[2].options.map((option) => option.text), ["able", "bold", "calm", "direct"]);
});

test("2007–2023 真实 OCR 夹具：每年正文 20 空且每空 A/B/C/D 非空无 marker 残留", async () => {
  for (let year = 2007; year <= 2023; year += 1) {
    const cloze = buildClozeFromPages(await loadPages(year), String(year));
    assert.ok(cloze, `${year} 应识别完形`);
    assert.equal(cloze.detectedBlanks, 20, `${year} 正文应还原 20 空`);
    assert.equal(cloze.blanks.length, 20, `${year} 应生成 20 个选项组`);
    for (const blank of cloze.blanks) {
      assert.equal(blank.complete, true, `${year} 第 ${blank.number} 空应完整`);
      assert.deepEqual(blank.options.map((option) => option.key), ["A", "B", "C", "D"]);
      for (const option of blank.options) {
        assert.ok(option.text.trim(), `${year} 第 ${blank.number} 空 ${option.key} 不得为空`);
        assert.doesNotMatch(option.text, /(?:\[\s*\|?\s*[A-D]|\|\s*(?:\|\s*)?[A-D]\s*\]|\b[A-D]7\b)/i,
          `${year} 第 ${blank.number} 空 ${option.key} 不得残留 OCR marker`);
      }
    }
  }
});

test("2007–2023 官方完形资产：20 空、完整选项、无串项且 officialAnswer 可解析", async () => {
  for (let year = 2007; year <= 2023; year += 1) {
    const asset = JSON.parse(await readFile(join(ASSET_DIR, String(year), `${year}-cloze.json`), "utf8"));
    const official = getClozeOfficialAnswerKey({ year });
    assert.equal(asset.blanks.length, 20, `${year} 资产应有 20 空`);
    assert.equal(Object.keys(official).length, 20, `${year} 应有 20 个官方答案`);
    for (const blank of asset.blanks) {
      const keys = blank.options.map((option) => option.key);
      assert.deepEqual(keys, ["A", "B", "C", "D"], `${year} 第 ${blank.number} 空选项 key`);
      assert.equal(blank.complete, true, `${year} 第 ${blank.number} 空应 complete`);
      assert.ok(keys.includes(official[blank.number]), `${year} 第 ${blank.number} 空官方答案必须指向有效选项`);
      for (const option of blank.options) {
        assert.ok(option.text.trim(), `${year} 第 ${blank.number} 空 ${option.key} 不得为空`);
        assert.doesNotMatch(option.text, /(?:\[\s*\|?\s*[A-D]|\|\s*(?:\|\s*)?[A-D]\s*\]|\b[A-D]7\b)/i,
          `${year} 第 ${blank.number} 空 ${option.key} 不得串项或残留 marker`);
      }
    }
  }
});

test("自然段结构存在且多于 1 段", async () => {
  const pages = await loadPages(2010);
  const cloze = buildClozeFromPages(pages, "2010");
  assert.ok(cloze.paragraphs.length >= 2, "完形正文应有多段");
});

// ---------------- 异常情况 ----------------

test("没有 Section I 时返回 null，不崩溃", () => {
  const pages = [{ pageNumber: 1, text: "Some random text without any section header." }];
  assert.equal(buildClozeFromPages(pages, "test"), null);
});

test("文本不完整（只有部分空）仍返回结果且带 warnings", () => {
  const text = `Section I Use of English
Directions: Read the following text. Choose the best word(s) for each numbered blank. (10 points)
This is a short passage with only 1 blank and 2 more.
1. [A] one [B] two [C] three [D] four
2. [A] alpha [B] beta`;
  const cloze = parseClozeSection(text, "incomplete");
  assert.ok(cloze);
  assert.ok(cloze.warnings.length > 0, "不完整文本应有警告");
});

test("某空缺选项时不崩溃且标记 incomplete", () => {
  const text = `Section I Use of English
Directions: Choose the best word(s). (10 points)
A passage with 1 one blank here and 2 second blank.
1. [A] one [B] two
2. [A] alpha [B] beta [C] gamma [D] delta`;
  const cloze = parseClozeSection(text, "partial-options");
  assert.ok(cloze);
  assert.equal(cloze.blanks[0].options.length, 4);
  assert.equal(cloze.blanks[0].options[2].text, "");
  assert.equal(cloze.blanks[0].complete, false);
});

test("同时存在 Section I 和 Section II（Reading）时不把阅读并入完形", () => {
  const text = `Section I Use of English
Directions: Choose the best word(s). (10 points)
This passage has one 1 blank.
1. [A] x [B] y [C] z [D] w
Section II Reading Comprehension
Part A
Directions: Read the following texts.
21. What is the main idea? [A] ... [B] ...`;
  const cloze = parseClozeSection(text, "with-reading");
  assert.ok(cloze);
  assert.equal(cloze.blanks.length, 20);
  assert.equal(cloze.blanks[0].options[0].text, "x");
  // 阅读 Section II 内容不应出现在完形选项中
  for (const blank of cloze.blanks) {
    for (const option of blank.options) {
      assert.ok(!/main idea/.test(option.text), "阅读题干不应混入完形选项");
    }
  }
});

test("选项跨行时仍能正确合并", () => {
  const text = `Section I Use of English
Directions: Choose. (10 points)
A passage with one 1 blank.
1. [A] this is a very long option that
spans multiple lines [B] short [C] third [D] fourth`;
  const cloze = parseClozeSection(text, "multiline-options");
  assert.ok(cloze);
  assert.ok(cloze.blanks[0].options[0].text.length > 10, "跨行选项应合并");
  assert.equal(cloze.blanks[0].options[1].text, "short");
});

test("页眉页脚噪声不混入正文段落", async () => {
  const pages = await loadPages(2010);
  const cloze = buildClozeFromPages(pages, "2010");
  for (const paragraph of cloze.paragraphs) {
    assert.ok(!/F\d{3}\s*R/.test(paragraph.text), "页脚噪声不应混入正文");
  }
});

test("normalizeCloze 对缺失字段做兼容补齐", () => {
  const raw = {
    type: "cloze",
    label: "test",
    paragraphs: [{ number: 1, text: "hello 1 world", segments: [{ type: "blank", number: 1 }] }],
    blanks: [{ number: 1, options: [{ key: "A", text: "x" }] }],
  };
  const normalized = normalizeCloze(raw);
  assert.equal(normalized.blanks.length, 20);
  assert.equal(normalized.blanks[0].options.length, 4);
  assert.equal(normalized.blanks[0].options[0].text, "x");
  assert.equal(normalized.blanks[0].options[1].text, "");
  assert.equal(normalized.blanks[1].number, 2);
  assert.deepEqual(normalized.warnings, []);
  assert.equal(normalized.sourcePages.length, 0);
});

// ---------------- 答案速查页解析 ----------------

test("2010 答案速查页：提取完形 1–20 与阅读 21–40", async () => {
  const text = await loadAnswerPage(2010);
  const parsed = parseClozeAnswerSheet(text);
  assert.equal(Object.keys(parsed.cloze).length, 20, "应提取 20 个完形答案");
  for (let n = 1; n <= 20; n += 1) {
    assert.ok(parsed.cloze[n], `空 ${n} 应有答案`);
    assert.match(parsed.cloze[n], /^[A-D]$/);
  }
  assert.equal(Object.keys(parsed.reading).length, 20, "应提取 20 个阅读答案");
});

test("2007 答案速查页：与 YEAR_CLOZE_KEYS 一致", async () => {
  const text = await loadAnswerPage(2007);
  const parsed = parseClozeAnswerSheet(text);
  const expected = YEAR_CLOZE_KEYS[2007];
  let extracted = "";
  for (let n = 1; n <= 20; n += 1) extracted += parsed.cloze[n] || "?";
  assert.equal(extracted, expected, "提取的完形答案应与固化表一致");
});

test("getClozeOfficialAnswerKey 返回 {1:'A',..,20:'D'} 格式", () => {
  const key = getClozeOfficialAnswerKey({ year: 2010 });
  assert.equal(Object.keys(key).length, 20);
  assert.equal(key[1], "A");
  assert.equal(key[20], "D");
  assert.match(key[10], /^[A-D]$/);
});

test("getClozeOfficialAnswerKey 对未覆盖年份返回 {}", () => {
  const key = getClozeOfficialAnswerKey({ year: 1999 });
  assert.deepEqual(key, {});
});

test("所有 17 年（2007-2023）YEAR_CLOZE_KEYS 均有 20 字答案串", () => {
  for (let year = 2007; year <= 2023; year += 1) {
    const keys = YEAR_CLOZE_KEYS[year];
    assert.ok(keys, `${year} 应有答案`);
    assert.equal(keys.length, 20, `${year} 答案串应为 20 字符`);
    assert.match(keys, /^[A-D]{20}$/, `${year} 答案串应全部为 A-D`);
  }
});

test("答案速查页 OCR 噪声 50D / l16 等被正确修复", async () => {
  const text = await loadAnswerPage(2017);
  const parsed = parseClozeAnswerSheet(text);
  assert.equal(Object.keys(parsed.cloze).length, 20, "2017 应提取 20 空答案");
});

// ---------------- 回归：精读 workbook 不误判 ----------------

test("阅读精读 workbook 文本不被误识别为完形", () => {
  const pages = [{
    pageNumber: 1,
    text: "READING DEEP-DIVE WORKBOOK\nText 1\nThis is a reading comprehension passage about economics. It has no numbered blanks or cloze structure.\n21. What is the main idea? [A] ... [B] ... [C] ... [D] ...",
  }];
  assert.equal(buildClozeFromPages(pages, "workbook"), null);
});
