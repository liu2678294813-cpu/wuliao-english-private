(() => {
  if (window.WuliaoPronunciation) return;
  try { if (window.parent !== window && window.parent.WuliaoPronunciation) { window.WuliaoPronunciation = window.parent.WuliaoPronunciation; return; } } catch { /* standalone */ }
  const base = "/vocabulary/pronunciation/";
  let manifestPromise, variantsPromise, sequence = 0, active = null, settle = null;
  const key = (word) => String(word || "").trim().toLowerCase().replace(/\s+/g, " ");
  function stop() {
    sequence++;
    if (active) { active.pause(); active.removeAttribute("src"); active.load(); active = null; }
    window.speechSynthesis?.cancel();
    if (settle) { settle(); settle = null; }
  }
  async function catalog() {
    manifestPromise ||= fetch(base + "index.json", { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error("audio catalog unavailable"); return r.json(); }).catch((error) => { manifestPromise = null; throw error; });
    return manifestPromise;
  }
  async function find(word, pos) {
    const manifest = await catalog();
    const wordKey = key(word);
    const selectedPos = String(pos || manifest.defaultPos?.[wordKey] || "").trim().toLowerCase();
    if (selectedPos) {
      if (manifest.variants?.[wordKey]?.[selectedPos]) return manifest.variants[wordKey][selectedPos];
      variantsPromise ||= fetch(base + "variants.json", { cache: "no-cache" }).then((r) => r.ok ? r.json() : {}).catch(() => ({}));
      const variants = await variantsPromise;
      if (variants[wordKey]?.[selectedPos]) return variants[wordKey][selectedPos];
    }
    return manifest.entries?.[wordKey];
  }
  function fallback(word, token) {
    if (token !== sequence) return Promise.resolve();
    if (window.AndroidSpeech?.speak) { window.AndroidSpeech.speak(word); return Promise.resolve(); }
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return Promise.reject(new Error("当前设备无法播放发音"));
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = "en-US"; utterance.rate = .9;
      const voice = speechSynthesis.getVoices().find((v) => /^en[-_]US$/i.test(v.lang));
      if (voice) utterance.voice = voice;
      settle = resolve; utterance.onend = utterance.onerror = () => { if (token === sequence) settle = null; resolve(); };
      speechSynthesis.speak(utterance);
    });
  }
  async function speak(word, { pos } = {}) {
    stop();
    const text = String(word || "").trim();
    if (!text) return;
    const token = sequence;
    let entry;
    try { entry = await find(text, pos); } catch { /* device fallback remains available offline */ }
    if (token !== sequence) return;
    if (!entry?.path || !/^audio\/[a-zA-Z0-9_.-]+\.(ogg|mp3|wav)$/.test(entry.path)) return fallback(text, token);
    try {
      await new Promise((resolve, reject) => {
        const revision = entry.revision || entry.sha256;
        const version = typeof revision === "string" && /^[a-f0-9]{16,64}$/.test(revision) ? `?v=${revision}` : "";
        const audio = new Audio(base + entry.path + version); active = audio;
        let timer;
        const finish = (error) => { clearTimeout(timer); if (token === sequence) { active = null; settle = null; } error ? reject(error) : resolve(); };
        settle = () => finish();
        audio.onended = () => finish(); audio.onerror = () => finish(new Error("audio unavailable"));
        timer = setTimeout(() => { audio.pause(); finish(new Error("audio timeout")); }, 15000);
        audio.play().catch(finish);
      });
    } catch { if (token === sequence) return fallback(text, token); }
  }
  window.WuliaoPronunciation = Object.freeze({ speak, stop, find });
  window.addEventListener("pagehide", stop);
})();
