// Paint opportunity is explicitly a proxy, never a claimed screen presentation.
let inputTime = null;
let sequence = 0;
if (typeof document !== 'undefined') document.addEventListener('click', (event) => { inputTime = event.timeStamp; }, true);
export function interactionTiming(kind) {
  const start = performance.now();
  const metric = { id: ++sequence, kind, inputWaitMs: inputTime > 0 && inputTime <= start ? start - inputTime : null };
  const record = () => {
    if (typeof window === 'undefined') return;
    const timings = window.__wuliaoInteractionTimings ||= [];
    timings.push({ ...metric }); if (timings.length > 256) timings.shift();
  };
  return {
    feedback() {
      metric.computeMs = performance.now() - start;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(() => {
        metric.paintOpportunityMs = performance.now() - start; record();
      }, 0));
    },
    async save(write) {
      const savingAt = performance.now();
      try { const result = await write(); metric.status = 'saved'; return result; }
      catch (error) { metric.status = 'failed'; throw error; }
      finally { metric.saveMs = performance.now() - savingAt; record(); }
    },
  };
}
