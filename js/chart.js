/**
 * 轻量 Canvas 图表（无第三方依赖）
 * 支持：折线/面积图、散点图；自适应容器宽度与 devicePixelRatio；窗口 resize 自动重绘。
 */
(function (g) {
  'use strict';

  const PLOTS = [];   // 已绘制的图表，供 resize 时重绘

  function setup(canvas, height) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || canvas.parentNode.clientWidth || 600;
    const cssH = height || 180;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.height = cssH + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
  }

  const PAD = { l: 46, r: 12, t: 14, b: 26 };

  function niceTicks(min, max, n) {
    const span = (max - min) || 1;
    const step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }

  /**
   * 折线图
   * cfg: { series:[{values,color,fill}], xLabel, formatY, yMin, yMax, height }
   */
  function line(canvas, cfg) {
    const { ctx, w, h } = setup(canvas, cfg.height || 180);
    const series = (cfg.series || []).filter(s => s && s.values && s.values.length);
    if (!series.length) return;

    let lo = cfg.yMin, hi = cfg.yMax;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity, mx = -Infinity;
      series.forEach(s => s.values.forEach(v => { if (v < mn) mn = v; if (v > mx) mx = v; }));
      if (lo === undefined) lo = mn;
      if (hi === undefined) hi = mx;
      if (hi === lo) { hi = lo + 1; }
      const pad = (hi - lo) * 0.08;
      if (cfg.yMin === undefined) lo -= pad;
      if (cfg.yMax === undefined) hi += pad;
    }
    const X = t => PAD.l + t * (w - PAD.l - PAD.r);
    const Y = v => h - PAD.b - (v - lo) / (hi - lo) * (h - PAD.t - PAD.b);
    const fmt = cfg.formatY || (v => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)));

    // 网格与 Y 轴刻度
    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.strokeStyle = '#E8ECF3';
    ctx.fillStyle = '#8B97A8';
    ctx.lineWidth = 1;
    niceTicks(lo, hi, 4).forEach(v => {
      const y = Math.round(Y(v)) + .5;
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(w - PAD.r, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(fmt(v), PAD.l - 7, y);
    });

    // 序列
    series.forEach(s => {
      const n = s.values.length;
      const step = t => X(n > 1 ? t / (n - 1) : 0);
      if (s.fill) {
        ctx.beginPath();
        ctx.moveTo(step(0), Y(s.values[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(step(i), Y(s.values[i]));
        ctx.lineTo(step(n - 1), h - PAD.b);
        ctx.lineTo(step(0), h - PAD.b);
        ctx.closePath();
        ctx.fillStyle = s.fill; ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(step(0), Y(s.values[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(step(i), Y(s.values[i]));
      ctx.strokeStyle = s.color || '#2B5CE6';
      ctx.lineWidth = s.width || 1.6;
      ctx.lineJoin = 'round';
      ctx.stroke();
    });

    // X 轴与说明
    ctx.strokeStyle = '#D6DCE5';
    ctx.beginPath(); ctx.moveTo(PAD.l, h - PAD.b + .5); ctx.lineTo(w - PAD.r, h - PAD.b + .5); ctx.stroke();
    if (cfg.xLabel) {
      ctx.fillStyle = '#8B97A8'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillText(cfg.xLabel, w - PAD.r, h - 6);
    }
    if (cfg.legend) {
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      cfg.legend.forEach((lg, i) => {
        ctx.fillStyle = lg.color;
        ctx.fillRect(PAD.l + i * 110, 4, 10, 3);
        ctx.fillStyle = '#8B97A8';
        ctx.fillText(lg.text, PAD.l + i * 110 + 14, 0);
      });
    }
    remember(canvas, () => line(canvas, cfg));
  }

  /**
   * 散点图
   * cfg: { points:[{x,y,c}], palette:[], height }
   */
  function scatter(canvas, cfg) {
    const { ctx, w, h } = setup(canvas, cfg.height || 240);
    const pts = cfg.points || [];
    if (!pts.length) return;
    const palette = cfg.palette || ['#2B5CE6', '#11B5A4', '#E5484D', '#F2A63B', '#7B5CE6', '#0E9C8E', '#D8383D', '#4A7CFF', '#8A96AD'];

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(p => { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; });
    const sx = (x1 - x0) || 1, sy = (y1 - y0) || 1;
    const X = v => PAD.l + (v - x0) / sx * (w - PAD.l - PAD.r);
    const Y = v => h - PAD.b - (v - y0) / sy * (h - PAD.t - PAD.b);

    ctx.fillStyle = '#F7F9FC';
    ctx.fillRect(PAD.l, PAD.t, w - PAD.l - PAD.r, h - PAD.t - PAD.b);
    const r = Math.max(1.6, Math.min(3.2, 300 / pts.length));
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2);
      ctx.fillStyle = palette[p.c % palette.length];
      ctx.globalAlpha = .78;
      ctx.fill();
    });
    ctx.globalAlpha = 1;
    ctx.font = '11px -apple-system, "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#8B97A8'; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText('PCA 第一主成分 →', w - PAD.r, h - 6);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('↑ 第二主成分', PAD.l + 2, PAD.t + 2);
    remember(canvas, () => scatter(canvas, cfg));
  }

  function remember(canvas, redraw) {
    const old = PLOTS.findIndex(p => p.canvas === canvas);
    if (old >= 0) PLOTS[old] = { canvas, redraw };
    else PLOTS.push({ canvas, redraw });
  }

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      PLOTS.forEach(p => {
        if (!p.canvas.isConnected) return;
        try { p.redraw(); } catch (e) { /* 视图已卸载 */ }
      });
    }, 160);
  });

  /** 视图切换会替换 DOM，清掉失效的图表记录 */
  function clearDead() {
    for (let i = PLOTS.length - 1; i >= 0; i--) {
      if (!PLOTS[i].canvas.isConnected) PLOTS.splice(i, 1);
    }
  }

  g.Chart = { line, scatter, clearDead };
})(window);
