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
| `AI_BASE_URL` | OpenAI 兼容地址，默认 `https://api.openai.com/v1`（需含 `/v1`） |
| `AI_API_KEY` | 必填 |
| `AI_MODEL` | 默认 `gpt-4o-mini` |
| `AI_JSON_MODE` | 设 `0` 关闭 `response_format`（不支持的服务商用） |
| `SEARCH_PROVIDER` | `duckduckgo`(默认,免key,云IP可能被限) / `tavily` / `brave` / `serper` / `searxng` |
| `SEARCH_API_KEY` | tavily/brave/serper 的 key |
| `SEARXNG_URL` | searxng 实例地址 |
