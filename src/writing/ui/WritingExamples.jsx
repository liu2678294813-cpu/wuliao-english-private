import { useEffect, useRef, useState } from 'react';
import ModalShell from '../../ui/Overlay.jsx';
import { listExamples, saveExample, deleteExample } from '../writingExamples.js';

export function ExampleSelection({ username, sessionId, materialId, stage, title, children }) {
  const root = useRef(null);
  const [selection, setSelection] = useState(null), [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => {
      const host = root.current;
      if (!host) return;
      const input = document.activeElement;
      let text, start, end, element;
      if (input?.tagName === 'TEXTAREA' && host.contains(input)) {
        start = input.selectionStart; end = input.selectionEnd;
        text = input.value.slice(start, end); element = input;
      } else {
        const selected = window.getSelection();
        if (!selected?.rangeCount || selected.isCollapsed) { setSelection(null); return; }
        const range = selected.getRangeAt(0);
        const nearest = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('[data-example-text]');
        element = nearest(range.startContainer);
        if (!element || !host.contains(element) || nearest(range.endContainer) !== element) { setSelection(null); return; }
        text = selected.toString();
        const prefix = range.cloneRange(); prefix.selectNodeContents(element); prefix.setEnd(range.startContainer, range.startOffset);
        start = prefix.toString().length; end = start + text.length;
      }
      if (!text?.trim()) { setSelection(null); return; }
      const documents = [...host.querySelectorAll('[data-example-text], textarea')];
      const label = element.closest('section')?.querySelector('h2,h3,label > span')?.textContent || '作文文字';
      setSelection({ text, start, end, source: { sessionId, materialId, stage, title: title || '写作训练', label,
        documentId: `${materialId || sessionId}:${element.dataset.exampleSource || `${stage}:${documents.indexOf(element)}`}` } });
      setMessage('');
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('select', update, true);
    return () => { document.removeEventListener('selectionchange', update); document.removeEventListener('select', update, true); };
  }, [username, sessionId, materialId, stage, title]);
  function collect() {
    try {
      const result = saveExample(username, selection);
      setMessage(result.duplicate ? '已收藏过这条例句' : '已收藏到例句');
      setSelection(null);
    } catch (error) { setMessage(error.message); }
  }
  return <div ref={root} className="writing-example-selection">
    {children}
    {(selection || message) && <div className="writing-example-toolbar" role="status">
      {selection ? <><span>已选择 {selection.text.trim().length} 个字符</span><button type="button" className="primary-button" onPointerDown={e => e.preventDefault()} onClick={collect}>收藏到例句</button></> : <span>{message}</span>}
      <button type="button" className="writing-button-ghost" onClick={() => { setSelection(null); setMessage(''); }}>关闭</button>
    </div>}
  </div>;
}

export function ExampleLibrary({ username, services, onOpenSession, onClose }) {
  const [items, setItems] = useState([]), [query, setQuery] = useState(''), [error, setError] = useState('');
  const alive = useRef(true);
  function refresh() { try { setItems(listExamples(username)); } catch (e) { setError(e.message); } }
  useEffect(() => { alive.current = true; refresh(); return () => { alive.current = false; }; }, [username]);
  async function source(item) {
    try {
      if (item.source.materialId) {
        const element = document.querySelector(`[data-example-material="${CSS.escape(item.source.materialId)}"]`);
        if (!element) throw new Error('来源已删除或不可访问；收藏原文仍保留');
        const details = element.querySelector('details'); if (details) details.open = true;
        onClose(); setTimeout(() => element.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0); return;
      }
      const result = await services.readModels.loadWritingWorkspace({ sessionId: item.source.sessionId });
      if (!alive.current) return;
      if (!result?.safeStage || ['not_found', 'damaged', 'source_mismatch', 'account_mismatch', 'repository_error'].includes(result.status)) throw new Error('来源已删除或不可访问；收藏原文仍保留');
      onClose(); onOpenSession?.(item.source.sessionId);
    } catch (e) { if (alive.current) setError(e.message || '来源暂时不可用，收藏原文仍保留'); }
  }
  return <ModalShell open onClose={onClose} className="writing-examples-backdrop" label="例句仓库">
    <section className="writing-example-library">
      <header><div><small>写作收藏</small><h2>例句</h2></div><button type="button" onClick={onClose}>关闭</button></header>
      <input aria-label="搜索例句" placeholder="搜索原文或出处" value={query} onChange={e => setQuery(e.target.value)} />
      <p>{items.length} 条收藏 · 按收藏时间倒序</p>
      {error && <p role="alert">{error}</p>}
      {!items.length && <p>在作文中拖选一句或多句文字，点击“收藏到例句”。</p>}
      {items.filter(item => `${item.text} ${item.source.title} ${item.source.label}`.toLowerCase().includes(query.trim().toLowerCase())).map(item => <article key={item.id}>
        <p className="writing-example-original">{item.text}</p>
        <small>{item.source.title} · {item.source.label} · {new Date(item.createdAt).toLocaleString('zh-CN')}</small>
        <footer>
          <button type="button" onClick={async () => { try { await navigator.clipboard.writeText(item.text); setError('已复制'); } catch { setError('复制失败，请选择上方原文复制'); } }}>复制</button>
          <button type="button" onClick={() => source(item)}>查看来源</button>
          <button type="button" onClick={() => { if (!window.confirm('删除这条收藏？原作文与训练记录会保留。')) return; try { deleteExample(username, item.id); refresh(); } catch (e) { setError(e.message); } }}>删除</button>
        </footer>
      </article>)}
      {items.length > 0 && !items.some(item => `${item.text} ${item.source.title} ${item.source.label}`.toLowerCase().includes(query.trim().toLowerCase())) && <p>没有匹配的例句。</p>}
    </section>
  </ModalShell>;
}
