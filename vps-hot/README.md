# vps-hot

零依赖 VPS 热点聚合器，已在 Railway 部署： https://vps-hot-production.up.railway.app/

## 功能
- 支持 rss / json_list / web_list 三种来源
- 自动评分、去重、按标题聚簇
- 域限速 + 429 退避重试
- / /rss /api/items /api/sources /api/ingest
- 5分钟一轮检查过期来源
- data/ 目录挂卷持久化

## 本地运行
```bash
tar xzf vps-hot.tar.gz
cd vps-hot
PORT=8080 INGEST_TOKEN=你的密钥 node server.mjs
# 打开 http://localhost:8080
```

## Railway 部署
```bash
cd vps-hot
railway up --service vps-hot --detach
# 在 Railway 变量里设置 INGEST_TOKEN
# 挂卷：Add Volume -> Mount Path /app/data
```

## 处理 Reddit 429
Reddit 对云服务器IP限流严重，已停用：
- reddit-VPS
- reddit-oraclecloud
- reddit-lowendbox

解决办法：
1. interval_minutes 改成 360 (6小时) - 已做
2. 换成 RSSHub 自建或 RSS代理
3. enabled: false 彻底关闭

改完 sources.json 后重新 railway up

## AI 研究（v1.3）
`POST /api/research` → 类 Grok `web_search` 的多轮研究：AI 规划查询 → 联网搜索 → AI 选页 → 抓取阅读正文 → 评估是否足够，不够则追问新查询 → 带 `[n]` 引用的最终回答。首页也有输入框。
```json
{"query":"需求","depth":2,"provider":"default","allowed_domains":["lowendtalk.com"],"excluded_domains":[]}
```
- `depth` 1-3（搜索轮数，默认 2）；`allowed_domains`/`excluded_domains` 各最多 5 个，二选一
- 返回 `answer`（markdown）、`sources`（被引用来源）、`steps`（研究过程）、`results`（全部搜索结果）
- 抓取页面做了 SSRF 防护（拒绝内网/回环/链路本地地址，逐跳校验重定向），单页最多 1MB、取前 4000 字
- AI 调用数 ≈ 2 + 2×(depth-1) + 1，`depth=1` 最省
设置了 `INGEST_TOKEN` 时需带 `Authorization: Bearer <token>`。

环境变量：
| 变量 | 说明 |
|---|---|
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 内置提供商 `default`（OpenAI 兼容，`AI_BASE_URL` 需含 `/v1`）。在 Railway Cloud Agent VM 内未设置时回退到平台网关 |
| `AI_JSON_MODE` | 设 `0` 关闭 `response_format`（不支持的服务商用；400 时也会自动重试） |
| `AI_TEMPERATURE` | 可选；默认不发送（部分模型不支持） |
| `SEARCH_PROVIDER` | `auto`(默认：grok(有key时)→brave_html→duckduckgo，免key) / `tavily` / `brave` / `serper` / `searxng` / `bing` / `grok` / `duckduckgo`。正式使用建议 tavily 或 brave |
| `XAI_API_KEY` | Grok 联网搜索 key。设置后 `SEARCH_PROVIDER=auto` 会优先用 Grok；或显式 `SEARCH_PROVIDER=grok` |
| `GROK_MODEL` / `XAI_BASE_URL` | 默认 `grok-4.7` / `https://api.x.ai/v1` |
| `GROK_ALLOWED_DOMAINS` / `GROK_EXCLUDED_DOMAINS` | 逗号分隔，最多 5 个，二选一，限制或排除搜索的域名 |
| `BRAVE_MIN_GAP_MS` | 免 key 的 brave_html 两次请求最小间隔，默认 6000。Brave 会拦截 Node 的 fetch，所以通过系统 `curl` 请求；没有 curl 时回退 fetch（可能 429）。免 key 方案受限流影响，正式使用请配 key |
| `SEARCH_API_KEY` | tavily/brave/serper 的 key |
| `SEARXNG_URL` | searxng 实例地址 |

## 用户自带 AI 提供商
需设置 `INGEST_TOKEN`，下列接口都要 `Authorization: Bearer <token>`：
```bash
# 添加（保存到 data/providers.json，GET 时 key 只显示掩码）
curl -XPOST $URL/api/providers -H "Authorization: Bearer $T" \
  -d '{"id":"mine","baseUrl":"https://api.deepseek.com/v1","apiKey":"sk-...","model":"deepseek-chat"}'
curl $URL/api/providers -H "Authorization: Bearer $T"            # 列表
curl -XDELETE "$URL/api/providers?id=mine" -H "Authorization: Bearer $T"
# 使用
curl -XPOST $URL/api/research -H "Authorization: Bearer $T" -d '{"query":"...","provider":"mine"}'
```
不传 `provider` 就用内置 `default`。

## 抓取与限流说明
- 抓网页优先用系统 `curl`（很多站点按连接特征拦截 Node 的 fetch 返回 403），先校验 IP 再用 `--resolve` 固定，重定向逐跳校验（SSRF 防护）。
- 直连失败（403/429/5xx 等）时回退 Jina Reader（`r.jina.ai`，会把目标 URL 发给第三方）；`FETCH_FALLBACK_JINA=0` 关闭。
- 搜索结果内存缓存 6 小时（`SEARCH_CACHE_TTL_MS`）；Brave 免 key 遇 429 退避重试 2 次。免 key 仍受限流，正式使用请配 key。
- 内置 AI 不可用（如部署后无平台网关）时，`default` 自动回退到用户添加的第一个可用提供商。
