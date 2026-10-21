# SearXNG：自建元搜索（聚合 Google/Brave 等），作为 vps-hot 的免 key、抗限流搜索源。
# 在 Railway 里单独建一个服务，不要开公网域名，仅走私网：
#   vps-hot 设置 SEARXNG_URL=http://<服务名>.railway.internal:8080
FROM searxng/searxng:latest
COPY settings.yml /etc/searxng/settings.yml
