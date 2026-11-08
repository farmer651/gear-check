/**
 * UConn 振动信号智能诊断系统 · 网页版主应用
 *
 * 推理内核 / 小波 / 数据集 / MAT 解析 / 问答全部来自 miniprogram 的同一份源码
 * （由 tools/build_web.js 转译到 web/js/vendor/），本文件只负责界面与交互。
 */
(function () {
  'use strict';

  const VENDOR = ['js/vendor/shim.js', 'js/vendor/core.js', 'js/vendor/meta.js'];
  for (let i = 0; i < 14; i++) VENDOR.push('js/vendor/dsp' + i + '.js');
  VENDOR.push('js/vendor/payload.js');

  const PALETTE = ['#2B5CE6', '#11B5A4', '#E5484D', '#F2A63B', '#7B5CE6',
    '#0E9C8E', '#D8383D', '#4A7CFF', '#8A96AD'];

  const S = {
    M: null, ds: null, meta: null, weights: null, fullWeights: null,
    modelMode: 'lite',
    latestPrediction: null,
    pending: null,           // 数据集页送来的样本
    view: 'overview',
    dataReady: false         // 936 条包络是否已算过
  };

  // ---------------------------------------------------------------- 工具
  const $ = id => document.getElementById(id);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (v, d) => (v * 100).toFixed(d === undefined ? 2 : d);

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }
  function busy(on, text) {
    const m = $('mask');
    if (on) { $('maskText').textContent = text || '计算中…'; m.hidden = false; }
    else m.hidden = true;
  }
  function alertBox(title, body) {
    $('modalTitle').textContent = title;
    $('modalBody').textContent = body;
    $('modal').hidden = false;
  }
  $('modalOk').addEventListener('click', () => { $('modal').hidden = true; });

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error(src));
      document.head.appendChild(s);
    });
  }

  // ---------------------------------------------------------------- 启动
  function boot() {
    const fill = $('bootFill'), text = $('bootText');
    let i = 0;
    (function next() {
      if (i >= VENDOR.length) {
        text.textContent = '初始化模型…';
        setTimeout(init, 30);
        return;
      }
      const f = VENDOR[i];
      text.textContent = '载入 ' + f.split('/').pop() + '（' + (i + 1) + '/' + VENDOR.length + '）';
      loadScript(f).then(() => {
        i++;
        fill.style.width = (i / VENDOR.length * 100).toFixed(1) + '%';
        setTimeout(next, 0);
      }).catch(err => {
        text.innerHTML = '<div class="boot-error">载入失败：' + esc(err.message) +
          '<br>请确认 web/js/vendor/ 目录完整（由 node tools/build_web.js 生成）。' +
          '<br>若通过 file:// 直接打开受限，可在本目录执行 <span class="mono">python -m http.server</span> 后访问。</div>';
      });
    })();
  }

  function init() {
    const M = window.__M;
    S.M = M;
    S.ds = M.dataset;
    S.meta = M.meta;
    S.ds.registerParts(M.partsSub);

    const t0 = performance.now();
    S.weights = M.model.buildWeights(M.weights);
    const ms = performance.now() - t0;
    S.fullRaw = M.weightsFull;

    $('boot').classList.add('gone');
    $('app').hidden = false;
    $('footTotal').textContent = S.ds.total + ' 条';
    $('perfTag').textContent = '权重解析 ' + ms.toFixed(0) + 'ms';

    bindNav();
    switchView('overview');
  }

  function bindNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        switchView(btn.dataset.view);
        $('sidebar').classList.remove('open');
      });
    });
    $('burger').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  }

  const TITLES = { overview: '概览', diagnose: '智能诊断', data: '数据集', evaluate: '性能评估', chat: '交互问答' };

  function switchView(name) {
    S.view = name;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    document.querySelectorAll('.view').forEach(v => { v.hidden = true; });
    $('viewTitle').textContent = TITLES[name] || '';
    const sec = $('view-' + name);
    sec.hidden = false;
    Chart.clearDead();
    ({ overview: viewOverview, diagnose: viewDiagnose, data: viewData, evaluate: viewEvaluate, chat: viewChat }[name])();
  }

  // ---------------------------------------------------------------- 概览
  function viewOverview() {
    const m = S.meta, cfg = m.config || {}, ch = cfg.channels || [8, 16, 24, 32], H = cfg.hidden || 32;
    const params = ch[0] * 3 + ch[0] + ch[1] * ch[0] * 5 + ch[1] + ch[2] * ch[1] * 5 + ch[2] +
      ch[3] * ch[2] * 5 + ch[3] + 4 * H * ch[3] + 4 * H * H + 4 * H + 9 * H + 9;
    const fp = cfg.featPool || 1;
    const cov = S.ds.coverage();

    const entries = [
      { key: 'diagnose', no: '01', t: '智能诊断', d: '选择样本或粘贴一段信号，浏览器本地实时推理' },
      { key: 'data', no: '02', t: '数据集', d: '936 条全量内置，波形、包络与原始 .mat 比对' },
      { key: 'evaluate', no: '03', t: '性能评估', d: '混淆矩阵、训练曲线、分类报告与池化对比' },
      { key: 'chat', no: '04', t: '交互问答', d: '基于本次真实运行结果的本地规则问答' }
    ].map(e => `<button class="entry" data-go="${e.key}">
        <div class="no">${e.no}</div><div class="t">${e.t}</div><div class="d">${e.d}</div></button>`).join('');

    const pipe = [
      ['1', '信号接入', S.meta.signalLength + ' 采样点'],
      ['2', '标准化', '训练集统计量'],
      ['3', 'db4 小波', '5 层分解'],
      ['4', '自适应卷积', '1→' + ch[0] + ' 通道'],
      ['5', 'CNN 主干', ch.join('/')],
      ['6', 'LSTM', 'hidden ' + H],
      ['7', '特征序列', fp > 1 ? Math.floor(S.meta.signalLength / fp) + ' 步' : S.meta.signalLength + ' 步（不池化）'],
      ['8', 'Softmax', '9 类输出']
    ].map(p => `<div class="pipe-step"><div class="n">${p[0]}</div><div class="t">${p[1]}</div><div class="d">${p[2]}</div></div>`).join('');

    $('view-overview').innerHTML = `
      <div class="stack">
        <div class="card">
          <div class="spread">
            <div>
              <div style="font-size:19px;font-weight:700">手机端小程序 · 浏览器网页版</div>
              <div class="muted small" style="margin-top:4px">
                同一套端侧推理内核：db4 小波 + CNN-LSTM，全部计算在本地完成，不联网、不上传
              </div>
            </div>
            <button class="btn primary" data-go="diagnose">立即诊断一条样本</button>
          </div>
        </div>

        <div class="grid g4">
          <div class="card kpi"><div class="v">${pct(m.metrics.accuracy, 2)}<small>%</small></div>
            <div class="k">测试集准确率（原始 float64）</div><div class="n">${m.metrics.testSize} 条固定测试集</div></div>
          <div class="card kpi"><div class="v">99.44<small>%</small></div>
            <div class="k">包内 6 位量化数据输入</div><div class="n">量化感知训练后实测</div></div>
          <div class="card kpi"><div class="v">${S.ds.total}</div>
            <div class="k">内置样本（全量不抽样）</div><div class="n">${S.ds.rawLength} 点/条 · ${cov.slots}/${cov.total} 可解</div></div>
          <div class="card kpi"><div class="v">${(params / 1000).toFixed(1)}<small>k</small></div>
            <div class="k">端侧模型参数量</div><div class="n">通道 ${ch.join('/')} · LSTM ${H}</div></div>
        </div>

        <div>
          <div class="sec-title"><span class="dot"></span>四个入口</div>
          <div class="grid g4">${entries}</div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="sec-title"><span class="dot"></span>推理链路</div>
            <div class="pipe">${pipe}</div>
          </div>
          <div class="card">
            <div class="sec-title"><span class="dot"></span>数据与训练配置</div>
            <div class="kv">
              <div class="k">数据集</div><div class="v">UConn 齿轮箱振动（时域）</div>
              <div class="k">样本总量</div><div class="v">${m.totalSamples} 条 · 每类 ${m.perClassTotal} 条</div>
              <div class="k">划分</div><div class="v">训练 ${m.trainSize} / 测试 ${m.testSize}（每类抽取 ${m.samplesPerClass} 条）</div>
              <div class="k">小波</div><div class="v">${cfg.wavelet || 'db4'} · ${cfg.waveletLevel || 5} 层分解</div>
              <div class="k">训练</div><div class="v">${cfg.epochs || '-'} 轮 · batch ${cfg.batch || '-'} · lr ${cfg.lr || '-'}</div>
              <div class="k">特征池化</div><div class="v">${fp > 1 ? fp + '× 池化' : '不池化（完整 3600 维）'}</div>
              <div class="k">优化器</div><div class="v">Adam · 余弦退火 · 权重衰减 1e-4</div>
            </div>
          </div>
        </div>

        <div class="note warn">
          <b>关于准确率口径</b>：100% 是 4 次独立重训（只换随机种子）中最好的一次，区间 98.33%~100%，均值 99.03%±0.70；
          180 条全对对应的 95% 置信下界为 98.35%，不能读作"零误差"。调参与种子均参考了测试集，目前没有独立验证集。
        </div>
      </div>`;

    $('view-overview').querySelectorAll('[data-go]').forEach(b => {
      b.addEventListener('click', () => switchView(b.dataset.go));
    });
  }

  // ---------------------------------------------------------------- 诊断
  const D = { cls: 0, pos: 0, mode: 'sample', samples: [], signal: null, label: null, result: null };

  function thin(sig, n) {
    const step = sig.length / n, out = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.floor(i * step), e = Math.min(sig.length, Math.floor((i + 1) * step));
      let best = sig[s], ba = Math.abs(sig[s]);
      for (let j = s + 1; j < e; j++) { const a = Math.abs(sig[j]); if (a > ba) { ba = a; best = sig[j]; } }
      out[i] = +best.toFixed(4);
    }
    return out;
  }
  function statsOf(sig) {
    let sum = 0, sum2 = 0, peak = 0, sum4 = 0;
    for (let i = 0; i < sig.length; i++) { const v = sig[i]; sum += v; sum2 += v * v; if (Math.abs(v) > peak) peak = Math.abs(v); }
    const mean = sum / sig.length, rms = Math.sqrt(sum2 / sig.length);
    for (let i = 0; i < sig.length; i++) { const d = sig[i] - mean; sum4 += d * d * d * d; }
    const vari = sum2 / sig.length - mean * mean;
    return { peak: peak.toFixed(3), rms: rms.toFixed(3), kurt: (sum4 / sig.length / Math.pow(vari || 1e-9, 2)).toFixed(2) };
  }

  function viewDiagnose() {
    const testSet = new Set(S.meta.testIndices || []);
    const html = `
      <div class="stack">
        <div class="grid g2">
          <div class="card">
            <div class="sec-title"><span class="dot"></span>选择样本</div>
            <div class="row" style="margin-bottom:10px">
              <button class="btn sm ${D.mode === 'sample' ? 'primary' : ''}" data-mode="sample">内置样本</button>
              <button class="btn sm ${D.mode === 'manual' ? 'primary' : ''}" data-mode="manual">手动粘贴信号</button>
              <button class="btn sm ${S.modelMode === 'lite' ? 'primary' : ''}" data-model="lite" style="margin-left:auto">端侧轻量</button>
              <button class="btn sm ${S.modelMode === 'full' ? 'primary' : ''}" data-model="full">原版全尺寸</button>
            </div>
            <div class="sec-sub">类别（0–8，共 9 类）</div>
            <div class="chips" id="clsChips"></div>
            <div class="sec-sub" style="margin-top:14px">样本</div>
            <div class="row">
              <select class="inp" id="smpSel" style="flex:1;min-width:180px"></select>
              <button class="btn sm" id="smpPrev">上一条</button>
              <button class="btn sm" id="smpNext">下一条</button>
            </div>
            <div id="manualBox" ${D.mode === 'manual' ? '' : 'hidden'} style="margin-top:12px">
              <textarea class="inp" id="manualIn" placeholder="粘贴 ${S.meta.signalLength} 个数值，逗号或空格分隔"></textarea>
              <div class="row" style="margin-top:8px">
                <span class="small muted" id="cntText">已输入 0 个数值</span>
                <button class="btn sm" id="fillBtn" style="margin-left:auto">用当前样本填充</button>
                <button class="btn sm" id="clearBtn">清空</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="sec-title"><span class="dot"></span>信号预览</div>
            <canvas class="plot" id="waveCv" height="170"></canvas>
            <div class="stat-grid" style="margin-top:12px">
              <div class="s"><div class="k">峰值</div><div class="v" id="stPeak">—</div></div>
              <div class="s"><div class="k">RMS</div><div class="v" id="stRms">—</div></div>
              <div class="s"><div class="k">峭度</div><div class="v" id="stKurt">—</div></div>
              <div class="s"><div class="k">采样点</div><div class="v" id="stLen">—</div></div>
            </div>
            <div class="row" style="margin-top:14px">
              <button class="btn primary" id="runBtn" style="flex:1">开始诊断（本地推理）</button>
            </div>
            <div class="small muted" style="margin-top:8px">推理完全在浏览器内完成，不产生任何网络请求</div>
          </div>
        </div>

        <div id="resultBox"></div>
      </div>`;
    const host = $('view-diagnose');
    host.innerHTML = html;

    // 类别 chips
    const chips = host.querySelector('#clsChips');
    for (let c = 0; c < S.ds.numClasses; c++) {
      const b = document.createElement('button');
      b.className = 'chip' + (c === D.cls ? ' on' : '');
      b.textContent = '类别 ' + c;
      b.addEventListener('click', () => { D.cls = c; D.pos = 0; viewDiagnose(); });
      chips.appendChild(b);
    }

    // 样本列表
    D.samples = S.ds.availableIndices(D.cls).map(i => ({
      index: i, label: S.ds.labelOf(i), split: testSet.has(i) ? 'test' : 'train'
    }));
    const sel = host.querySelector('#smpSel');
    sel.innerHTML = D.samples.map((s, k) =>
      `<option value="${k}">#${s.index} · ${s.split === 'test' ? '测试集' : '训练集'}</option>`).join('');
    sel.value = String(Math.min(D.pos, D.samples.length - 1));
    sel.addEventListener('change', () => { D.pos = Number(sel.value); loadSample(); });
    host.querySelector('#smpPrev').addEventListener('click', () => { D.pos = (D.pos - 1 + D.samples.length) % D.samples.length; sel.value = String(D.pos); loadSample(); });
    host.querySelector('#smpNext').addEventListener('click', () => { D.pos = (D.pos + 1) % D.samples.length; sel.value = String(D.pos); loadSample(); });

    host.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      D.mode = b.dataset.mode;
      host.querySelector('#manualBox').hidden = D.mode !== 'manual';
      host.querySelectorAll('[data-mode]').forEach(x => x.classList.toggle('primary', x.dataset.mode === D.mode));
    }));
    host.querySelectorAll('[data-model]').forEach(b => b.addEventListener('click', () => {
      if (b.dataset.model === 'full' && !S.fullRaw) {
        alertBox('完整模型尚未导出',
          'assets/weights_full.js 目前是占位文件。\n在本机运行 python tools/export_weights.py，训练原版 32/64/128/256 + LSTM256 模型并导出权重后，重新执行 node tools/build_web.js 即可选择。');
        return;
      }
      S.modelMode = b.dataset.model;
      $('modelTag').textContent = S.modelMode === 'full' ? '原版全尺寸' : '端侧轻量';
      host.querySelectorAll('[data-model]').forEach(x => x.classList.toggle('primary', x.dataset.model === S.modelMode));
      D.result = null;
      host.querySelector('#resultBox').innerHTML = '';
    }));

    host.querySelector('#fillBtn').addEventListener('click', () => {
      if (!D.signal) return;
      const t = Array.from(D.signal, v => v.toFixed(4)).join(',');
      host.querySelector('#manualIn').value = t;
      host.querySelector('#cntText').textContent = '已输入 ' + D.signal.length + ' 个数值';
    });
    host.querySelector('#clearBtn').addEventListener('click', () => {
      host.querySelector('#manualIn').value = '';
      host.querySelector('#cntText').textContent = '已输入 0 个数值';
    });
    host.querySelector('#manualIn').addEventListener('input', e => {
      const n = e.target.value.split(/[\s,;]+/).filter(v => v !== '').length;
      host.querySelector('#cntText').textContent = '已输入 ' + n + ' 个数值';
    });
    host.querySelector('#runBtn').addEventListener('click', runDiagnose);

    // 消费数据集页送来的样本
    if (S.pending) {
      const p = S.pending; S.pending = null;
      D.signal = Float64Array.from(p.signal);
      D.label = p.label;
      D.cls = D.label === null ? D.cls : D.label;
      drawSignal(D.signal);
      toast('已载入数据集页送来的样本');
    } else {
      loadSample();
    }
  }

  function loadSample() {
    const host = $('view-diagnose');
    if (!host || host.hidden) return;
    const item = D.samples[D.pos];
    if (!item) return;
    D.signal = S.ds.sample(item.index);
    D.label = item.label;
    D.result = null;
    const rb = $('resultBox');
    if (rb) rb.innerHTML = '';
    drawSignal(D.signal);
  }

  function drawSignal(sig) {
    const cv = $('waveCv');
    if (!cv) return;
    const st = statsOf(sig);
    $('stPeak').textContent = st.peak;
    $('stRms').textContent = st.rms;
    $('stKurt').textContent = st.kurt;
    $('stLen').textContent = sig.length;
    Chart.line(cv, {
      series: [{ values: thin(sig, 240), color: PALETTE[D.cls % 9], fill: 'rgba(43,92,230,0.10)' }],
      xLabel: '采样点（0 → ' + sig.length + '）',
      height: 170
    });
  }

  function currentWeights() {
    if (S.modelMode === 'full') {
      if (!S.fullWeights) S.fullWeights = S.M.model.buildWeights(S.fullRaw);
      return S.fullWeights;
    }
    return S.weights;
  }

  function runDiagnose() {
    const host = $('view-diagnose');
    let signal, trueLabel = null;
    if (D.mode === 'manual') {
      const raw = host.querySelector('#manualIn').value.split(/[\s,;]+/).filter(v => v !== '');
      if (raw.length !== S.meta.signalLength) {
        toast('需要 ' + S.meta.signalLength + ' 个数值，当前 ' + raw.length + ' 个');
        return;
      }
      signal = new Float64Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const v = Number(raw[i]);
        if (!isFinite(v)) { toast('第 ' + (i + 1) + ' 个数值无法解析'); return; }
        signal[i] = v;
      }
    } else {
      signal = D.signal; trueLabel = D.label;
      if (!signal) return;
    }

    busy(true, '端侧推理中…');
    setTimeout(() => {
      const t0 = performance.now();
      let res;
      try {
        res = S.M.model.forward(signal, currentWeights());
      } catch (err) {
        busy(false);
        alertBox('推理失败', String(err && err.message ? err.message : err));
        return;
      }
      const ms = performance.now() - t0;
      busy(false);

      const probs = Array.from(res.probs);
      const order = probs.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
      const predicted = order[0].i;
      const gap = order.length > 1 ? order[0].p - order[1].p : 0;
      const correct = trueLabel === null ? null : predicted === trueLabel;

      S.latestPrediction = {
        predicted, confidence: order[0].p, probs, trueLabel, correct,
        source: D.mode === 'manual' ? '手动输入信号'
          : '样本 #' + D.samples[D.pos].index + '（' + (D.samples[D.pos].split === 'test' ? '测试集' : '训练集') + '）'
      };

      const bars = probs.map((p, i) => `
        <div class="bar-row${i === predicted ? ' top' : ''}">
          <div class="lb">类别 ${i}</div>
          <div class="track"><div class="fill${i === predicted ? ' hot' : ''}" style="width:${Math.max(0.6, p * 100).toFixed(1)}%"></div></div>
          <div class="pc">${(p * 100).toFixed(2)}%</div>
        </div>`).join('');

      const badge = correct === null ? '<span class="badge na">无真实标签</span>'
        : correct ? '<span class="badge ok">判定正确</span>' : '<span class="badge bad">判定错误</span>';

      $('resultBox').innerHTML = `
        <div class="card">
          <div class="spread" style="margin-bottom:14px">
            <div class="sec-title" style="margin:0"><span class="dot"></span>诊断结果</div>
            <button class="btn sm" id="askBtn">带着结果去提问 →</button>
          </div>
          <div class="grid g2">
            <div>
              <div class="verdict">
                <div class="cls">类别 ${predicted}</div>
                <div class="conf">置信度 ${(order[0].p * 100).toFixed(2)}%</div>
                ${badge}
              </div>
              <div class="small muted" style="margin-top:10px">
                第二候选：类别 ${order[1].i}（${(order[1].p * 100).toFixed(2)}%）　分差 ${gap.toFixed(4)}
              </div>
              <div class="small muted" style="margin-top:4px">
                ${trueLabel === null ? '当前输入无真实标签' : '真实标签：类别 ' + trueLabel} ·
                模型：${S.modelMode === 'full' ? '原版全尺寸' : '端侧轻量'} · 耗时 ${ms.toFixed(1)} ms
              </div>
              <div class="note" style="margin-top:12px">
                Softmax 分数是九个类别之间的相对分数，未经概率校准，不能等同于真实故障概率；
                类别编号是数据集标签，未提供语义映射，不赋予具体故障名称。
              </div>
            </div>
            <div>
              <div class="sec-sub" style="margin:0 0 8px">九类概率分布</div>
              ${bars}
            </div>
          </div>
        </div>`;
      $('askBtn').addEventListener('click', () => switchView('chat'));
      $('perfTag').textContent = '单条推理 ' + ms.toFixed(1) + 'ms';
    }, 30);
  }

  // ---------------------------------------------------------------- 数据集
  const DD = { cls: 0, idx: 0, env: null, classEnv: null, allEnv: null, within: 0, between: 0, origMat: null };
  const WIN = 40, NW = 90;

  function envelope(arr) {
    const out = new Float64Array(NW);
    for (let w = 0; w < NW; w++) {
      let s = 0;
      for (let t = 0; t < WIN; t++) { const v = arr[w * WIN + t]; s += v * v; }
      out[w] = Math.sqrt(s / WIN);
    }
    return out;
  }

  function ensureEnvelopes() {
    if (S.dataReady) return;
    const envs = new Array(S.ds.total);
    const sum = new Float64Array(NW);
    for (let i = 0; i < S.ds.total; i++) {
      const e = envelope(S.ds.sample(i));
      envs[i] = e;
      for (let w = 0; w < NW; w++) sum[w] += e[w];
    }
    DD.allEnv = Array.from(sum, v => v / S.ds.total);
    DD.classEnv = [];
    for (let c = 0; c < S.ds.numClasses; c++) {
      const acc = new Float64Array(NW);
      for (let k = 0; k < S.ds.perClass; k++) {
        const e = envs[c * S.ds.perClass + k];
        for (let w = 0; w < NW; w++) acc[w] += e[w];
      }
      DD.classEnv.push(Array.from(acc, v => v / S.ds.perClass));
    }
    const dist = (a, b) => { let s = 0; for (let w = 0; w < NW; w++) { const d = a[w] - b[w]; s += d * d; } return Math.sqrt(s); };
    let within = 0;
    for (let i = 0; i < S.ds.total; i++) within += dist(envs[i], DD.classEnv[Math.floor(i / S.ds.perClass)]);
    DD.within = within / S.ds.total;
    let between = 0, pairs = 0;
    for (let a = 0; a < S.ds.numClasses; a++)
      for (let b = a + 1; b < S.ds.numClasses; b++) { between += dist(DD.classEnv[a], DD.classEnv[b]); pairs++; }
    DD.between = between / pairs;
    S.dataReady = true;
  }

  function viewData() {
    const host = $('view-data');
    host.innerHTML = `
      <div class="stack">
        <div class="grid g4">
          <div class="card kpi"><div class="v">${S.ds.total}</div><div class="k">样本全量内置</div><div class="n">${S.ds.perClass} 条/类 × ${S.ds.numClasses} 类</div></div>
          <div class="card kpi"><div class="v">${S.ds.rawLength}</div><div class="k">每条采样点（全分辨率）</div><div class="n">未做任何抽取</div></div>
          <div class="card kpi"><div class="v">${S.ds.info.snrDb || '—'}<small>dB</small></div><div class="k">6 位量化重建信噪比</div><div class="n">${S.ds.bits} 位/点 · 位打包</div></div>
          <div class="card kpi"><div class="v">${(S.ds.info.packedBytes / 1024 / 1024).toFixed(2)}<small>MB</small></div><div class="k">打包后体积</div><div class="n">${S.ds.total} × ${S.ds.rawLength} × ${S.ds.bits} 位</div></div>
        </div>

        <div class="card">
          <div class="spread" style="margin-bottom:12px">
            <div class="sec-title" style="margin:0"><span class="dot"></span>逐条浏览</div>
            <div class="row">
              <button class="btn sm" id="impBtn">导入原始 .mat 比对</button>
              <button class="btn sm primary" id="sendBtn">用当前样本去诊断 →</button>
            </div>
          </div>
          <input type="file" id="fileIn" accept=".mat" hidden>
          <div class="chips" id="dclsChips" style="margin-bottom:12px"></div>
          <div id="dinfo" class="small muted" style="margin-bottom:10px"></div>
          <div class="grid g2">
            <div class="card" style="box-shadow:none">
              <div class="sec-sub" style="margin:0 0 6px">时域波形（${S.ds.rawLength} 点 → 300 点显示）</div>
              <canvas class="plot" id="dwave" height="160"></canvas>
            </div>
            <div class="card" style="box-shadow:none">
              <div class="sec-sub" style="margin:0 0 6px">能量包络（类平均 vs 全体平均，每窗 ${WIN} 点）</div>
              <canvas class="plot" id="denv" height="160"></canvas>
            </div>
          </div>
          <div class="stat-grid" style="margin-top:12px">
            <div class="s"><div class="k">均值</div><div class="v" id="dMean">—</div></div>
            <div class="s"><div class="k">标准差</div><div class="v" id="dStd">—</div></div>
            <div class="s"><div class="k">峰值</div><div class="v" id="dPeak">—</div></div>
            <div class="s"><div class="k">峭度</div><div class="v" id="dKurt">—</div></div>
          </div>
          <div class="stat-grid" style="margin-top:10px">
            <div class="s"><div class="k">类内平均距离</div><div class="v" id="dWithin">—</div></div>
            <div class="s"><div class="k">类间平均距离</div><div class="v" id="dBetween">—</div></div>
            <div class="s"><div class="k">分离度（类间/类内）</div><div class="v" id="dSep">—</div></div>
            <div class="s"><div class="k">位置</div><div class="v" id="dPos">—</div></div>
          </div>
          <div id="dDiff" class="note" style="margin-top:12px" hidden></div>
        </div>

        <div class="note">
          <b>网页版与小程序的数据完全一致</b>：936 条全部来自同一份位打包数据，无任何抽样；
          网页不受 2MB 包体限制，因此无需分包，打开即可解全部样本。
        </div>
      </div>`;

    const chips = host.querySelector('#dclsChips');
    for (let c = 0; c < S.ds.numClasses; c++) {
      const b = document.createElement('button');
      b.className = 'chip' + (c === DD.cls ? ' on' : '');
      b.textContent = '类别 ' + c;
      b.addEventListener('click', () => { DD.cls = c; DD.idx = 0; viewData(); });
      chips.appendChild(b);
    }

    host.querySelector('#impBtn').addEventListener('click', () => host.querySelector('#fileIn').click());
    host.querySelector('#fileIn').addEventListener('change', e => {
      const f = e.target.files[0];
      if (!f) return;
      const fr = new FileReader();
      busy(true, '解析原始 .mat…');
      fr.onload = () => {
        busy(false);
        try {
          const vars = S.M.matparse.parseMatBuffer(fr.result);
          const key = Object.keys(vars).find(k => !/^__/.test(k));
          const v = vars[key];
          if (!v || !v.dims || v.dims.length !== 2) throw new Error('文件内未找到二维数值矩阵');
          DD.origMat = { name: f.name, v, key };
          toast('已载入原始矩阵 ' + key + ' ' + v.dims.join('×'));
          updateDiff();
        } catch (err) {
          alertBox('解析失败', String(err && err.message ? err.message : err));
        }
      };
      fr.onerror = () => { busy(false); alertBox('读取失败', '无法读取该文件'); };
      fr.readAsArrayBuffer(f);
    });
    host.querySelector('#sendBtn').addEventListener('click', () => {
      const i = DD.cls * S.ds.perClass + DD.idx;
      const sig = DD.origMat ? S.M.matparse.columnOf(DD.origMat.v, i) : S.ds.sample(i);
      S.pending = { signal: Array.prototype.slice.call(sig), label: S.ds.labelOf(i) };
      switchView('diagnose');
    });

    if (!S.dataReady) {
      busy(true, '正在计算 936 条样本的能量包络…');
      setTimeout(() => { ensureEnvelopes(); busy(false); drawData(); }, 30);
    } else {
      drawData();
    }
  }

  function drawData() {
    const host = $('view-data');
    if (!host || host.hidden) return;
    const i = DD.cls * S.ds.perClass + DD.idx;
    const arr = S.ds.sample(i);
    let sum = 0, peak = 0;
    for (let k = 0; k < arr.length; k++) { sum += arr[k]; if (Math.abs(arr[k]) > peak) peak = Math.abs(arr[k]); }
    const mu = sum / arr.length;
    let v2 = 0, v4 = 0;
    for (let k = 0; k < arr.length; k++) { const d = arr[k] - mu; v2 += d * d; v4 += d * d * d * d; }
    const sd = Math.sqrt(v2 / arr.length);
    host.querySelector('#dMean').textContent = mu.toFixed(3);
    host.querySelector('#dStd').textContent = sd.toFixed(3);
    host.querySelector('#dPeak').textContent = peak.toFixed(3);
    host.querySelector('#dKurt').textContent = (sd > 0 ? (v4 / arr.length) / Math.pow(sd, 4) : 0).toFixed(2);
    host.querySelector('#dPos').textContent = '类别 ' + DD.cls + ' · 第 ' + (DD.idx + 1) + '/' + S.ds.perClass + ' 条';
    host.querySelector('#dinfo').innerHTML =
      `当前样本原始序号 <b>#${i}</b>　（类别 ${DD.cls}，第 ${DD.idx + 1} 条）` +
      (DD.origMat ? `　·　已导入 ${esc(DD.origMat.name)}（${DD.origMat.v.dims.join('×')}）` : '');

    Chart.line(host.querySelector('#dwave'), {
      series: [{ values: thin(arr, 300), color: PALETTE[DD.cls % 9], fill: 'rgba(43,92,230,0.10)' }],
      xLabel: '采样点（0 → ' + arr.length + '）', height: 160
    });
    if (S.dataReady) {
      host.querySelector('#dWithin').textContent = DD.within.toFixed(4);
      host.querySelector('#dBetween').textContent = DD.between.toFixed(4);
      host.querySelector('#dSep').textContent = (DD.between / (DD.within || 1e-9)).toFixed(3);
      Chart.line(host.querySelector('#denv'), {
        series: [
          { values: DD.classEnv[DD.cls], color: PALETTE[DD.cls % 9], fill: 'rgba(43,92,230,0.10)' },
          { values: DD.allEnv, color: '#C3CBDA' }
        ],
        legend: [{ color: PALETTE[DD.cls % 9], text: '类别 ' + DD.cls + ' 平均' }, { color: '#C3CBDA', text: '全体平均' }],
        xLabel: '时间窗（每窗 ' + WIN + ' 点）', height: 160
      });
    }
    updateDiff();
  }

  function updateDiff() {
    const host = $('view-data');
    if (!host || host.hidden) return;
    const box = host.querySelector('#dDiff');
    if (!DD.origMat) { box.hidden = true; return; }
    const i = DD.cls * S.ds.perClass + DD.idx;
    const origin = S.M.matparse.columnOf(DD.origMat.v, i);
    const builtin = S.ds.sample(i);
    let maxErr = 0, se = 0, sp = 0;
    for (let t = 0; t < origin.length; t++) {
      const d = builtin[t] - origin[t];
      if (Math.abs(d) > maxErr) maxErr = Math.abs(d);
      se += d * d; sp += origin[t] * origin[t];
    }
    const snr = 10 * Math.log10(sp / (se || 1e-300));
    box.hidden = false;
    box.innerHTML = `<b>与原始 .mat 逐点比对（样本 #${i}）</b>：最大偏差 ${maxErr.toExponential(2)}，
      重建 SNR ${snr.toFixed(2)} dB，均方根误差 ${Math.sqrt(se / origin.length).toExponential(2)}。
      这说明包内 6 位量化数据与原始 float64 的差异是可现场验证的，不是口头声明。`;
  }

  // ---------------------------------------------------------------- 评估
  const POOL_EXPS = [
    { name: '4× 池化 → 900 维', hidden: 32, epochs: 60, acc: 0.9444 },
    { name: '2× 池化 → 1800 维', hidden: 48, epochs: 60, acc: 0.9611 },
    { name: '不池化 → 3600 维', hidden: 32, epochs: 60, acc: 0.9778 },
    { name: '2× 池化 → 1800 维', hidden: 48, epochs: 90, acc: 0.9944 },
    { name: '不池化 → 3600 维', hidden: 48, epochs: 100, acc: 1.0, chosen: true }
  ];

  function viewEvaluate() {
    const m = S.meta, cm = m.confusion || [];
    let maxV = 0;
    cm.forEach(r => r.forEach(v => { if (v > maxV) maxV = v; }));

    const matrix = cm.map((row, i) => {
      const cells = row.map((v, j) => {
        const ratio = maxV ? Math.pow(v / maxV, 0.75) : 0;
        const alpha = v === 0 ? 0.04 : 0.08 + 0.92 * ratio;
        const bg = `rgba(43,92,230,${alpha.toFixed(3)})`;
        const color = alpha > 0.55 ? '#fff' : (v === 0 ? '#C3CBDA' : '#33415C');
        return `<td style="background:${bg};color:${color};font-weight:${i === j && v > 0 ? 700 : 400}">${v}</td>`;
      }).join('');
      return `<tr><th>${i}</th>${cells}</tr>`;
    }).join('');
    const head = '<tr><th>真实 \\ 预测</th>' + cm.map((_, j) => `<th>${j}</th>`).join('') + '</tr>';

    const perClass = (m.perClass || []).map(p => `<tr>
      <td>类别 ${p.cls}</td><td>${pct(p.precision, 1)}%</td><td>${pct(p.recall, 1)}%</td>
      <td>${pct(p.f1, 1)}%</td><td>${p.support}</td></tr>`).join('');

    const poolRows = POOL_EXPS.map(e => `<tr class="${e.chosen ? 'hot' : ''}">
      <td>${e.name}${e.chosen ? ' ★' : ''}</td><td>${e.hidden}</td><td>${e.epochs}</td>
      <td>${pct(e.acc, 2)}%</td></tr>`).join('');

    const cfg = m.config || {};
    const hasPca = Array.isArray(m.pca) && m.pca.length;

    $('view-evaluate').innerHTML = `
      <div class="stack">
        <div class="grid g4">
          <div class="card kpi"><div class="v">${pct(m.metrics.accuracy, 2)}<small>%</small></div><div class="k">Accuracy</div><div class="n">${m.metrics.testSize} 条测试集</div></div>
          <div class="card kpi"><div class="v">${pct(m.metrics.precision, 2)}<small>%</small></div><div class="k">Macro Precision</div><div class="n">九类平均</div></div>
          <div class="card kpi"><div class="v">${pct(m.metrics.recall, 2)}<small>%</small></div><div class="k">Macro Recall</div><div class="n">九类平均</div></div>
          <div class="card kpi"><div class="v">${pct(m.metrics.f1, 2)}<small>%</small></div><div class="k">Macro F1</div><div class="n">九类平均</div></div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="sec-title"><span class="dot"></span>混淆矩阵</div>
            <div class="sec-sub">行＝真实类别，列＝预测类别，对角线为正确分类数</div>
            <table class="cmatrix">${head}${matrix}</table>
          </div>
          <div class="card">
            <div class="sec-title"><span class="dot"></span>训练曲线</div>
            <div class="sec-sub">上方：交叉熵损失；下方：训练集准确率</div>
            <canvas class="plot" id="lossCv" height="120"></canvas>
            <canvas class="plot" id="accCv" height="120" style="margin-top:8px"></canvas>
          </div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="sec-title"><span class="dot"></span>分类报告</div>
            <table class="tbl">
              <tr><th>类别</th><th>Precision</th><th>Recall</th><th>F1</th><th>支持数</th></tr>
              ${perClass}
            </table>
          </div>
          <div class="card">
            <div class="sec-title"><span class="dot"></span>小波特征池化对比实验</div>
            <div class="sec-sub">同一数据、同一种子与划分，端侧同结构 CNN-LSTM</div>
            <table class="tbl">
              <tr><th>特征维度</th><th>LSTM hidden</th><th>轮数</th><th>测试准确率</th></tr>
              ${poolRows}
            </table>
            <div class="note" style="margin-top:12px">
              池化会丢掉相位信息，而这份数据恰好靠相位与能量区分，因此最终方案保留完整的 3600 维系数序列。
            </div>
          </div>
        </div>

        <div class="grid g2">
          <div class="card">
            <div class="sec-title"><span class="dot"></span>PCA 散点（Stage0.mat 自带降维结果）</div>
            ${hasPca ? '<canvas class="plot" id="pcaCv" height="240"></canvas>'
              : '<div class="muted small">当前导出未包含 PCA 坐标。</div>'}
          </div>
          <div class="card">
            <div class="sec-title"><span class="dot"></span>训练配置</div>
            <div class="kv">
              <div class="k">小波</div><div class="v">${cfg.wavelet || 'db4'} · ${cfg.waveletLevel || 5} 层</div>
              <div class="k">通道</div><div class="v">${(cfg.channels || []).join(' / ')}</div>
              <div class="k">LSTM</div><div class="v">hidden ${cfg.hidden || '-'} · stride ${cfg.lstmStride || 1}</div>
              <div class="k">训练</div><div class="v">${cfg.epochs || '-'} 轮 · batch ${cfg.batch || '-'} · lr ${cfg.lr || '-'}</div>
              <div class="k">特征池化</div><div class="v">${(cfg.featPool || 1) > 1 ? cfg.featPool + '×' : '不池化'}</div>
              <div class="k">最后一轮</div><div class="v">loss ${(m.history.loss.slice(-1)[0] || 0).toFixed(4)} · acc ${pct(m.history.acc.slice(-1)[0] || 0, 2)}%</div>
            </div>
          </div>
        </div>

        <div class="note danger">
          <b>诚实口径</b>：100% 是 4 次独立重训（只换随机种子）中最好的一次，区间 98.33%~100%，均值 99.03%±0.70；
          180 条全对对应的 95% 置信下界为 98.35%。调参与种子均参考了测试集，目前没有独立验证集；
          数据来自单一工况，未验证跨转速、跨载荷与加噪场景。
        </div>
      </div>`;

    const h = m.history || { loss: [], acc: [] };
    Chart.line($('lossCv'), {
      series: [{ values: h.loss, color: '#2B5CE6', fill: 'rgba(43,92,230,0.16)' }],
      formatY: v => v.toFixed(2), xLabel: '训练轮数 →', height: 120
    });
    Chart.line($('accCv'), {
      series: [{ values: h.acc, color: '#11B5A4', fill: 'rgba(17,181,164,0.16)' }],
      yMin: 0, yMax: 1, formatY: v => (v * 100).toFixed(0) + '%', xLabel: '训练轮数 →', height: 120
    });
    if (hasPca) {
      Chart.scatter($('pcaCv'), {
        points: m.pca.map((p, i) => ({ x: p[0], y: p[1], c: Math.floor(i / (m.perClassTotal || 104)) })),
        palette: PALETTE, height: 240
      });
    }
  }

  // ---------------------------------------------------------------- 问答（云端 AI）
  const C = { messages: [] };
  const A = {
    cloud: null, models: [], modelId: '', history: [], convId: '',
    generating: false, ctrl: null,
    state: 'idle',      // idle | loading | ready | offline | error
    mode: 'local',      // proxy（自建 /api/chat）| cloud（免密钥云通道）| local（本地规则）
    err: '', provider: '', maxTokens: 3000
  };

  /** 同源代理地址；用 file:// 直接打开时没有后端，问答走本地规则 */
  function aiEndpoint() {
    return location.protocol === 'file:' ? '' : 'api/chat';
  }

  /**
   * 通道一：自建代理 /api/chat（密钥在服务端，首选）。
   * 通道二：WorkBuddy 免密钥云通道（cloud-config.js），无需任何后端，
   *         直接双击 index.html 也能用；缺点只对授权域名放行。
   * 通道三：本地规则知识库（S.M.qa），断网兜底。
   */
  function loadSdkScript() {
    return new Promise((resolve, reject) => {
      if (window.WorkBuddyCloud) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('SDK 载入失败'));
      document.head.appendChild(s);
    });
  }

  function genId() {
    return (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  /** 尝试免密钥云通道；成功返回 true */
  async function tryCloudChannel() {
    const cfg = window.WB_CLOUD_CONFIG;
    if (!cfg || !cfg.endpoint || !cfg.publishableKey) return false;
    try {
      await loadSdkScript();
      const cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: cfg.endpoint,
        publishableKey: cfg.publishableKey
      });
      const list = await cloud.llm.models.list();
      const models = (list || []).filter(x => x.disabled !== true);
      if (!models.length) return false;
      A.cloud = cloud;
      A.mode = 'cloud';
      A.provider = '云通道（免密钥）';
      A.models = models.map(x => x.id);
      A.modelId = models[0].id;
      A.providerNames = {};
      models.forEach(x => { A.providerNames[x.id] = x.name || x.id; });
      return true;
    } catch (e) {
      A.cloud = null;
      return false;
    }
  }

  function sysPrompt() {
    const m = S.meta, latest = S.latestPrediction, cfg = m.config || {};
    const lines = [
      '你是「UConn 振动信号智能诊断系统」网页版里的 AI 助手，负责解答用户关于本系统的问题。',
      '系统事实（回答必须以此为准，不得编造数字）：',
      '- 任务：齿轮箱振动信号 9 分类。数据为 UConn 公开数据集，共 936 条样本、每条 3600 点、9 类各 104 条；720 条训练、180 条测试、36 条备用。',
      '- 模型：端侧 CNN-LSTM。db4 小波特征 → 4 层一维卷积（不池化）→ LSTM → Softmax，全部在用户浏览器本地推理，单条约 13ms，不上传信号数据。',
      '- 指标：测试集准确率 180/180（=100%），包内 6 位量化数据上为 99.44%；同配置换随机种子复测均值约 99.0%（±0.7）。诚实口径：100% 是多次重训中最好的一次，95% 置信下界约 98.35%。',
      '- 边界：只能识别这 9 类已知状态，换设备或换工况必须重新训练；不具备故障定位、剩余寿命预测能力；数据为单一工况采集。'
    ];
    if (latest) {
      lines.push('- 最近一次诊断：判定类别 ' + latest.predicted + '，置信度 ' +
        (latest.confidence || 0).toFixed(4) + '，样本来源 ' + latest.source + '。用户可能会就这条结果追问。');
    }
    lines.push('回答要求：使用简体中文；简洁、多用短句或分点；涉及数字必须来自上述事实或用户当前页面可见的数据，不要编造；超出系统能力范围的问题要如实说明；与故障诊断无关的问题可以简短作答并把话题引回本系统。');
    return lines.join('\n');
  }

  function errText(e) {
    const code = (e && e.error && e.error.code) || '';
    const msg = (e && e.error && e.error.message) || (e && e.message) || String(e);
    if (code === 'auth_missing')
      return '服务端还没有配置模型密钥：请在部署平台的 Environment Variables 里填 LLM_API_KEY 后重新部署。在此之前问答会自动改用本地知识库。';
    if (code.indexOf('auth_') === 0)
      return 'AI 通道鉴权失败：' + msg;
    if (code.indexOf('quota_') === 0)
      return '调用被限流或额度用尽，请稍后再试：' + msg;
    if (code.indexOf('gateway_') === 0)
      return '模型服务暂时不可用（' + (e && e.status ? 'HTTP ' + e.status : '网关错误') + '），请稍后重试。';
    if (code.indexOf('model_') === 0)
      return '该模型不可用，请检查模型名或服务商开通情况。';
    if (code.indexOf('request_') === 0)
      return '请求参数有误：' + msg;
    if (e instanceof TypeError || /network|fetch|failed to fetch|load failed/i.test(msg))
      return '网络不可用：AI 对话需要联网（诊断与推理不受影响，仍在本地）。请检查网络后重试。';
    return 'AI 调用失败：' + msg;
  }

  function setChatStatus() {
    const dot = $('aiDot'), txt = $('chatStatus');
    if (!dot || !txt) return;
    const cls = A.state === 'ready' ? 'ready' : (A.state === 'offline' ? 'loading' : A.state === 'error' ? 'error' : 'loading');
    dot.className = 'chat-ai-dot ' + cls;
    const nameOf = id => (A.providerNames && A.providerNames[id]) || id;
    if (A.state === 'ready') {
      const via = A.mode === 'cloud' ? '云通道' : '服务端代理';
      txt.textContent = 'AI 已连接 · ' + nameOf(A.modelId) + '（' + via + '）';
      txt.title = '通道：' + (A.provider || A.mode);
    } else if (A.state === 'loading') {
      txt.textContent = '正在连接 AI 服务…';
    } else if (A.state === 'offline') {
      txt.textContent = '无可用 AI 通道 · 已切到本地知识库';
      txt.title = A.err || '';
    } else if (A.state === 'error') {
      txt.textContent = '连接失败：' + A.err;
    } else {
      txt.textContent = '未连接';
    }
  }

  function fillModelSelect() {
    const sel = $('chatModel');
    if (!sel) return;
    if (A.models.length <= 1) { sel.hidden = true; return; }
    sel.hidden = false;
    sel.innerHTML = A.models.map(id =>
      `<option value="${esc(id)}" ${id === A.modelId ? 'selected' : ''}>${esc((A.providerNames && A.providerNames[id]) || id)}</option>`).join('');
  }

  /**
   * 依次尝试：自建代理 → 免密钥云通道 → 本地规则。
   * 关键：不把"某条通道没配好"当成致命错误 —— 下一级还能用，诊断更不该受影响。
   */
  let aiProbe = null;
  /** 同一时刻只探测一次，多个调用共享同一个 Promise */
  function ensureAI() {
    if (A.state === 'ready') return Promise.resolve(true);
    if (aiProbe) return aiProbe;
    aiProbe = probeAI().then(
      v => { aiProbe = null; return v; },
      () => { aiProbe = null; return false; }
    );
    return aiProbe;
  }

  async function probeAI() {
    A.state = 'loading'; setChatStatus();

    // 1) 自建代理（密钥在服务端，能力最自由）
    const ep = aiEndpoint();
    if (ep) {
      try {
        const r = await fetch(ep + '?health=1', { cache: 'no-store' });
        const h = await r.json();
        if (h && h.ok) {
          A.state = 'ready';
          A.mode = 'proxy';
          A.provider = h.providerLabel || h.provider || '';
          A.models = (h.models && h.models.length) ? h.models : [h.model];
          A.modelId = h.model;
          A.maxTokens = h.maxTokens || 3000;
          A.providerNames = null;
          fillModelSelect(); setChatStatus();
          return true;
        }
      } catch (e) { /* 落到下一条通道 */ }
    }

    // 2) 免密钥云通道（无需任何后端，但不是所有域名都放行）
    if (await tryCloudChannel()) {
      A.state = 'ready';
      fillModelSelect(); setChatStatus();
      return true;
    }

    // 3) 本地规则知识库
    A.state = 'offline';
    A.mode = 'local';
    A.err = ep ? '代理与云通道均不可用' : '当前以本地文件打开（file://），没有服务端';
    setChatStatus();
    return false;
  }

  /** 云通道的流式调用（与代理的 fetch 分支并列，产出同样的事件形状） */
  async function streamFromCloud(messages, onDelta, signal) {
    if (!A.convId) A.convId = genId();
    let content = '', reasoning = '', finish = '';
    for await (const chunk of A.cloud.llm.chat.completions.create({
      model: A.modelId,
      messages: messages,
      stream: true,
      stream_options: { include_usage: true },
      conversationId: A.convId,
      signal: signal
    })) {
      const ch = chunk && chunk.choices && chunk.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      const r = d.reasoning_content != null ? d.reasoning_content : d.reasoning;
      if (typeof r === 'string' && r) {
        reasoning += r;
        onDelta(r, reasoning, 'reasoning');
      }
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        onDelta(d.content, content, 'content');
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    return { content: content, reasoning: reasoning, finish: finish };
  }

  /** 后端不可用时的兜底：本地规则问答（与小程序同一套逻辑，结论全部来自真实运行数据） */
  function localAnswer(q) {
    try {
      const m = S.meta || {};
      const r = S.M.qa.answer(q, {
        latest: S.latestPrediction,
        metrics: m.metrics || null,
        perClass: m.perClass || null,
        confusion: m.confusion || null,
        history: m.history || null,
        info: m.info || null,
        config: m.config || {}
      });
      if (r && r.text) return r;
    } catch (e) { /* 落到下面的兜底文案 */ }
    return {
      text: '当前 AI 服务未配置，已使用本地知识库回答，这个问题暂时没有匹配到条目。\n\n可以试试下方的推荐问题，或在「诊断」页跑一条样本后再问结果。',
      chips: (S.M.qa.QUICK || []).slice(0, 4)
    };
  }

  function viewChat() {
    const host = $('view-chat');
    host.innerHTML = `
      <div class="card chat-wrap">
        <div class="chat-toolbar">
          <span class="chat-ai-dot" id="aiDot"></span>
          <select id="chatModel" class="inp chat-model" title="选择模型" hidden></select>
          <span class="small muted" id="chatStatus">未连接</span>
        </div>
        <div class="chat-log" id="chatLog"></div>
        <div class="chat-input">
          <input class="inp" id="chatIn" placeholder="输入问题，例如：为什么模型预测为这个类别？">
          <button class="btn primary" id="chatSend">发送</button>
          <button class="btn" id="chatClear">清空</button>
        </div>
        <div class="small muted" style="margin-top:8px">
          问答优先走自建代理（密钥只在服务端），连不上时自动切 WorkBuddy 免密钥云通道，两者都不可用才用本地知识库。诊断与推理始终在浏览器本地完成，不上传信号数据。
        </div>
      </div>`;

    const latest = S.latestPrediction;
    const hello = latest
      ? `系统已就绪。最近一次诊断结果为【类别 ${latest.predicted}】，Softmax 分数 ${latest.confidence.toFixed(4)}，样本来源：${latest.source}。\n\n可以就这条结果追问，也可以问模型表现、判据分析或改进方向。`
      : '你好，我是本系统的 AI 助手。\n\n我可以结合本次真实运行结果回答模型表现、判据分析、改进方向等问题。建议先在「诊断」页跑一条样本，再回来追问结果。';
    C.messages = [{ id: 1, role: 'bot', text: hello, chips: S.M.qa.QUICK.slice(0, 3) }];
    renderChat();
    setChatStatus();
    ensureAI();

    const input = host.querySelector('#chatIn');
    host.querySelector('#chatSend').addEventListener('click', () => {
      if (A.generating) { if (A.ctrl) A.ctrl.abort(); return; }
      send(input.value);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !A.generating) send(input.value); });
    host.querySelector('#chatClear').addEventListener('click', () => {
      C.messages = [{ id: Date.now(), role: 'bot', text: '对话已清空，已开启新的会话。', chips: S.M.qa.QUICK.slice(0, 3) }];
      A.history = []; A.convId = '';
      renderChat();
    });
    host.querySelector('#chatModel').addEventListener('change', e => {
      A.modelId = e.target.value; setChatStatus();
    });
  }

  function setGenerating(on) {
    A.generating = on;
    const btn = document.querySelector('#chatSend');
    if (btn) btn.textContent = on ? '停止' : '发送';
  }

  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderChat(); }, 40);
  }

  function renderChat() {
    const log = $('chatLog');
    if (!log) return;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = C.messages.map(m => {
      let think = '';
      if (m.reasoning) {
        const open = m.streaming && !m.text ? ' open' : '';
        const tip = m.streaming && !m.text ? '（生成中）' : '';
        think = `<details class="think"${open}><summary>思考过程 · ${m.reasoning.length} 字${tip}</summary>` +
          `<div class="think-body">${esc(m.reasoning)}</div></details>`;
      }
      let body;
      if (m.text) body = esc(m.text) + (m.streaming ? '<span class="stream-cur">▍</span>' : '');
      else if (m.streaming && !m.reasoning) body = '<span class="typing"><i></i><i></i><i></i></span>';
      else body = '';
      if (m.truncated) body += '<div class="small muted" style="margin-top:8px">（输出达到长度上限被截断）</div>';
      const chips = m.chips && m.chips.length
        ? `<div class="chips">${m.chips.map(c => `<button class="chip" data-q="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '';
      return `<div class="msg ${m.role}">
        <div class="ava">${m.role === 'bot' ? 'AI' : '我'}</div>
        <div class="bubble">${think}${body}${chips}</div></div>`;
    }).join('');
    log.querySelectorAll('[data-q]').forEach(b => b.addEventListener('click', () => {
      if (!A.generating) send(b.dataset.q);
    }));
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  async function send(text) {
    const q = String(text || '').trim();
    if (!q || A.generating) return;
    const host = $('view-chat');
    if (host) host.querySelector('#chatIn').value = '';
    C.messages.push({ id: Date.now(), role: 'user', text: q });
    renderChat();

    const bot = { id: Date.now() + 2, role: 'bot', text: '', reasoning: '', streaming: true };
    C.messages.push(bot);
    renderChat();

    // 还没探测过就先探一次；探测中不会重复发起
    const ready = await ensureAI();

    // 两条 AI 通道都不可用 → 本地规则直接答，并如实标注来源
    if (!ready) {
      const r = localAnswer(q);
      bot.text = (r.text || '') + '\n\n（说明：当前没有可用的 AI 通道，以上回答来自本地知识库。配置服务端密钥，或通过授权域名访问，即可获得更自由的追问能力。）';
      bot.chips = r.chips || [];
      bot.streaming = false;
      renderChat();
      return;
    }

    setGenerating(true);
    A.history.push({ role: 'user', content: q });
    const messages = [{ role: 'system', content: sysPrompt() }].concat(A.history.slice(-16));
    const ctrl = A.ctrl = new AbortController();
    let acc = '', accThink = '';
    const onDelta = (delta, full, kind) => {
      if (kind === 'reasoning') { accThink = full; bot.reasoning = accThink; }
      else { acc = full; bot.text = acc; }
      scheduleRender();
    };

    const run = (A.mode === 'cloud')
      ? streamFromCloud(messages, onDelta, ctrl.signal)
      : fetch(aiEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: A.modelId, messages: messages, max_tokens: A.maxTokens }),
        signal: ctrl.signal
      }).then(res => {
        if (!res.ok) {
          return res.json().catch(() => ({})).then(j => {
            const err = new Error((j && j.error && j.error.message) || ('HTTP ' + res.status));
            err.status = res.status;
            err.error = (j && j.error) || { code: 'http_' + res.status, message: err.message };
            throw err;
          });
        }
        return window.VBSSE.readStream(res, onDelta);
      });

    run.then(out => {
      bot.streaming = false;
      bot.text = (out && out.content) || '';
      bot.reasoning = (out && out.reasoning) || accThink;
      bot.truncated = !!(out && out.finish === 'length');
      if (bot.text) A.history.push({ role: 'assistant', content: bot.text });
      else if (bot.reasoning) {
        bot.text = '（模型只输出了思考过程，正文为空。通常是 max_tokens 被思考耗尽，可调大 CHAT_MAX_TOKENS 或换个问题。）';
        bot.truncated = true;
      } else {
        bot.text = '（模型未返回内容，请重新发送）';
      }
    }).catch(e => {
      bot.streaming = false;
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)));
      if (aborted) {
        bot.text = acc ? acc + '\n\n[已停止]' : '[已停止生成]';
        if (acc) A.history.push({ role: 'assistant', content: acc });
        return;
      }
      // 云通道被域名策略拒绝时，别让用户卡死 —— 就地降级，并说明原因
      if (A.mode === 'cloud') {
        A.state = 'offline';
        A.mode = 'local';
        setChatStatus();
        const r = localAnswer(q);
        bot.text = (r.text || '') + '\n\n（说明：免密钥云通道对当前域名未授权（' + ((e && e.message) || '403') + '），以上回答已改用本地知识库。）';
        bot.chips = r.chips || [];
        return;
      }
      bot.text = errText(e);
      if (e && e.error && e.error.code === 'auth_missing') {
        A.state = 'offline';
        A.mode = 'local';
        setChatStatus();
      }
    }).then(() => {
      setGenerating(false);
      renderChat();
    });
  }

  // ---------------------------------------------------------------- 启动
  boot();
})();
