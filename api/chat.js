'use strict';
/**
 * POST /api/chat —— 服务端 LLM 代理（Vercel Serverless Function / 本地 tools/serve.js 通用）
 *
 * 为什么需要它：浏览器直接调模型厂商会被 CORS 拦，而且密钥会暴露在前端。
 * 这里把密钥留在服务端，前端只跟同源 /api/chat 说话。
 *
 * 环境变量（Vercel 项目设置 → Environment Variables，或本地 web/.env.local）：
 *   LLM_PROVIDER     tokenhub | hunyuan | deepseek | moonshot | zhipu | dashscope | siliconflow | openai
 *   LLM_API_KEY      厂商密钥（必填）
 *   LLM_MODEL        覆盖预设模型名（可选）
 *   LLM_BASE_URL     覆盖预设 baseURL，兼容任何 OpenAI 协议网关（可选）
 *   CHAT_MODELS      允许前端选择的模型白名单，逗号分隔（可选，默认只允许 LLM_MODEL）
 *   CHAT_MAX_TOKENS  单次生成上限，默认 3000，最大 8192（推理模型的思考也占这个额度）
 *   ALLOW_ORIGINS    额外放行的来源，逗号分隔，* 表示全放（可选）
 */

const PRESETS = {
  tokenhub: { baseUrl: 'https://tokenhub-intl.tencentmaas.com/v1', model: 'hy3', label: '腾讯混元（TokenHub 国际站）' },
  hunyuan: { baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos-latest', label: '腾讯混元' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', label: 'DeepSeek' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', label: 'Moonshot' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', label: '智谱 GLM' },
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', label: '阿里通义千问' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', label: '硅基流动' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', label: 'OpenAI' }
};

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQ_PER_WINDOW = 30;
const MAX_TOKENS_CAP = 8192;
const HITS = new Map();

function cfg() {
  const provider = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
  const preset = PRESETS[provider] || {};
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || '';
  const baseUrl = String(process.env.LLM_BASE_URL || preset.baseUrl || '').replace(/\/+$/, '');
  const model = String(process.env.LLM_MODEL || preset.model || 'deepseek-chat');
  const models = String(process.env.CHAT_MODELS || model)
    .split(',').map(s => s.trim()).filter(Boolean);
  const maxTokens = Math.min(MAX_TOKENS_CAP, Math.max(1, parseInt(process.env.CHAT_MAX_TOKENS || '3000', 10) || 3000));
  return {
    provider: provider || 'custom',
    providerLabel: preset.label || '自定义网关',
    key: key,
    baseUrl: baseUrl,
    model: model,
    models: models,
    maxTokens: maxTokens
  };
}

function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return ''; }
}

function scrub(s) {
  return String(s == null ? '' : s).replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  } catch (e) { /* 连接已断，忽略 */ }
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function rateLimited(ip) {
  const now = Date.now();
  const arr = (HITS.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= MAX_REQ_PER_WINDOW) { HITS.set(ip, arr); return true; }
  arr.push(now);
  HITS.set(ip, arr);
  return false;
}

function originAllowed(req) {
  const allow = String(process.env.ALLOW_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allow.indexOf('*') >= 0) return true;
  const origin = req.headers.origin;
  if (!origin) return true;                          // 服务端直连 / curl，无浏览器上下文
  if (allow.indexOf(origin) >= 0) return true;
  try {
    const u = new URL(origin);
    if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(u.hostname)) return true;
    const self = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0].trim();
    return !!self && u.host === self;                // 同源：部署域名 + 自定义域名
  } catch (e) { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > 1e6) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

const ROLES = { system: 1, user: 1, assistant: 1 };

/** 只保留合法角色与非空内容，避免脏输入把上游打挂 */
function cleanMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let sys = 0;
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    if (!m || typeof m !== 'object') continue;
    let role = String(m.role || '').toLowerCase();
    if (!ROLES[role]) role = (role === 'bot' || role === 'ai') ? 'assistant' : 'user';
    const content = typeof m.content === 'string' ? m.content : '';
    if (!content.trim()) continue;
    if (role === 'system') {
      if (sys++) continue;                            // 只认第一条 system
      out.push({ role: 'system', content: content.slice(0, 4000) });
      continue;
    }
    out.push({ role: role, content: content.slice(0, 8000) });
  }
  return out.slice(-20);
}

function pickModel(want, c) {
  const w = String(want || '');
  if (w && c.models.indexOf(w) >= 0) return w;
  return c.models.indexOf(c.model) >= 0 ? c.model : c.models[0];
}

/** 上游错误 → 前端可读的错误码 */
function upstreamCode(status) {
  if (status === 401 || status === 403) return 'auth_upstream';
  if (status === 429) return 'quota_upstream';
  if (status === 404) return 'model_upstream';
  if (status >= 500) return 'gateway_upstream';
  return 'request_upstream';
}

module.exports = async function handler(req, res) {
  const c = cfg();
  const url = String(req.url || '');
  const qpos = url.indexOf('?');
  const pathname = qpos >= 0 ? url.slice(0, qpos) : url;
  const query = qpos >= 0 ? url.slice(qpos + 1) : '';

  // ---------- 健康检查：前端启动时先问一句，决定走 AI 还是本地规则 ----------
  if (req.method === 'GET' && /(^|&)health=1(&|$)/.test(query)) {
    const ok = !!(c.key && c.baseUrl);
    return json(res, 200, {
      ok: ok,
      reason: ok ? '' : (!c.key ? 'missing_key' : 'missing_base_url'),
      provider: c.provider,
      providerLabel: c.providerLabel,
      host: hostOf(c.baseUrl),
      model: c.model,
      models: c.models,
      maxTokens: c.maxTokens
    });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: { code: 'method_not_allowed', message: '只支持 POST' } });
  }

  if (!pathname) return json(res, 404, { error: { code: 'not_found', message: '路径错误' } });

  if (!originAllowed(req)) {
    return json(res, 403, {
      error: { code: 'auth_origin', message: '当前访问来源未获授权。请在 Vercel 用 ALLOW_ORIGINS 加入 ' + (req.headers.origin || '') }
    });
  }

  if (!c.key || !c.baseUrl) {
    return json(res, 400, {
      error: {
        code: 'auth_missing',
        message: !c.key ? '服务端未配置 LLM_API_KEY，请到部署平台添加环境变量后重新部署。' : '服务端未配置 LLM_BASE_URL。'
      }
    });
  }

  if (rateLimited(clientIp(req))) {
    return json(res, 429, { error: { code: 'quota_local', message: '请求过于频繁（每个 IP 10 分钟 30 次），请稍后再试。' } });
  }

  // ---------- 解析请求 ----------
  let payload = {};
  try {
    const raw = await readBody(req);
    payload = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return json(res, 400, { error: { code: 'request_json', message: '请求体不是合法 JSON' } });
  }

  const messages = cleanMessages(payload.messages);
  if (!messages.length) {
    return json(res, 400, { error: { code: 'request_empty', message: 'messages 为空' } });
  }
  const model = pickModel(payload.model, c);
  const maxTokens = Math.min(MAX_TOKENS_CAP, Math.max(1, parseInt(payload.max_tokens, 10) || c.maxTokens));
  const temperature = typeof payload.temperature === 'number' ? payload.temperature : 0.6;

  // ---------- 转发给上游 ----------
  const ac = new AbortController();
  let upstream;
  try {
    upstream = await fetch(c.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.key,
        'Accept': 'text/event-stream'
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        max_tokens: maxTokens,
        temperature: temperature
      }),
      signal: ac.signal
    });
  } catch (e) {
    const msg = /abort/i.test(String(e && e.message)) ? '上游连接被中止' : ('无法连接上游 ' + hostOf(c.baseUrl) + '：' + (e && e.message));
    return json(res, 502, { error: { code: 'gateway_unreachable', message: scrub(msg) } });
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => '');
    let msg = raw;
    try {
      const j = JSON.parse(raw);
      if (j && j.error && j.error.message) msg = j.error.message;
      else if (j && j.message) msg = j.message;
    } catch (e) { /* 保留原文 */ }
    const code = upstreamCode(upstream.status);
    console.log('[api/chat] 上游 ' + upstream.status + ' ' + code + '：' + scrub(msg).slice(0, 300));
    return json(res, upstream.status, {
      error: { code: code, status: upstream.status, message: scrub(msg).slice(0, 600) }
    });
  }

  // ---------- 流式回写（原样透传，保留 reasoning_content） ----------
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const timer = setTimeout(() => {
    if (closed) return;
    try {
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '\n\n（响应超时，已截断。可以让问题更聚焦后重试。）' }, finish_reason: 'length' }] }) + '\n\n');
    } catch (e) { /* ignore */ }
    try { ac.abort(); } catch (e) { /* ignore */ }
    try { res.end(); } catch (e) { /* ignore */ }
    closed = true;
  }, 55000);

  // 用户在页面上点「停止」→ 浏览器断开 → 立刻掐断上游，不浪费 token
  res.on('close', () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { ac.abort(); } catch (e) { /* ignore */ }
  });

  try {
    const reader = upstream.body.getReader();
    while (!closed) {
      const step = await reader.read();
      if (step.done) break;
      if (!res.write(Buffer.from(step.value))) {
        await new Promise(r => res.once('drain', r));
      }
    }
  } catch (e) {
    if (!closed && !/abort/i.test(String(e && e.message))) {
      console.log('[api/chat] 流转发中断：' + scrub(e && e.message));
    }
  } finally {
    clearTimeout(timer);
    if (!closed) { closed = true; try { res.end(); } catch (e) { /* ignore */ } }
  }
};

module.exports.config = { maxDuration: 60 };
