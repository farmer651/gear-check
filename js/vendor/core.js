// utils/dwt.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * db4 离散小波变换（与训练端完全一致）
 * 对应 main.py 中 pywt.wavedec(signal, 'db4', level=5) 的处理思路：
 *   各层系数拼接 -> 截断（或补零）到原信号长度
 * 小程序端无第三方库，这里用纯 JS 实现。
 */

// db4 分解滤波器（Daubechies-4，8 抽头）
const DEC_LO = [
  -0.010597401784997278, 0.032883011666982945, 0.030841381835986965,
  -0.18703481171888114, -0.02798376941698385, 0.6308807679295904,
  0.7148465705525415, 0.23037781330885523
];
const DEC_HI = [
  -0.23037781330885523, 0.7148465705525415, -0.6308807679295904,
  -0.02798376941698385, 0.18703481171888114, 0.030841381835986965,
  -0.032883011666982945, -0.010597401784997278
];

// 对称延拓（边缘值重复），对应 pywt 的 mode='symmetric'
// 例：[1,2,3] 左右各延拓 2 个 -> [2,1, 1,2,3, 3,2]
function symmetricExtend(x, left, right) {
  const n = x.length;
  const out = new Float64Array(n + left + right);
  const wrap = (idx) => {
    const period = 2 * n;
    let k = ((idx % period) + period) % period;
    return k < n ? k : period - 1 - k;
  };
  for (let i = 0; i < left; i++) out[i] = x[wrap(left - 1 - i)];
  for (let i = 0; i < n; i++) out[left + i] = x[i];
  for (let j = 0; j < right; j++) out[left + n + j] = x[wrap(n - 1 - j)];
  return out;
}

function decomposeOnce(x) {
  const n = x.length;
  const L = DEC_LO.length;
  const M = Math.floor((n + L - 1) / 2);
  const ext = symmetricExtend(x, L - 1, L - 1);
  const a = new Float64Array(M);
  const d = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const base = 2 * i;
    let sa = 0, sd = 0;
    for (let k = 0; k < L; k++) {
      const v = ext[base + k];
      sa += DEC_LO[k] * v;
      sd += DEC_HI[k] * v;
    }
    a[i] = sa;
    d[i] = sd;
  }
  return { a, d };
}

/**
 * 5 层小波分解，返回与输入等长的特征向量
 * @param {Float64Array|number[]} signal 已标准化的信号
 * @param {number} level 分解层数，默认 5
 */
function waveletFeature(signal, level) {
  level = level || 5;
  let cur = Float64Array.from(signal);
  const parts = []; // 依次保存 d5, d4, ... d1（稍后反向拼接）
  const ds = [];
  for (let l = 0; l < level; l++) {
    const r = decomposeOnce(cur);
    ds.push(r.d);
    cur = r.a;
  }
  // pywt 顺序：cA5, cD5, cD4, cD3, cD2, cD1
  parts.push(cur);
  for (let i = ds.length - 1; i >= 0; i--) parts.push(ds[i]);

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float64Array(Math.max(total, signal.length));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  const n = signal.length;
  if (total < n) {
    // 不足则补零（与 main.py 的 np.pad 一致）
    for (let i = total; i < n; i++) out[i] = 0;
  }
  return out.subarray(0, n);
}

__M.dwt = { waveletFeature, DEC_LO, DEC_HI };

})(typeof window !== "undefined" ? window : globalThis);

// utils/model.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * 端侧推理内核（架构驱动）
 *
 * 数值流程与训练端完全一致：
 *   原始信号 -> 训练集标准化 -> db4 五层小波特征 -> 自适应卷积小波层
 *   -> 若干卷积块（归一化/激活/池化可配置） -> LSTM -> 全连接 -> Softmax
 *
 * 支持两套权重规格：
 *   1) full —— 与 source/main.py 的 CNNLSTM 完全同构（32/64/128/256 + BatchNorm + LSTM256）
 *      由 tools/export_weights.py 从 .pth 导出
 *   2) lite —— 端侧轻量版（8/16/24/32 + LayerNorm + 特征池化）
 *      由 tools/train.js 训练并导出
 *
 * 两者共用本文件的前向实现，差别全部体现在权重自带的 blocks 规格中。
 */
const { waveletFeature } = __M.dwt;

const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64MAP = (() => {
  const m = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64CHARS.length; i++) m[B64CHARS.charCodeAt(i)] = i;
  return m;
})();

function b64Bytes(b64) {
  const len = b64.length;
  let pad = 0;
  if (b64[len - 1] === '=') pad++;
  if (b64[len - 2] === '=') pad++;
  const bytes = new Uint8Array((len / 4) * 3 - pad);
  let p = 0;
  for (let i = 0; i < len; i += 4) {
    const c0 = B64MAP[b64.charCodeAt(i)];
    const c1 = B64MAP[b64.charCodeAt(i + 1)];
    const c2 = B64MAP[b64.charCodeAt(i + 2)];
    const c3 = B64MAP[b64.charCodeAt(i + 3)];
    if (p < bytes.length) bytes[p++] = (c0 << 2) | (c1 >> 4);
    if (p < bytes.length) bytes[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (p < bytes.length) bytes[p++] = ((c2 & 3) << 6) | c3;
  }
  return bytes;
}

/** base64 字符串 -> Float32Array（权重） */
function b64ToF32(b64) {
  const bytes = b64Bytes(b64);
  const out = new Float32Array(bytes.length >> 2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  return out;
}

/** base64 -> Int16Array（信号量化数据） */
function b64ToI16(b64) {
  const bytes = b64Bytes(b64);
  const out = new Int16Array(bytes.length >> 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}

/** base64 -> Int8Array（数据集分包的 8 位量化信号） */
function b64ToI8(b64) {
  const bytes = b64Bytes(b64);
  const out = new Int8Array(bytes.length);
  out.set(bytes);
  return out;
}

// ============================================================
// 基础算子
// ============================================================

function conv1d(x, cin, cout, k, pad, w, b) {
  const T = x[0].length;
  const out = [];
  for (let o = 0; o < cout; o++) out.push(new Float64Array(T));
  for (let o = 0; o < cout; o++) {
    const acc = out[o];
    const base = o * cin * k;
    const bb = b ? b[o] : 0;
    for (let t = 0; t < T; t++) acc[t] = bb;
    for (let c = 0; c < cin; c++) {
      const xc = x[c];
      const wc = base + c * k;
      for (let j = 0; j < k; j++) {
        const wv = w[wc + j];
        if (wv === 0) continue;
        const shift = j - pad;
        const t0 = Math.max(0, -shift);
        const t1 = Math.min(T, T - shift);
        for (let t = t0; t < t1; t++) acc[t] += wv * xc[t + shift];
      }
    }
  }
  return out;
}

function reluInPlace(m) {
  for (let c = 0; c < m.length; c++) {
    const row = m[c];
    for (let i = 0; i < row.length; i++) if (row[i] < 0) row[i] = 0;
  }
}

function absInPlace(m) {
  for (let c = 0; c < m.length; c++) {
    const row = m[c];
    for (let i = 0; i < row.length; i++) if (row[i] < 0) row[i] = -row[i];
  }
}

/** 逐位置、跨通道层归一化（无仿射参数，端侧轻量版权重使用） */
function layerNormInPlace(m, eps) {
  const C = m.length;
  const T = m[0].length;
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let c = 0; c < C; c++) s += m[c][t];
    const mu = s / C;
    let v = 0;
    for (let c = 0; c < C; c++) { const d = m[c][t] - mu; v += d * d; }
    v /= C;
    const sd = Math.sqrt(v + eps);
    for (let c = 0; c < C; c++) m[c][t] = (m[c][t] - mu) / sd;
  }
}

/** BatchNorm1d 推理（使用训练期滑动统计量，等价 PyTorch eval 模式） */
function batchNormInPlace(m, bn) {
  const C = m.length;
  const T = m[0].length;
  const eps = bn.eps || 1e-5;
  for (let c = 0; c < C; c++) {
    const g = bn.gamma[c];
    const be = bn.beta[c];
    const mu = bn.mean[c];
    const inv = 1 / Math.sqrt(bn.varr[c] + eps);
    const row = m[c];
    for (let t = 0; t < T; t++) row[t] = (row[t] - mu) * inv * g + be;
  }
}

function maxPool2(m) {
  const c = m.length;
  const T2 = m[0].length >> 1;
  const out = [];
  for (let i = 0; i < c; i++) {
    const src = m[i];
    const dst = new Float64Array(T2);
    for (let t = 0; t < T2; t++) {
      const a = src[2 * t], b = src[2 * t + 1];
      dst[t] = a > b ? a : b;
    }
    out.push(dst);
  }
  return out;
}

const sigmoid = z => 1 / (1 + Math.exp(-z));

/** 小波特征按块平均池化：3600 -> 900（端侧轻量版使用，原版为 1 即不池化） */
function featurePool(feat, f) {
  const T = Math.floor(feat.length / f);
  const out = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    let s = 0;
    for (let k = 0; k < f; k++) s += feat[i * f + k];
    out[i] = s / f;
  }
  return out;
}

// ============================================================
// 前向传播
// ============================================================

/** 单条信号完整前向，返回 { probs, logits, feature, embedding } */
function forward(signal, W) {
  const n = W.signalLength;
  const mean = W.mean;
  const std = W.std;

  // 1. 按训练集统计量标准化（防泄漏：测试阶段固定参数）
  const scaled = new Float64Array(n);
  for (let i = 0; i < n; i++) scaled[i] = (signal[i] - mean[i]) / std[i];

  // 2. 小波特征（可选块平均池化）
  let feat = waveletFeature(scaled, W.waveletLevel);
  if (W.featurePool > 1) feat = featurePool(feat, W.featurePool);

  // 3. 卷积主干：逐块执行 ops 中声明的算子
  let x = [feat];
  for (let bi = 0; bi < W.blocks.length; bi++) {
    const blk = W.blocks[bi];
    x = conv1d(x, blk.cin, blk.cout, blk.k, blk.pad, blk.w, blk.b);
    for (let oi = 0; oi < blk.ops.length; oi++) {
      const op = blk.ops[oi];
      if (op === 'abs') absInPlace(x);
      else if (op === 'relu') reluInPlace(x);
      else if (op === 'ln') layerNormInPlace(x, W.lnEps || 1e-5);
      else if (op === 'bn') batchNormInPlace(x, blk.bn);
    }
    if (blk.pool === 2) x = maxPool2(x);
    // 原版池化后接 dropout，推理阶段恒等，无需处理
  }

  // 4. LSTM 时序建模，取最后一个时间步
  const L = W.lstm;
  const T = x[0].length;
  const stride = W.lstmStride || 1;
  const H = L.hidden;
  const IN = L.input;
  const wx = L.wx, wh = L.wh, lb = L.b;
  let h = new Float64Array(H);
  let c = new Float64Array(H);
  const gate = new Float64Array(4 * H);

  for (let t = 0; t < T; t += stride) {
    // x 是通道优先（[C][T]），LSTM 按时间步取一列
    for (let g = 0; g < 4 * H; g++) {
      let s = lb[g];
      const off = g * IN;
      for (let ci = 0; ci < IN; ci++) s += wx[off + ci] * x[ci][t];
      const offh = g * H;
      for (let j = 0; j < H; j++) s += wh[offh + j] * h[j];
      gate[g] = s;
    }
    for (let j = 0; j < H; j++) {
      const i_ = sigmoid(gate[j]);
      const f_ = sigmoid(gate[H + j]);
      const g_ = Math.tanh(gate[2 * H + j]);
      const o_ = sigmoid(gate[3 * H + j]);
      c[j] = f_ * c[j] + i_ * g_;
      h[j] = o_ * Math.tanh(c[j]);
    }
  }

  // 5. 全连接分类
  const C = W.numClasses;
  const logits = new Float64Array(C);
  for (let k = 0; k < C; k++) {
    let s = W.fc.b[k];
    const off = k * H;
    for (let j = 0; j < H; j++) s += W.fc.w[off + j] * h[j];
    logits[k] = s;
  }

  // 6. Softmax
  let mx = -Infinity;
  for (let k = 0; k < C; k++) if (logits[k] > mx) mx = logits[k];
  const probs = new Float64Array(C);
  let sum = 0;
  for (let k = 0; k < C; k++) {
    probs[k] = Math.exp(logits[k] - mx);
    sum += probs[k];
  }
  for (let k = 0; k < C; k++) probs[k] /= sum;

  return { probs, logits, feature: feat, embedding: h };
}

// ============================================================
// 权重解析
// ============================================================

/** 兼容 base64 字符串与已解码数组两种输入 */
const asF32 = v => (typeof v === 'string' ? b64ToF32(v) : (v || null));

/** int8 逐行对称量化权重还原为 float32（行主序） */
function deq(node) {
  const q = b64ToI8(node.data);
  const s = b64ToF32(node.scale);
  const rows = node.rows;
  const cols = node.cols;
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const sc = s[r];
    const off = r * cols;
    for (let c = 0; c < cols; c++) out[off + c] = q[off + c] * sc;
  }
  return out;
}

/** 权重节点：支持 float32(base64) 与 int8 量化两种存储 */
const weightOf = node => (node && node.data ? deq(node) : asF32(node));

function parseBlock(raw) {
  const blk = {
    cin: raw.cin,
    cout: raw.cout,
    k: raw.k,
    pad: raw.pad === undefined ? (raw.k >> 1) : raw.pad,
    pool: raw.pool || 1,
    ops: raw.ops || ['relu'],
    w: weightOf(raw.w8 || raw.w),
    b: asF32(raw.b)
  };
  if (raw.bn) {
    blk.bn = {
      gamma: asF32(raw.bn.gamma),
      beta: asF32(raw.bn.beta),
      mean: asF32(raw.bn.mean),
      varr: asF32(raw.bn.var),
      eps: raw.bn.eps || 1e-5
    };
  }
  return blk;
}

/** 解析导出的权重对象（base64 -> TypedArray），自动兼容 lite / full / 早期扁平格式 */
function buildWeights(raw) {
  const W = {
    arch: raw.arch || 'lite',
    signalLength: raw.signalLength,
    numClasses: raw.numClasses,
    waveletLevel: raw.waveletLevel || 5,
    lstmStride: raw.lstmStride || 1,
    featurePool: raw.featPool || raw.featurePool || 1,
    lnEps: raw.lnEps || 1e-5,
    mean: b64ToF32(raw.mean),
    std: b64ToF32(raw.std),
    blocks: []
  };

  if (Array.isArray(raw.blocks)) {
    W.blocks = raw.blocks.map(parseBlock);
  } else {
    // 早期扁平格式：conv1(1->C1,k3,abs) conv2..conv4(k5,relu+ln+pool)
    const b1 = { w: b64ToF32(raw.conv1.w), b: b64ToF32(raw.conv1.b) };
    const b2 = { w: b64ToF32(raw.conv2.w), b: b64ToF32(raw.conv2.b) };
    const b3 = { w: b64ToF32(raw.conv3.w), b: b64ToF32(raw.conv3.b) };
    const b4 = { w: b64ToF32(raw.conv4.w), b: b64ToF32(raw.conv4.b) };
    const c1 = b1.w.length / 3;
    const c2 = b2.w.length / (c1 * 5);
    const c3 = b3.w.length / (c2 * 5);
    const c4 = b4.w.length / (c3 * 5);
    W.blocks = [
      parseBlock({ cin: 1, cout: c1, k: 3, pad: 1, pool: 1, ops: ['abs'], w: b1.w, b: b1.b }),
      parseBlock({ cin: c1, cout: c2, k: 5, pad: 2, pool: 2, ops: ['relu', 'ln'], w: b2.w, b: b2.b }),
      parseBlock({ cin: c2, cout: c3, k: 5, pad: 2, pool: 2, ops: ['relu', 'ln'], w: b3.w, b: b3.b }),
      parseBlock({ cin: c3, cout: c4, k: 5, pad: 2, pool: 2, ops: ['relu', 'ln'], w: b4.w, b: b4.b })
    ];
    W.lstmStride = raw.lstmStride || 1;
    W.featurePool = raw.featPool || 1;
  }

  const last = W.blocks[W.blocks.length - 1];
  W.lstm = {
    input: last.cout,
    hidden: 0,
    wx: weightOf(raw.lstm.wx8 || raw.lstm.wx),
    wh: weightOf(raw.lstm.wh8 || raw.lstm.wh),
    b: b64ToF32(raw.lstm.b)
  };
  // 由权重形状推导维度（w_hh 形状 4H x H，w_ih 形状 4H x input）
  W.lstm.hidden = Math.round(Math.sqrt(W.lstm.wh.length / 4));
  W.lstm.input = W.lstm.wx.length / (4 * W.lstm.hidden);

  W.fc = { w: weightOf(raw.fc.w8 || raw.fc.w), b: b64ToF32(raw.fc.b) };
  W.numClasses = raw.numClasses || W.fc.b.length;
  return W;
}

__M.model = { forward, buildWeights, b64ToF32, b64ToI16, b64ToI8, featurePool, conv1d, maxPool2 };

})(typeof window !== "undefined" ? window : globalThis);

// utils/qa.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * 本地规则问答引擎
 * 由 main.py 的 answer_question() 迁移而来，回答内容全部来自真实运行结果，不做无依据推断。
 */
const { HISTORY_KEYS } = { HISTORY_KEYS: null };

const TOPICS = [
  {
    key: 'prediction',
    label: '预测结果',
    kw: ['预测结果', '预测类别', '分成哪类', '属于哪类', '分类结果', '刚才的结果', '预测是什么', '这次结果']
  },
  { key: 'probs', label: '类别概率', kw: ['概率', '置信度', 'softmax', '分数'] },
  { key: 'metrics', label: '模型准确率', kw: ['准确率', 'accuracy', '效果怎么样', '分类效果', '模型表现', '性能怎么样', '指标'] },
  { key: 'confusion', label: '混淆矩阵', kw: ['混淆矩阵', '误分类', '错分', '分错', '哪些类别容易混淆', '容易混淆'] },
  { key: 'why', label: '判据分析', kw: ['为什么', '依据是什么', '分类依据', '原因是什么', '为什么判为', '怎么判断', '依据'] },
  { key: 'error', label: '误判分析', kw: ['误判', '错误原因', '为什么错', '分类错误', '判错了'] },
  { key: 'improve', label: '改进建议', kw: ['如何提高', '怎么提高', '改进', '优化模型', '提升准确率', '准确率低', '效果不好'] },
  { key: 'overfit', label: '过拟合判断', kw: ['过拟合', '欠拟合', '泛化', '训练损失'] },
  { key: 'dataset', label: '数据集信息', kw: ['数据集', '样本数量', '多少样本', '信号长度', '输入长度', '输入维度', '类别数量', '数据来源'] },
  { key: 'model', label: '模型结构', kw: ['模型结构', 'cnn', 'lstm', '网络结构', '模型原理', '工作原理', '怎么工作'] },
  { key: 'wavelet', label: '小波特征', kw: ['小波', 'db4', '特征提取', '小波变换'] },
  { key: 'train', label: '训练参数', kw: ['训练轮数', 'epoch', '学习率', '训练参数', '批大小', '训练多久'] },
  { key: 'help', label: '能问什么', kw: ['帮助', '能问什么', '问什么', '功能', '怎么使用', '有哪些问题', 'help'] }
];

const QUICK = [
  '最近一次预测结果是什么？',
  '每个类别的概率是多少？',
  '当前模型准确率是多少？',
  '混淆矩阵说明了什么？',
  '为什么模型预测为这个类别？',
  '哪些类别容易混淆？',
  '如何提高分类准确率？',
  '如何判断过拟合？',
  '当前模型是什么结构？',
  '小波变换起什么作用？'
];

function f(n, d) {
  return Number(n).toFixed(d === undefined ? 4 : d);
}

function detect(text) {
  const q = String(text || '').toLowerCase().trim();
  if (!q) return null;
  let best = null, bestScore = 0;
  for (const t of TOPICS) {
    for (const k of t.kw) {
      if (q.indexOf(k.toLowerCase()) >= 0) {
        const score = k.length;
        if (score > bestScore) { bestScore = score; best = t.key; }
      }
    }
  }
  return best;
}

function answer(question, ctx) {
  const topic = detect(question);
  const { latest, metrics, perClass, confusion, history, info, config } = ctx;

  if (!topic) {
    return {
      text: '暂时无法根据规则回答这个问题。可以换一种问法，或点击下方的推荐问题。\n\n当前问答模块是本地规则系统，回答内容全部取自本次真实运行的结果，不依赖在线大模型。',
      chips: QUICK.slice(0, 4)
    };
  }

  switch (topic) {
    case 'prediction': {
      if (!latest) {
        return { text: '目前还没有进行单样本诊断。请先到「诊断」页选择一个测试样本或输入一条原始振动信号。', chips: ['模型准确率是多少？', '当前模型是什么结构？'] };
      }
      const cmp = latest.trueLabel === null || latest.trueLabel === undefined
        ? ''
        : `\n该样本真实标签为类别 ${latest.trueLabel}，本次判断${latest.correct ? '正确' : '错误'}。`;
      return {
        text: `最近一次诊断结果为【类别 ${latest.predicted}】，最高 Softmax 分数 ${f(latest.confidence)}。${cmp}\n\n注意：Softmax 分数是模型对九个类别输出的相对分数，未经概率校准，不能等同于真实故障概率。类别编号是数据集标签，未提供标签语义映射，因此不赋予具体故障名称。`
      };
    }
    case 'probs': {
      if (!latest) {
        return { text: '请先在「诊断」页完成一次诊断，再查询类别概率。' };
      }
      const order = latest.probs
        .map((p, i) => ({ p, i }))
        .sort((a, b) => b.p - a.p);
      const lines = order.map(o => `类别 ${o.i}：${f(o.p)}`);
      return {
        text: `最近一次诊断的九类概率（降序）：\n${lines.join('\n')}\n\n说明：Softmax 将输出归一化为和为 1 的分数，未经概率校准前不能直接解释为真实正确率。`
      };
    }
    case 'metrics': {
      return {
        text: `测试集 Accuracy = ${f(metrics.accuracy)}\nMacro Precision = ${f(metrics.precision)}\nMacro Recall = ${f(metrics.recall)}\nMacro F1 = ${f(metrics.f1)}\n训练集 Accuracy = ${f(metrics.trainAccuracy)}\n测试样本数 = ${metrics.testSize}\n\n以上为本次真实训练后在独立测试集上的结果，不是预先设定或保证的指标。`
      };
    }
    case 'confusion': {
      const lines = ['混淆矩阵（行是真实类别，列是预测类别）：'];
      for (let i = 0; i < confusion.length; i++) {
        lines.push(`真实 ${i}：` + confusion[i].join(' '));
      }
      const errs = [];
      for (let i = 0; i < confusion.length; i++) {
        for (let j = 0; j < confusion.length; j++) {
          if (i !== j && confusion[i][j] > 0) errs.push({ n: confusion[i][j], i, j });
        }
      }
      errs.sort((a, b) => b.n - a.n);
      if (errs.length) {
        lines.push('');
        lines.push('较突出的类别混淆：');
        errs.slice(0, 5).forEach(e => lines.push(`真实类别 ${e.i} 被判为类别 ${e.j}：${e.n} 次`));
      } else {
        lines.push('');
        lines.push('当前测试集未观察到非对角线错误。');
      }
      lines.push('对角线为正确分类数，非对角线为错误分类数。');
      return { text: lines.join('\n') };
    }
    case 'why': {
      if (!latest) {
        return { text: '请先在「诊断」页完成一次诊断，再分析该次判断。' };
      }
      const order = latest.probs.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p);
      const gap = order.length >= 2 ? order[0].p - order[1].p : 0;
      return {
        text: `模型把这次输入判为类别 ${latest.predicted}。\n该类别 Softmax 分数 ${f(order[0].p)}，第二候选类别 ${order[1].i}（${f(order[1].p)}），两者分差 ${f(gap)}。\n\n处理流程：训练集逐采样点标准化 → db4 五层离散小波分解 → 自适应卷积小波层（卷积后取绝对值）→ 三层一维卷积提取局部时频特征 → LSTM 建模特征序列 → 全连接层输出九类 logits。\n\n当前实现没有计算 SHAP、梯度归因或采样点贡献度，因此不能声称某个具体采样点导致了该分类。`
      };
    }
    case 'error': {
      return {
        text: '建议按以下顺序排查误判：\n1. 在「评估」页查看混淆矩阵的非对角线元素，定位容易混淆的类别对。\n2. 对比这些类别的原始波形、频谱、小波系数与时域统计量。\n3. 核查标签与样本排列是否一一对应、训练测试划分是否合理、是否存在近重复样本。\n4. 检查信号采集工况与噪声水平是否一致。\n\n如需定量解释单个样本，可进一步引入 SHAP、梯度归因或遮挡实验；当前模型本身无法给出经过验证的物理失效原因。'
      };
    }
    case 'improve': {
      return {
        text: `建议按以下顺序改进：\n1. 核实九类标签与原始样本排列的对应关系。\n2. 检查训练集与测试集是否存在重复或近重复样本。\n3. 查看训练曲线，判断是欠拟合还是过拟合。\n4. 在混淆矩阵中锁定主要错误类别，再针对性地增加特征（频域、包络谱、时域统计量）。\n5. 在固定划分下对比不同网络宽度、卷积核与学习率，并重复多次实验取均值。\n6. 若关心泛化能力，应使用独立工况或独立采集批次做测试。\n\n不建议仅通过堆叠网络层数来判断模型是否改善。当前端侧模型的参数量约 2.3 万（不池化设计），若继续提升可考虑加宽通道或引入更强的时序建模，但需同步留意端侧推理耗时。`
      };
    }
    case 'overfit': {
      const lastLoss = history.loss[history.loss.length - 1];
      const lastAcc = history.acc[history.acc.length - 1];
      return {
        text: `当前训练记录：最后一轮训练损失 ${f(lastLoss, 4)}，训练准确率 ${f(lastAcc, 4)}，测试集准确率 ${f(metrics.accuracy, 4)}。\n\n如果训练指标持续改善而独立验证指标变差，可能存在过拟合；如果训练指标本身也差，则应检查学习率、标签、预处理与模型容量。小程序版在每个 epoch 只统计训练集指标，严格的过拟合判断还需额外划出验证集并绘制验证曲线。`
      };
    }
    case 'dataset': {
      return {
        text: `数据集：UConn 轴承振动信号（DataForClassification_TimeDomain.mat）\n样本总数：${info.totalSamples} 条\n单条信号长度：${info.signalLength} 个采样点\n类别数：${info.numClasses}\n每类样本：${info.perClassTotal} 条\n每类抽取：${info.samplesPerClass} 条参与实验\n训练集：${info.trainSize} 条（80%）\n测试集：${info.testSize} 条（20%）\n\n划分采用分层抽样并固定随机种子，标准化统计量只在训练集上拟合，避免测试集信息泄漏。`
      };
    }
    case 'model': {
      const fp = config.featPool || 1;
      const seq = fp > 1 ? `${Math.floor(config.featureLength / fp)} 维（${fp}× 池化）` : '3600 维（不池化，完整保留）';
      return {
        text: `端侧模型（由 main.py 的 CNN-LSTM 精简而来）：\n原始信号 → 逐采样点标准化 → db4 五层小波系数（${seq}）→ 自适应卷积小波层（Conv1d 1→8，k=3，取绝对值）→ Conv1d 8→16（k=5，ReLU，LayerNorm，MaxPool2）→ Conv1d 16→24（k=5，ReLU，LayerNorm，MaxPool2）→ Conv1d 24→32（k=5，ReLU，LayerNorm，MaxPool2）→ LSTM（hidden=${config.hidden}，时序步长 ${config.lstmStride}，取最后时间步）→ 全连接 ${config.hidden}→9 → Softmax。\n\n为适配手机算力，通道数由 32/64/128/256 精简为 ${config.channels.join('/')}，LSTM 隐藏单元由 256 精简为 ${config.hidden}；BatchNorm 省略，改用 LayerNorm 与权重衰减。小波特征经对比实验确定不做池化。分类头与原模型一致，均为九类 logits。`
      };
    }
    case 'wavelet': {
      return {
        text: `当前使用 ${config.wavelet} 小波，分解 ${config.waveletLevel} 层。\n\n做法与 main.py 一致：拼接 cA5、cD5、cD4、cD3、cD2、cD1 共六段系数，再截断（或补零）到原信号长度 3600，随后送入可训练的自适应卷积小波层。\n\n需要注意：这种拼接不等于严格的多尺度系数对齐，也不等同于滤波器固定的传统小波变换；它只是把多尺度信息压缩进同一长度向量，真正的特征选择交给后续可训练卷积完成。`
      };
    }
    case 'train': {
      return {
        text: `训练轮数：${config.epochs}\n批大小：${config.batch}\n初始学习率：${config.lr}\n优化器：Adam（β1=0.9，β2=0.999，权重衰减 1e-4）\n学习率调度：余弦退火\n最后一轮训练损失：${f(history.loss[history.loss.length - 1], 4)}\n最后一轮训练准确率：${f(history.acc[history.acc.length - 1], 4)}\n\n训练在离线环境完成，权重以 Float32 数组形式随小程序打包，运行时完全在手机本地推理，不依赖网络。`
      };
    }
    case 'help':
    default: {
      return {
        text: '你可以试试这些问题：\n1. 最近一次预测结果是什么？\n2. 每个类别的概率是多少？\n3. 当前模型准确率是多少？\n4. 混淆矩阵说明了什么？\n5. 为什么模型预测为这个类别？\n6. 哪些类别容易混淆？\n7. 如何提高分类准确率？\n8. 如何判断过拟合？\n9. 当前模型是什么结构？\n10. 小波变换起什么作用？',
        chips: QUICK.slice(0, 4)
      };
    }
  }
}

__M.qa = { answer, QUICK, TOPICS };

})(typeof window !== "undefined" ? window : globalThis);

// utils/inflate.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * DEFLATE (RFC 1951) 解压 —— 小程序端纯 JS 实现
 *
 * 用途：MAT v5 文件若以 miCOMPRESSED 方式保存（本项目的两个 .mat 正是如此），
 *       解析前必须先 zlib inflate。小程序没有 zlib 接口，故在此自实现。
 * 只处理 zlib 头部之后的裸 DEFLATE 数据流，调用方负责跳过 2 字节 zlib 头。
 */
const MAXBITS = 15;

// 长度码 / 距离码基表
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
  67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
  4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513,
  769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
  9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** 位流：LSB 优先 */
class BitStream {
  constructor(bytes, pos) {
    this.b = bytes;
    this.p = pos | 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  bits(need) {
    let val = this.bitbuf;
    while (this.bitcnt < need) {
      if (this.p >= this.b.bitLength) throw new Error('DEFLATE 数据意外结束');
      val |= this.b.getUint8(this.p++) << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >>> need;
    this.bitcnt -= need;
    return val & ((1 << need) - 1);
  }
  align() {
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
}

/** 由码长数组构造 canonical Huffman 表（puff 风格：count + symbol） */
function buildHuffman(lengths, n) {
  const count = new Int32Array(MAXBITS + 1);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  let left = 1;
  for (let len = 1; len <= MAXBITS; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) throw new Error('Huffman 表过约束');
  }
  const offs = new Int32Array(MAXBITS + 2);
  for (let len = 1; len <= MAXBITS; len++) offs[len + 1] = offs[len] + count[len];
  const symbol = new Int32Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

function decodeSym(s, h) {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= MAXBITS; len++) {
    code |= s.bits(1);
    const count = h.count[len];
    if (code - first < count) return h.symbol[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error('无效 Huffman 编码');
}

/** 动态 Huffman：读取码长序列 */
function readDynamicTables(s) {
  const nlen = s.bits(5) + 257;
  const ndist = s.bits(5) + 1;
  const ncode = s.bits(4) + 4;
  if (nlen > 286 || ndist > 30) throw new Error('码表长度越界');
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const lengths = new Uint8Array(320);
  for (let i = 0; i < ncode; i++) lengths[order[i]] = s.bits(3);
  for (let i = ncode; i < 19; i++) lengths[order[i]] = 0;
  const lencode = buildHuffman(lengths, 19);

  let index = 0;
  while (index < nlen + ndist) {
    const sym = decodeSym(s, lencode);
    if (sym < 16) {
      lengths[index++] = sym;
    } else {
      let len = 0, repeat = 0;
      if (sym === 16) {
        if (index === 0) throw new Error('重复码缺少前驱');
        len = lengths[index - 1];
        repeat = 3 + s.bits(2);
      } else if (sym === 17) {
        repeat = 3 + s.bits(3);
      } else {
        repeat = 11 + s.bits(7);
      }
      if (index + repeat > nlen + ndist) throw new Error('重复码越界');
      while (repeat--) lengths[index++] = len;
    }
  }
  if (lengths[256] === 0) throw new Error('缺少结束码');
  const distBase = new Uint8Array(lengths.buffer, nlen, ndist);
  const all = new Uint8Array(lengths.buffer, 0, nlen + ndist);
  const lenT = buildHuffman(all, nlen);
  const distT = buildHuffman(distBase, ndist);
  return { lenT, distT };
}

/**
 * 解压 zlib 压缩数据
 * @param {Uint8Array} bytes 含 2 字节 zlib 头的完整数据
 * @param {number} expected 期望输出大小（用于预分配，可选）
 * @returns {Uint8Array} 解压结果
 */
function inflateRaw(bytes, expected) {
  if (bytes[0] !== 0x78 && (bytes[0] & 0x0f) !== 8) {
    // 非标准 zlib 头（某些实现写出 0x58/0x38 等），只要 (CMF*256+CDF)%31==0 即可放行
    if (((bytes[0] << 8) | bytes[1]) % 31 !== 0) throw new Error('不是合法的 zlib 数据流');
    if ((bytes[0] & 0x0f) !== 8) throw new Error('不支持的压缩方法');
  }
  const view = { getUint8: i => bytes[i], bitLength: bytes.length };
  const s = new BitStream(view, 2);

  let out = new Uint8Array(expected && expected > 0 ? expected : Math.max(1024, bytes.length * 4));
  let outLen = 0;

  const ensure = extra => {
    if (outLen + extra <= out.length) return;
    let cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(out.subarray(0, outLen));
    out = nb;
  };

  // 固定 Huffman 表（惰性构造）
  let fixed = null;

  for (;;) {
    const last = s.bits(1);
    const type = s.bits(2);

    if (type === 0) {                       // 存储块
      s.align();
      const p = s.p;
      const len = bytes[p] | (bytes[p + 1] << 8);
      const nlen = bytes[p + 2] | (bytes[p + 3] << 8);
      s.p = p + 4;
      if ((len ^ 0xffff) !== nlen) throw new Error('存储块长度校验失败');
      ensure(len);
      out.set(bytes.subarray(s.p, s.p + len), outLen);
      outLen += len;
      s.p += len;
    } else {
      const tables = type === 1
        ? (fixed || (fixed = buildFixedTables()))
        : readDynamicTables(s);
      for (;;) {
        const sym = decodeSym(s, tables.lenT);
        if (sym === 256) break;
        if (sym < 256) {
          ensure(1);
          out[outLen++] = sym;
        } else {
          const i = sym - 257;
          if (i >= 29) throw new Error('无效长度码');
          const len = LEN_BASE[i] + s.bits(LEN_EXTRA[i]);
          const dsym = decodeSym(s, tables.distT);
          if (dsym >= 30) throw new Error('无效距离码');
          const dist = DIST_BASE[dsym] + s.bits(DIST_EXTRA[dsym]);
          if (dist > outLen) throw new Error('距离超出已输出范围');
          ensure(len);
          let from = outLen - dist;
          for (let k = 0; k < len; k++) out[outLen++] = out[from++];
        }
      }
    }
    if (last) break;
  }
  return out.subarray(0, outLen);
}

function buildFixedTables() {
  const lengths = new Uint8Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  const lenT = buildHuffman(lengths, 288);
  const dl = new Uint8Array(30);
  dl.fill(5);
  const distT = buildHuffman(dl, 30);
  return { lenT, distT };
}

__M.inflate = { inflateRaw };

})(typeof window !== "undefined" ? window : globalThis);

// utils/matparse.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * MAT-file v5 解析器（小程序端）
 *
 * 与 tools/matparse.js 同一套逻辑，去掉 fs/zlib 依赖，直接解析 ArrayBuffer，
 * 因此可以在手机上读取**未经任何加工处理的原始 .mat 文件**（含 zlib 压缩的 miCOMPRESSED
 * 元素，压缩数据由 utils/inflate.js 解压），得到与 scipy.io.loadmat 一致的 float64 数值。
 *
 * MAT 为列主序：dims = [点数, 样本数]，第 s 个样本的第 t 个点位于 data[s * dims[0] + t]。
 */
const { inflateRaw } = __M.inflate;

const T = {
  INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6,
  SINGLE: 7, DOUBLE: 9, INT64: 12, UINT64: 13, MATRIX: 14, COMPRESSED: 15
};

function readTag(dv, off) {
  if (off + 8 > dv.byteLength) return null;
  const type = dv.getUint32(off, true);
  const smallType = type & 0xffff;
  const smallSize = (type >>> 16) & 0xffff;
  if (smallSize > 0 && smallSize <= 4 && smallType >= 1 && smallType <= 13) {
    return { type: smallType, size: smallSize, body: off + 4, next: off + 8, small: true };
  }
  const size = dv.getUint32(off + 4, true);
  const body = off + 8;
  return { type, size, body, next: body + size + ((8 - (size % 8)) % 8), small: false };
}

function readArray(dv, tag) {
  const n = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 9: 8, 12: 8, 13: 8 }[tag.type];
  if (!n) return null;
  const cnt = Math.floor(tag.size / n);
  const base = tag.body;
  const out = new Array(cnt);
  switch (tag.type) {
    case T.DOUBLE:
      for (let i = 0; i < cnt; i++) out[i] = dv.getFloat64(base + i * 8, true);
      return Float64Array.from(out);
    case T.SINGLE:
      for (let i = 0; i < cnt; i++) out[i] = dv.getFloat32(base + i * 4, true);
      return Float32Array.from(out);
    case T.INT16:
      for (let i = 0; i < cnt; i++) out[i] = dv.getInt16(base + i * 2, true);
      return Int16Array.from(out);
    case T.UINT16:
      for (let i = 0; i < cnt; i++) out[i] = dv.getUint16(base + i * 2, true);
      return Uint16Array.from(out);
    case T.INT32:
      for (let i = 0; i < cnt; i++) out[i] = dv.getInt32(base + i * 4, true);
      return Int32Array.from(out);
    case T.UINT32:
      for (let i = 0; i < cnt; i++) out[i] = dv.getUint32(base + i * 4, true);
      return Uint32Array.from(out);
    default: {
      const u8 = new Uint8Array(dv.buffer, dv.byteOffset + base, tag.size);
      const dup = new Uint8Array(tag.size);
      dup.set(u8);
      return dup;
    }
  }
}

function parseMatrix(dv, tag) {
  let off = tag.body;
  const end = tag.body + tag.size;
  const tags = [];
  while (off < end - 7) {
    const t = readTag(dv, off);
    if (!t) break;
    tags.push(t);
    if (t.next <= off) break;
    off = t.next;
  }
  if (tags.length < 3) return { name: '', dims: [], data: null };
  const flags = readArray(dv, tags[0]);
  const dims = Array.from(readArray(dv, tags[1]) || []);
  const nb = tags[2].size;
  let name = '';
  for (let i = 0; i < nb; i++) name += String.fromCharCode(dv.getUint8(tags[2].body + i));
  name = name.replace(/\0+$/, '');
  let data = null;
  if (tags.length >= 4) {
    data = tags[3].type === T.MATRIX ? parseMatrix(dv, tags[3]) : readArray(dv, tags[3]);
  }
  return { name, dims, cls: flags ? flags[0] : null, data };
}

/**
 * 解析 MAT v5 ArrayBuffer
 * @param {ArrayBuffer} arrayBuffer 完整文件内容
 * @returns {Object} 变量名 -> { name, dims, cls, data }
 */
function parseMatBuffer(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let head = '';
  for (let i = 0; i < 116; i++) head += String.fromCharCode(dv.getUint8(i));
  if (head.indexOf('MATLAB 5.0') !== 0) throw new Error('不是 MAT v5 文件');

  const u8 = new Uint8Array(arrayBuffer);
  let off = 128;
  const vars = {};
  while (off < dv.byteLength - 16) {
    const t = readTag(dv, off);
    if (!t) break;
    if (t.type === T.COMPRESSED) {
      // 解压后得到内部矩阵字节，再按普通矩阵解析
      const raw = inflateRaw(u8.subarray(t.body, t.body + t.size));
      const innerDv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const inner = readTag(innerDv, 0);
      if (!inner || inner.type !== T.MATRIX) throw new Error('压缩块内部结构异常');
      const m = parseMatrix(innerDv, inner);
      vars[m.name || 'unnamed'] = m;
    } else if (t.type === T.MATRIX) {
      const m = parseMatrix(dv, t);
      vars[m.name || 'unnamed'] = m;
    } else {
      break;
    }
    if (t.next <= off) break;
    off = t.next;
  }
  return vars;
}

/**
 * 取第 index 个样本（矩阵第 index 列）的完整数据副本
 * @param {{dims:number[], data:Float64Array}} v
 * @param {number} index
 */
function columnOf(v, index) {
  const rows = v.dims[0];
  const cols = v.dims.length > 1 ? v.dims[1] : 1;
  if (index < 0 || index >= cols) throw new Error('样本序号超出范围');
  const out = new Float64Array(rows);
  const base = index * rows;
  for (let i = 0; i < rows; i++) out[i] = v.data[base + i];
  return out;
}

/**
 * 提取浮点二维数组：返回 rows x cols 的 Float64Array 矩阵（按行展开，等价于 matrix.T）
 */
function toMatrix2D(v) {
  const rows = v.dims[0];
  const cols = v.dims.length > 1 ? v.dims[1] : 1;
  const out = new Float64Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) out[c * rows + r] = v.data[c * rows + r];
  }
  return { rows, cols, data: out };
}

__M.matparse = { parseMatBuffer, columnOf, toMatrix2D };

})(typeof window !== "undefined" ? window : globalThis);
