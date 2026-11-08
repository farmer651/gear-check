// assets/dataset_parts.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
// 端上数据集分片清单（由 tools/make_dataset_pkg.js 自动生成）
__M.partsMain = [
  __M.dsp0,
  __M.dsp1,
  __M.dsp2,
  __M.dsp3,
  __M.dsp4,
  __M.dsp5
];

})(typeof window !== "undefined" ? window : globalThis);

// packageData/assets/dataset_parts.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
// 端上数据集分片清单（由 tools/make_dataset_pkg.js 自动生成）
__M.partsSub = [
  __M.dsp6,
  __M.dsp7,
  __M.dsp8,
  __M.dsp9,
  __M.dsp10,
  __M.dsp11,
  __M.dsp12,
  __M.dsp13
];

})(typeof window !== "undefined" ? window : globalThis);

// utils/dataset.js（由 tools/build_web.js 自动转译，请勿手改）
(function (g) {
var __M = g.__M;
var module = { exports: {} }; var exports = module.exports;
/**
 * 端上全量数据集加载器
 *
 * 数据由 tools/make_dataset_pkg.js 生成：全部 936 条样本 × 全部 3600 点，
 * 按位打包后分片存放在主包 assets/ 与分包 packageData/assets/。
 * 分包中的页面需要把自己的分片注册进来（主包的分片本模块直接 require）。
 *
 * 用法（分包页面）：
 *   const ds = require('../../../utils/dataset.js');
 *   ds.registerParts(require('./assets/dataset_parts.js'));
 *   const signal = ds.sample(123);            // Float64Array(3600)
 *   console.log(ds.total, ds.rawLength, ds.info.snrDb);
 */
const index = __M.indexFull;
const mainParts = __M.partsMain;

const DIM = index.rawLength;
const TOTAL = index.total;
const BITS = index.bits;
const LEVELS = (1 << BITS) - 1;

let extraParts = [];
let packed = null;
let mins = null;
let scales = null;
let posOf = null;
let availableBytes = 0;

function b64ToBytes(str) {
  if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) {
    return new Uint8Array(wx.base64ToArrayBuffer(str));
  }
  // Node / 测试环境
  return new Uint8Array(__b64From(str, 'base64'));
}

function b64ToF32(str) {
  const bytes = b64ToBytes(str);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
}

/** 分包把自己的分片注册进来 */
function registerParts(parts) {
  if (!parts || !parts.length) return;
  extraParts = extraParts.concat(parts);
  packed = null;   // 分片变化后重新解码
}

function ensure() {
  if (packed) return;
  // 生成脚本保证了拼接顺序：主包分片在前、分包分片在后，各自内部按编号递增
  const ordered = mainParts.concat(extraParts);
  const buf = new Uint8Array(index.packedBytes);
  let off = 0;
  for (const s of ordered) {
    const bytes = b64ToBytes(s);
    if (off + bytes.length > buf.length) {
      buf.set(bytes.subarray(0, buf.length - off), off);
      off = buf.length;
      break;
    }
    buf.set(bytes, off);
    off += bytes.length;
  }
  availableBytes = off;
  packed = buf;
  mins = b64ToF32(index.mins);
  scales = b64ToF32(index.scales);
  // 打包位置 -> 原始序号（order）；这里建反向表便于按原始序号取值
  if (index.order) {
    posOf = new Int32Array(TOTAL);
    for (let p = 0; p < TOTAL; p++) posOf[index.order[p]] = p;
  }
}

/** 解出第 i 条样本的完整 3600 点信号（i 为原始 mat 中的样本序号，未做任何抽取） */
function sample(i) {
  ensure();
  if (i < 0 || i >= TOTAL) throw new Error('样本序号超出范围：' + i);
  const out = new Float64Array(DIM);
  const mn = mins[i];
  const sc = scales[i];
  // 打包时按九类轮转存放，故需把原始序号换算成实际位偏移
  const slot = posOf ? posOf[i] : i;
  let bit = slot * DIM * BITS;
  for (let t = 0; t < DIM; t++) {
    let lv = 0;
    for (let b = 0; b < BITS; b++) {
      const p = bit + b;
      if (packed[p >> 3] & (0x80 >> (p & 7))) lv |= 1 << (BITS - 1 - b);
    }
    out[t] = mn + lv * sc;
    bit += BITS;
  }
  return out;
}

/** 标签：与 main.py 一致，每类 104 条顺序排列 */
const labelOf = i => Math.floor(i / index.perClass);

/**
 * 当前已载入分片能完整解出的样本（打包时九类轮转存放，
 * 因此任意前缀都均匀覆盖九个类别）。
 * 返回 { slots, total, complete }：slots 为可解样本数，complete 表示是否全部到齐。
 */
function coverage() {
  ensure();
  const bitsPerSample = DIM * BITS;
  const slots = Math.min(TOTAL, Math.floor(availableBytes * 8 / bitsPerSample));
  return { slots, total: TOTAL, complete: slots >= TOTAL };
}

/** 当前可用分片中属于第 cls 类的原始样本序号列表 */
function availableIndices(cls) {
  const { slots } = coverage();
  const out = [];
  for (let p = 0; p < slots; p++) {
    const orig = index.order ? index.order[p] : p;
    if (cls === undefined || cls === null || labelOf(orig) === cls) out.push(orig);
  }
  return out;
}

__M.dataset = {
  info: index,
  total: TOTAL,
  rawLength: DIM,
  bits: BITS,
  perClass: index.perClass,
  numClasses: index.numClasses,
  registerParts,
  sample,
  labelOf,
  coverage,
  availableIndices
};

})(typeof window !== "undefined" ? window : globalThis);
