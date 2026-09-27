import { test, expect } from "@playwright/test";

test("真实美音文件完整播放到 ended，连续点词不会重叠", async ({ page }) => {
  await page.goto("/vocabulary/pronunciation-credits.html");
  await page.addScriptTag({ url: "/vocabulary/pronunciation.js" });
  await page.evaluate(() => {
    const NativeAudio = window.Audio;
    window.__audioEvents = [];
    window.__ttsFallback = [];
    window.speechSynthesis.speak = (u) => { window.__ttsFallback.push(u.text); queueMicrotask(() => u.onend?.()); };
    window.Audio = function(src) {
      const audio = new NativeAudio(src);
      for (const event of ["playing", "pause", "ended", "error"]) {
        audio.addEventListener(event, () => window.__audioEvents.push({ event, src, time: audio.currentTime, duration: audio.duration }));
      }
      return audio;
    };
  });
  // The click supplies a browser user gesture; the audio itself is never mocked.
  await page.evaluate(() => {
    const button = document.createElement("button"); button.id = "audio-check"; button.textContent = "播放检查";
    button.onclick = async () => {
      for (const word of ["abandon", "significant", "increase", "physics", "first", "last"]) await window.WuliaoPronunciation.speak(word);
      window.__audioDone = true;
    };
    document.body.append(button);
  });
  await page.locator("#audio-check").click();
  await expect.poll(() => page.evaluate(() => Boolean(window.__audioDone)), { timeout: 45000 }).toBe(true);
  const result = await page.evaluate(() => ({ events: window.__audioEvents, fallback: window.__ttsFallback }));
  expect(result.fallback).toEqual([]);
  expect(result.events.filter((e) => e.event === "error")).toEqual([]);
  const ended = result.events.filter((e) => e.event === "ended");
  expect(ended).toHaveLength(6);
  for (const event of ended) {
    expect(event.src).toMatch(/\?v=[a-f0-9]{16,64}$/);
    expect(event.duration).toBeGreaterThan(.3);
    expect(Math.abs(event.time - event.duration)).toBeLessThan(.03);
  }
  await page.evaluate(async () => {
    window.__audioEvents = [];
    const first = window.WuliaoPronunciation.speak("significant");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const second = window.WuliaoPronunciation.speak("abandon");
    await Promise.all([first, second]);
  });
  const events = await page.evaluate(() => window.__audioEvents);
  expect(events.filter((e) => e.event === "ended")).toHaveLength(1);
  expect(events.some((e) => e.event === "pause")).toBe(true);
});

test("缺失词使用设备美音兜底；有词性的异读词选择对应文件", async ({ page }) => {
  await page.goto("/vocabulary/pronunciation-credits.html");
  await page.addScriptTag({ url: "/vocabulary/pronunciation.js" });
  const result = await page.evaluate(async () => {
    const fallback = [];
    window.speechSynthesis.speak = (u) => { fallback.push({ text: u.text, lang: u.lang }); queueMicrotask(() => u.onend?.()); };
    await window.WuliaoPronunciation.speak("newlyimportedtestword");
    return {
      fallback, noun: await window.WuliaoPronunciation.find("record", "noun"), verb: await window.WuliaoPronunciation.find("record", "verb"),
      conduct: await window.WuliaoPronunciation.find("conduct"), conductVerb: await window.WuliaoPronunciation.find("conduct", "verb"),
      content: await window.WuliaoPronunciation.find("content"), contentNoun: await window.WuliaoPronunciation.find("content", "noun"),
      digest: await window.WuliaoPronunciation.find("digest"), digestNoun: await window.WuliaoPronunciation.find("digest", "noun"),
      alternate: await window.WuliaoPronunciation.find("alternate"), alternateAdjective: await window.WuliaoPronunciation.find("alternate", "adjective"),
      verbDefaults: await Promise.all(["live", "close", "permit", "attribute", "console", "convict", "coordinate", "excuse", "rebel", "suspect"].map(async word => ({
        word, selected: await window.WuliaoPronunciation.find(word), expected: await window.WuliaoPronunciation.find(word, "verb"),
      }))),
    };
  });
  expect(result.fallback).toEqual([{ text: "newlyimportedtestword", lang: "en-US" }]);
  expect(result.noun.path).not.toBe(result.verb.path);
  expect(result.conduct.path).toBe(result.conductVerb.path);
  expect(result.content.path).toBe(result.contentNoun.path);
  expect(result.digest.path).toBe(result.digestNoun.path);
  expect(result.alternate.path).toBe(result.alternateAdjective.path);
  for (const item of result.verbDefaults) expect(item.selected.path, item.word).toBe(item.expected.path);
});
