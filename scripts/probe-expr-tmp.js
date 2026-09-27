(() => {
  if (window.__probe7) return { already: true };
  const P = (window.__probe7 = { cmds: [], t0: performance.now(), ups: [], downs: [] });
  const now = () => performance.now() - P.t0;
  const proto = CanvasRenderingContext2D.prototype;
  const wrap = (name) => { const orig = proto[name]; proto[name] = function (...a) {
    let cls = ""; try { cls = this.canvas?.className?.toString?.().slice(0, 28) || ""; } catch {}
    if (P.cmds.length < 60000) P.cmds.push([Math.round(now()), name, cls]);
    return orig.apply(this, a);
  }; };
  ["moveTo", "lineTo", "quadraticCurveTo", "stroke", "clearRect"].forEach(wrap);
  for (const type of ["pointerup", "pointerdown"]) {
    addEventListener(type, (e) => { if (e.pointerType === "pen") (type === "pointerup" ? P.ups : P.downs).push(Math.round(now())); }, { capture: true });
  }
  return { installed: true, t0: P.t0 };
})()
