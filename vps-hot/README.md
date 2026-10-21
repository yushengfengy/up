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
`POST /api/research` `{"query":"你的需求"}` → AI 提取关键词 → 联网搜索 → AI 筛选总结。首页也有输入框。
设置了 `INGEST_TOKEN` 时需带 `Authorization: Bearer <token>`。

环境变量：
| 变量 | 说明 |
|---|---|
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 内置提供商 `default`（OpenAI 兼容，`AI_BASE_URL` 需含 `/v1`）。在 Railway Cloud Agent VM 内未设置时回退到平台网关 |
| `AI_JSON_MODE` | 设 `0` 关闭 `response_format`（不支持的服务商用；400 时也会自动重试） |
| `AI_TEMPERATURE` | 可选；默认不发送（部分模型不支持） |
| `SEARCH_PROVIDER` | `auto`(默认：grok(有key时)→duckduckgo→bing，免key，质量一般，云IP易被限) / `tavily` / `brave` / `serper` / `searxng` / `bing` / `grok` / `duckduckgo`。正式使用建议 tavily 或 brave |
| `XAI_API_KEY` | Grok 联网搜索 key。设置后 `SEARCH_PROVIDER=auto` 会优先用 Grok；或显式 `SEARCH_PROVIDER=grok` |
| `GROK_MODEL` / `XAI_BASE_URL` | 默认 `grok-4.7` / `https://api.x.ai/v1` |
| `GROK_ALLOWED_DOMAINS` / `GROK_EXCLUDED_DOMAINS` | 逗号分隔，最多 5 个，二选一，限制或排除搜索的域名 |
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
