import { interactionTiming } from './interaction-timing.js';
// All question fields are published together. Storage never owns visible state.
export function createScreeningController(api, publish, clock = globalThis) {
  let version = 0, state = {}, session, pending = null, preparedNext = null, locked = true, disposed = false;
  let timer = null, releaseTimer = null;
  let pendingSave = null;
  const initial = { currentEnglish: '', currentChinese: '', currentCorrectOptionChinese: '', options: [],
    currentIndex: 0, totalWords: 0, correctCount: 0, wrongCount: 0, answered: false,
    selectedOptionId: null, optionStates: {}, isComplete: false, loading: true,
    familiarName: '', rawName: '', rawListId: null };
  const emit = (patch) => { state = { ...state, ...patch }; publish(state); };
  const valid = (v) => !disposed && v === version;
  function cancelTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null; releaseTimer?.(); releaseTimer = null;
  }
  const wait = (ms) => new Promise((resolve) => {
    if (ms <= 0) return resolve();
    releaseTimer = resolve;
    timer = clock.setTimeout(() => { timer = null; releaseTimer = null; resolve(); }, ms);
  });
  async function question(index, v) {
    const currentSession = session;
    if (index >= currentSession.sourceWordIds.length) return { isComplete: true, loading: false };
    const wordId = currentSession.sourceWordIds[index];
    const [word, options] = await Promise.all([api.word(wordId), api.options(wordId)]);
    return { questionId: `${currentSession.sessionKey}:${v}:${index}:${wordId}`, sessionVersion: v,
      currentEnglish: word?.english ?? wordId, currentChinese: word?.chinese ?? '',
      currentCorrectOptionChinese: options.find((option) => option.isCorrect)?.chinese ?? '',
      options: options.map((option) => ({ ...option, chinese: option.chinese.replace(/^[A-L][.、]\s*/, '') })),
      currentIndex: index, optionStates: Object.fromEntries(options.map((option) => [option.id, 'idle'])),
      answered: false, selectedOptionId: null, loading: false, isComplete: false };
  }
  async function start(username, round, listId) {
    if (disposed) return;
    const v = ++version; cancelTimer(); locked = true;
    preparedNext = null;
    emit({ ...initial, round, sessionVersion: v });
    try {
      const loaded = await api.load(username, round, listId);
      if (!valid(v)) return;
      session = loaded;
      const next = await question(session.currentIndex, v);
      if (!valid(v)) return;
      emit({ ...next, totalWords: session.sourceWordIds.length,
        correctCount: session.correctIds.length, wrongCount: session.wrongIds.length });
      locked = false;
      preparedNext = prepare(session.currentIndex + 1, v);
    } catch (error) {
      if (valid(v)) { emit({ loading: false }); api.error('题目加载失败，请重新进入', error); }
    }
  }
  const prepare = (index, v) => question(index, v).then((value) => ({ value }), (error) => ({ error }));
  function answer(optionId) {
    if (locked || disposed || state.isComplete || state.loading) return pending;
    const selected = state.options.find((option) => option.id === optionId);
    if (!selected && optionId !== api.skipId) return;
    locked = true;
    const timing = interactionTiming('screening');
    const v = version, before = state, correct = selected?.isCorrect === true;
    const feedbackAt = clock.performance.now();
    const optionStates = Object.fromEntries(state.options.map((option) => [option.id,
      option.id === optionId ? (correct ? 'correct' : 'wrong') : option.isCorrect ? 'correct' : 'idle']));
    emit({ answered: true, selectedOptionId: optionId, optionStates });
    timing.feedback();
    const feedbackShown = correct ? Promise.resolve(feedbackAt) : Promise.resolve(api.feedbackShown?.() ?? feedbackAt);
    const nextSession = { ...session, currentIndex: session.currentIndex + 1,
      correctIds: [...session.correctIds], wrongIds: [...session.wrongIds], updatedAt: Date.now() };
    nextSession[correct ? 'correctIds' : 'wrongIds'].push(session.sourceWordIds[session.currentIndex]);
    // Attach rejection handling immediately while the current answer is saving.
    const prepared = preparedNext || prepare(nextSession.currentIndex, v);
    let saved = false;
    const work = (async () => {
      try {
        const saving = timing.save(() => api.save(nextSession, { username: session.username,
          wordId: session.sourceWordIds[session.currentIndex], round: session.round,
          result: correct ? 'correct' : 'wrong', timestamp: Date.now() },
        !correct && selected?.sourceWord ? { username: session.username, round: session.round,
          correctEnglish: before.currentEnglish, correctChinese: before.currentCorrectOptionChinese || before.currentChinese,
          wrongChinese: selected.chinese, sourceWord: selected.sourceWord,
          sourceWordChinese: selected.sourceWordChinese ?? '', timestamp: Date.now() } : null));
        pendingSave = saving;
        saving.then(() => { if (pendingSave === saving) pendingSave = null; }, () => { if (pendingSave === saving) pendingSave = null; });
        const completion = await saving;
        saved = true;
        if (!valid(v)) return;
        session = nextSession;
        const next = await prepared;
        if (next.error) throw next.error;
        const shownAt = await feedbackShown;
        if (!valid(v)) return;
        await wait(correct ? 0 : Math.max(0, 1000 - (clock.performance.now() - shownAt)));
        if (!valid(v)) return;
        emit({ ...next.value, ...completion, correctCount: session.correctIds.length, wrongCount: session.wrongIds.length });
        locked = false;
        preparedNext = prepare(session.currentIndex + 1, v);
      } catch (error) {
        if (valid(v)) {
          // A committed answer must never be submitted twice after preparation fails.
          if (!saved) { emit(before); locked = false; }
          api.error(saved ? '记录已保存，下一题加载失败，请重新进入' : '保存失败，仍在本题，请重试', error);
        }
        throw error;
      }
    })();
    pending = work;
    work.catch(() => {}).finally(() => { if (pending === work) pending = null; });
    return work;
  }
  return { start, answer, getState: () => state, getSession: () => session,
    flush: () => pendingSave || Promise.resolve(),
    invalidate() { ++version; cancelTimer(); locked = true; },
    dispose() { disposed = true; ++version; cancelTimer(); } };
}

export function useScreening(React, api, username, round, listId) {
  const [state, setState] = React.useState({ loading: true, options: [], optionStates: {} });
  const controller = React.useRef(null);
  React.useLayoutEffect(() => {
    if (!state.questionId || state.loading || state.isComplete) return;
    const displayed = { id: state.questionId, english: state.currentEnglish };
    window.__wuliaoDisplayedQuestion = displayed;
    return () => { if (window.__wuliaoDisplayedQuestion === displayed) delete window.__wuliaoDisplayedQuestion; };
  }, [state.questionId, state.loading, state.isComplete]);
  React.useEffect(() => {
    if (!username) return;
    let active = true;
    let shuffleVersion = 0, shuffleWork = Promise.resolve();
    const current = createScreeningController({ ...api,
      feedbackShown: () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(() => resolve(performance.now()), 0))),
    }, setState);
    controller.current = current;
    const flush = () => current.flush();
    window.__wuliaoFlushVocabulary = flush;
    const context = async () => {
      const session = current.getSession();
      if (!session) throw new Error('题目尚未就绪');
      return { username, listId, round, currentIndex: current.getState().currentIndex,
        questionId: current.getState().questionId, sessionVersion: current.getState().sessionVersion,
        sourceWordIds: [...session.sourceWordIds], listName: listId ? (await api.list(listId))?.name || '当前词库' : '原始总词库',
        words: await api.words(session.sourceWordIds) };
    };
    window.__wuliaoScreeningContext = context;
    current.start(username, round, listId);
    const shuffle = () => {
      const request = ++shuffleVersion;
      current.invalidate();
      shuffleWork = shuffleWork.catch(() => {}).then(async () => {
        try {
          await current.flush(); if (!active || request !== shuffleVersion) return;
          await api.shuffle(username, round, listId);
          if (active && request === shuffleVersion) await current.start(username, round, listId);
        } catch (error) { if (active) { api.error('切换顺序失败，请重试', error); await current.start(username, round, listId); } }
      });
    };
    window.addEventListener('wuliao:shuffle-restart', shuffle);
    return () => {
      active = false;
      current.dispose();
      window.removeEventListener('wuliao:shuffle-restart', shuffle);
      if (window.__wuliaoFlushVocabulary === flush) delete window.__wuliaoFlushVocabulary;
      if (window.__wuliaoScreeningContext === context) delete window.__wuliaoScreeningContext;
    };
  }, [username, round, listId]);
  return { ...state, handleAnswer: (id) => { controller.current?.answer(id)?.catch(() => {}); },
    handleSkip: () => { controller.current?.answer(api.skipId)?.catch(() => {}); } };
}

export function screeningApi(deps) {
  const { db, sessionKey, getSession, getProgress, list, rawList, allIds, shuffleWords,
    word, words, options, makeList, removeSession, skipId } = deps;
  return { word, words, options, list, skipId,
    error(message, error) { console.error(message, error); window.alert(message); },
    async load(username, round, listId) {
      let saved = await getSession(username, listId, round);
      if (!saved) {
        const legacy = await getProgress(username);
        if (legacy?.round === round && legacy.listId === listId) saved = legacy;
      }
      let sourceWordIds = saved?.sourceWordIds;
      if (!sourceWordIds?.length) {
        const selected = listId ? await list(listId) : null;
        sourceWordIds = listId ? (selected?.username === username ? selected.wordIds : [])
          : round === 1 ? await allIds() : (await rawList(username))?.wordIds ?? [];
        if (!saved) {
          if (localStorage.getItem('wuliao:vocabulary:shuffle-screening') === 'true') {
            localStorage.setItem(`wuliao:vocabulary:shuffle-original:${username}:${round}:${listId}`, JSON.stringify(sourceWordIds));
          }
          sourceWordIds = shuffleWords([...sourceWordIds]);
        }
      }
      return { startedAt: Date.now(), ...saved, username, round, listId,
        sessionKey: sessionKey(username, listId, round), sourceWordIds,
        currentIndex: saved?.currentIndex ?? 0, correctIds: saved?.correctIds ?? [], wrongIds: saved?.wrongIds ?? [] };
    },
    async save(session, record, confusion) {
      let completion = {};
      await db.transaction('rw', db.wordRecords, db.confusionPairs, db.screeningSessions,
        db.screeningProgress, db.wordLists, async () => {
          await db.wordRecords.add(record);
          if (confusion) await db.confusionPairs.add(confusion);
          await db.screeningSessions.put(session);
          await db.screeningProgress.put(session);
          if (session.currentIndex >= session.sourceWordIds.length) {
            const familiarName = `熟悉词库_第${session.round}轮`, rawName = `第${session.round}轮词库`;
            if (session.correctIds.length) await makeList(session.username, familiarName, 'familiar', session.round, session.correctIds);
            const rawListId = session.wrongIds.length
              ? await makeList(session.username, rawName, 'raw', session.round, session.wrongIds) : null;
            await removeSession(session.username, session.listId, session.round);
            completion = { familiarName, rawName, rawListId };
          }
        });
      window.VocabularyBridge?.reportSessionUpdated?.();
      return completion;
    },
    async shuffle(username, round, listId) {
      const session = await getSession(username, listId, round);
      if (!session?.sourceWordIds?.length) return;
      const key = `wuliao:vocabulary:shuffle-original:${username}:${round}:${listId}`;
      const keep = Math.min(session.sourceWordIds.length, session.currentIndex + 1);
      const seen = session.sourceWordIds.slice(0, keep), seenSet = new Set(seen);
      let remaining;
      if (localStorage.getItem('wuliao:vocabulary:shuffle-screening') === 'true') {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(session.sourceWordIds));
        remaining = shuffleWords(session.sourceWordIds.slice(keep));
      } else {
        remaining = JSON.parse(localStorage.getItem(key) || JSON.stringify(session.sourceWordIds)).filter((id) => !seenSet.has(id));
      }
      await db.screeningSessions.update(session.sessionKey, { sourceWordIds: seen.concat(remaining) });
    } };
}
