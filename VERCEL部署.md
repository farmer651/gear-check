# Vercel 部署说明

这一版把 AI 密钥放在服务端（`api/chat.js`），前端只跟同源的 `/api/chat` 说话，所以不需要任何免密钥通道，也不怕密钥泄露。

## 一、导入项目

1. Vercel → Add New → Project → 选中这个仓库。
2. **Root Directory 一定要改成 `web`**（网页文件都在这个子目录里，不改会 404）。
3. Framework Preset 选 **Other**，Build Command 和 Output Directory 都留空。
4. 先不要点 Deploy，先把环境变量填好。

## 二、环境变量（Project Settings → Environment Variables）

| Name | Value | 说明 |
| --- | --- | --- |
| `LLM_PROVIDER` | `tokenhub` | 可选 tokenhub / hunyuan / deepseek / moonshot / zhipu / dashscope / siliconflow / openai |
| `LLM_API_KEY` | `sk-...` | 必须。混元 TokenHub 的密钥 |
| `LLM_MODEL` | `hy3` | 可选，不填用预设 |
| `CHAT_MAX_TOKENS` | `3000` | 可选。推理模型的思考也占额度，低于 2000 容易出现"只有思考没有正文" |

填完点 Deploy，或者去 Deployments 里 Redeploy 一次（**改环境变量必须重新部署才生效**）。

## 三、验证

打开 `https://你的域名/api/chat?health=1`，应该看到：

```json
{"ok":true,"provider":"tokenhub","providerLabel":"腾讯混元（TokenHub 国际站）","host":"tokenhub-intl.tencentmaas.com","model":"hy3","models":["hy3"],"maxTokens":3000}
```

- `ok:false` + `reason:"missing_key"` → 环境变量没填或没 Redeploy。
- 网页「交互问答」页左上的圆点是绿色，说明已经连上；灰色说明走了本地知识库。

## 四、说明

- 诊断、推理、数据集全部在浏览器本地跑，不经过 Vercel，断网也能用。
- `/api/chat` 有同源校验 + 每 IP 10 分钟 30 次限流，防止密钥被白嫖。
- 函数最长 60 秒（`vercel.json` 里 `maxDuration: 60`），代理在 55 秒时会主动收尾。
- 密钥只存在 Vercel 环境变量里；本地开发放 `web/.env.local`，已被 `.gitignore` 忽略。

## 五、本地预览（不用 Vercel）

```bash
node tools/serve.js 8123
# 或双击根目录的「启动网页.bat」
```

然后打开 http://localhost:8123 。本地会读 `web/.env.local`。
