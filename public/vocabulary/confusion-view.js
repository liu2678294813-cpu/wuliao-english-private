import { readConfusions, clearConfusions, restoreConfusions, confusionMatches } from './confusion-records.js';

export function ConfusionView({ React, username }) {
  const h = React.createElement;
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState('');
  const [filter, setFilter] = React.useState('all');
  const [busy, setBusy] = React.useState(false);
  const [revision, refresh] = React.useReducer((v) => v + 1, 0);
  React.useEffect(() => {
    let active = true;
    setResult(null); setError(''); setFilter('all');
    readConfusions(username).then((data) => { if (active) setResult({ ...data, username }); })
      .catch((err) => { if (active) setError(`混淆记录加载失败：${err.message}`); });
    return () => { active = false; };
  }, [username, revision]);
  const rows = result?.username === username ? result.rows : [];
  const selected = rows.filter((row) => confusionMatches(row, filter));
  const rounds = [...new Set(rows.filter((row) => row.source !== 'review' && Number.isFinite(row.round)).map((row) => row.round))].sort((a, b) => b - a);
  const action = async (restore) => {
    if (busy) return;
    if (!restore && !window.confirm(`清除当前筛选的 ${selected.length} 条混淆记录？清除后可恢复上次清除。`)) return;
    setBusy(true); setError('');
    try { await (restore ? restoreConfusions(username) : clearConfusions(username, filter)); refresh(); }
    catch (err) { setError(`保存失败：${err.message}，请重试。`); }
    finally { setBusy(false); }
  };
  const cell = (text) => h('td', null, text || '—');
  return h('section', { className: 'confusion-page', 'aria-label': '混淆词对照库' },
    h('div', { className: 'confusion-heading' }, h('h2', null, '混淆词对照库'),
      h('div', { className: 'confusion-filters' },
        h('select', { 'aria-label': '混淆记录筛选', value: filter, disabled: busy, onChange: (e) => setFilter(e.target.value) },
          h('option', { value: 'all' }, '全部来源 / 全部轮次'), h('option', { value: 'review' }, '今日复习'),
          ...rounds.map((round) => h('option', { key: round, value: String(round) }, `筛查第 ${round} 轮`))),
        result?.canRestore && h('button', { disabled: busy, onClick: () => action(true) }, '恢复上次清除'),
        selected.length > 0 && h('button', { disabled: busy, onClick: () => action(false) }, `清除 ${selected.length} 条`))),
    error && h('div', { className: 'confusion-error', role: 'alert' }, error, h('button', { disabled: busy, onClick: refresh }, '重新加载')),
    !result && !error && h('p', { role: 'status' }, '正在读取混淆记录…'),
    result && h('p', { className: 'confusion-summary' }, `共 ${rows.length} 条，当前显示 ${selected.length} 条。${result.recovered ? `已补回 ${result.recovered} 条有完整快照的记录。` : ''}`),
    result && !selected.length && h('p', null, '暂无混淆记录。筛查或今日复习中选错的单词对会自动记录。'),
    selected.length > 0 && h('div', { className: 'confusion-table-scroll' }, h('table', null,
      h('thead', null, h('tr', null, ...['正确单词', '正确释义', '你选的释义', '混淆单词', '混淆词释义', '来源', '发生时间'].map((label) => h('th', { key: label }, label)))),
      h('tbody', null, ...selected.map((row) => h('tr', { key: row.id ?? row.eventId },
        cell(row.correctEnglish), cell(row.correctChinese), cell(row.wrongChinese), cell(row.sourceWord), cell(row.sourceWordChinese),
        cell(row.source === 'review' ? '今日复习' : Number.isFinite(row.round) ? `筛查第 ${row.round} 轮` : '历史筛查'),
        cell(row.timestamp ? new Date(row.timestamp).toLocaleString('zh-CN', { hour12: false }) : '')))))),
    h('p', { className: 'confusion-history-note' }, '保留已有混淆记录；过去未保存所选单词的复习错误无法准确补录。'));
}
