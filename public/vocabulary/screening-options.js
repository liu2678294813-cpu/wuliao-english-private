export function displayMeaning(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/^(?:\s*[A-L][.、．]\s*)+/i, '').replace(/\s+/g, ' ').trim();
}

export function uniqueScreeningOptions(word, pool, { similar = () => false, shuffle = values => [...values].sort(() => Math.random() - 0.5) } = {}) {
  const correct = displayMeaning(word?.chinese);
  if (!word || !correct) throw new Error('当前单词缺少有效释义，暂时无法筛选');
  const used = new Set([correct]);
  const selected = [];
  const candidates = shuffle(pool);
  for (const strict of [true, false]) {
    for (const source of candidates) {
      const chinese = displayMeaning(source.chinese);
      if (!chinese || used.has(chinese) || source.sourceWord === word.english) continue;
      if (strict && (similar(chinese, correct) || selected.some(item => similar(item.chinese, chinese)))) continue;
      used.add(chinese); selected.push({ ...source, chinese });
      if (selected.length === 11) break;
    }
    if (selected.length === 11) break;
  }
  if (selected.length !== 11) throw Object.assign(new Error('有效且不重复的中文释义不足 12 个，请补充词库后重试'), { code: 'insufficient-meanings' });
  const options = shuffle([{ id: `correct_${word.wordId}`, chinese: correct, isCorrect: true, isSkip: false },
    ...selected.map((item, index) => ({ ...item, id: `dist_${word.wordId}_${index}`, isCorrect: false, isSkip: false }))]);
  if (new Set(options.map(item => item.chinese)).size !== 12 || options.filter(item => item.isCorrect).length !== 1) throw new Error('选项校验失败，请重试');
  return options;
}
