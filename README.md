# 羊毛空间中转服务

用无头浏览器（Playwright + Chromium）抓 LINUX DO 和超级线报 cjx8.com，
再以 JSON 供羊毛空间轮询。普通 HTTP 请求抓不到这两站：

- LINUX DO：Cloudflare 的 "Just a moment..." JS 验证，机房 IP 和程序请求
  一律 403，哪怕走美国住宅代理也一样（2026-11-25 实测：latest.json
  和 latest.rss 均 403）。真浏览器能执行验证并通过。
- cjx8.com：WAF 先下一道 JS（写 waf-token cookie 后刷新），首页本身
  又是 JS 渲染的单页应用，HTML 里没有正文，必须渲染完再从 DOM 取链接。

Cloudflare Worker 之类没浏览器的方案做不了这两站，必须是一台常开的机器
+ 真浏览器。Instabox 免费机不合适（30 分钟闲置或 8 小时运行后会暂停），
建议用一台 VPS（例如 RackNerd 黑五那台 $15.98/年，顺带还能当小火箭节点）。

## 部署（Debian/Ubuntu VPS）

```bash
# 1. 装 Node.js 20 和依赖
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo mkdir -p /opt/yangmao-relay && sudo chown $USER /opt/yangmao-relay
cp package.json relay.mjs /opt/yangmao-relay/
cd /opt/yangmao-relay && npm install
npx playwright install chromium --with-deps

# 2. 先手动跑一次验证（应看到两站各抓到若干条）
node relay.mjs --once

# 3. 交给 systemd 常驻
sudo cp yangmao-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yangmao-relay

# 4. 验证接口（把 YOUR_VPS_IP 换成机器 IP）
curl http://YOUR_VPS_IP:3100/health
curl http://YOUR_VPS_IP:3100/feed.json | head -c 500
```

注意：3100 端口要在 VPS 防火墙/安全组放行。服务每 2 分钟抓一次，
结果缓存在 feed-cache.json，重启后仍能先返回上次的数据。

## 免费版：GitHub Actions 定时抓取（不用买机器）

公开仓库的 Actions 免费额度不限分钟数，每 5 分钟跑一次（定时任务的最短间隔），
抓完把 `feed.json` 提交回仓库，空间直接读 CDN：

1. 在 GitHub 新建一个**公开**仓库，把 `package.json`、`relay.mjs`、
   `.github/workflows/scrape.yml` 传上去（仓库公开是关键：私有仓库免费账号
   每月只有 2000 分钟，不够跑）。
2. 在仓库的 Actions 页点 Run workflow 手动跑一次，看日志里两站是否抓到数据——
   GitHub 机房 IP + 真浏览器能不能过 LINUX DO 的验证，要看这次运行结果。
3. 跑通后，空间的抓取地址改成
   `https://cdn.jsdelivr.net/gh/<你的用户名>/<仓库名>@main/feed.json`
   （jsDelivr 自带 CORS，可公开访问）。

代价：数据最快 5 分钟一新（空间还是 2 分钟一问，但背后数据 5 分钟才变），
而且 Actions 定时任务在高峰期可能延迟几分钟。

## 其他免费路子（都有短板）

- Oracle 永久免费 VPS：真正的常开机，ARM 4 核 24G 够跑浏览器，但注册要绑卡、
  热门区经常没货，搭起来费事。
- Instabox 免费机：你已经有了，但 30 分钟闲置或跑满 8 小时就暂停，做不到 24 小时，
  只能白天断断续续用。
- 自己的电脑：能跑，但空间是 HTTPS 页面，调本地 HTTP 接口会被浏览器拦，不干净。

## 接口

- `GET /feed.json`：`{ updatedAt, sources: { linuxdo: { ok, count, items[] }, cjx8: {...} } }`，
  每条 item 为 `{ title, link, pubDate, source }`，跨域已放开（`Access-Control-Allow-Origin: *`）。
- `GET /health`：`{ ok: true, updatedAt }`。

## 接入空间

中转跑通后，把空间的抓取顺序改成：先问 `http://YOUR_VPS_IP:3100/feed.json`，
拿 LINUX DO 和超级线报两站；V2EX、小众软件、NodeSeek 仍走现有直连/RSSHub。
