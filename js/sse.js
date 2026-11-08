/**
 * SSE 流解析器 —— 浏览器与 Node 共用同一份实现
 *
 * 浏览器：<script src="js/sse.js"></script>  → window.VBSSE.readStream
 * Node  ：require('./js/sse.js')             → { readStream }（tools/test_proxy_chat.js 用它做端到端断言）
 *
 * 设计要点：
 *  - 只认 OpenAI 兼容协议：choices[0].delta.{content|reasoning_content}
 *  - 推理模型（如混元 hy3）会先吐 reasoning_content 再吐 content，两条流分开累积，
 *    绝不把思考内容混进正文，否则用户会看到"模型在自言自语"。
 *  - 服务端返回非 2xx 时抛错，错误对象带 .status / .error.code，前端据此给中文提示。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VBSSE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * 读取一个 SSE 响应流。
   * @param {Response} res        fetch 返回的响应（必须带 body）
   * @param {Function} onDelta    每段回调 (deltaText, fullText, kind)，kind = 'content' | 'reasoning'
   * @returns {Promise<{content:string, reasoning:string, finish:string}>}
   */
  async function readStream(res, onDelta) {
    if (res && res.ok === false) {
      const text = await res.text().catch(() => '');
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* 非 JSON */ }
      const msg = (body && body.error && body.error.message) || text || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.error = (body && body.error) || { code: 'http_' + res.status, message: msg };
      throw err;
    }
    if (!res || !res.body || typeof res.body.getReader !== 'function') {
      const err = new Error('响应没有可读取的流');
      err.error = { code: 'stream_missing', message: err.message };
      throw err;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let content = '';
    let reasoning = '';
    let finish = '';
    let done = false;

    const emit = delta => {
      if (!delta) return;
      const r = delta.reasoning_content !== undefined && delta.reasoning_content !== null
        ? delta.reasoning_content
        : delta.reasoning;
      if (typeof r === 'string' && r) {
        reasoning += r;
        if (onDelta) onDelta(r, reasoning, 'reasoning');
      }
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content, content, 'content');
      }
    };

    const handleEvent = block => {
      const data = [];
      const lines = block.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        if (line.indexOf('data:') !== 0) continue;
        data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      const payload = data.join('\n');
      if (payload === '[DONE]') { done = true; return; }
      let json;
      try { json = JSON.parse(payload); } catch (e) { return; }
      if (json && json.error) {
        const err = new Error(json.error.message || '上游返回错误');
        err.error = json.error;
        throw err;
      }
      const ch = json && json.choices && json.choices[0];
      if (!ch) return;
      if (ch.delta) emit(ch.delta);
      if (ch.finish_reason) finish = ch.finish_reason;
    };

    while (!done) {
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true }).replace(/\r\n/g, '\n');
      let idx;
      while (!done && (idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (block.trim()) handleEvent(block);
      }
    }
    if (!done && buf.trim()) {
      try { handleEvent(buf); } catch (e) { throw e; }
    }

    return { content: content, reasoning: reasoning, finish: finish };
  }

  return { readStream: readStream };
});
