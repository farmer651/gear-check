// 浏览器环境兜底：base64 -> Uint8Array（替代 Node 的 Buffer.from）
(function (g) {
  g.__M = g.__M || {};
  g.__b64From = function (str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
})(typeof window !== 'undefined' ? window : globalThis);
