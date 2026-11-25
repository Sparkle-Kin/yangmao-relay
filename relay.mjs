// 羊毛空间中转服务：用无头浏览器抓 LINUX DO 和 cjx8.com，再以 JSON 供空间轮询。
// 为什么必须用浏览器：LINUX DO 是 Cloudflare 的 "Just a moment..." JS 验证，
// cjx8.com 是 WAF cookie + JS 渲染的单页应用，普通 HTTP 请求都拿不到正文。
// 部署见 README.md。启动后每 2 分钟抓一次，对外只提供两个接口：
//   GET /feed.json  -> { updatedAt, sources: { linuxdo: {...}, cjx8: {...} } }
//   GET /health     -> { ok: true, updatedAt }
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 3100);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 120000);
const CACHE_FILE = new URL('./feed-cache.json', import.meta.url).pathname;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

let cache = { updatedAt: null, sources: {} };
try {
  cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch {
  /* 第一次启动没有缓存是正常的 */
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function scrapeLinuxDo(browser) {
  const page = await browser.newPage({ userAgent: UA });
  try {
    // latest.json 是 Discourse 的公开 JSON 接口；浏览器会自动过 Cloudflare 的 JS 验证。
    await page.goto('https://linux.do/latest.json', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000); // 给验证留时间
    const text = await page.evaluate(() => document.body.innerText);
    const data = JSON.parse(text);
    const topics = data?.topic_list?.topics ?? [];
    const now = Date.now();
    const items = topics
      .map((t) => ({
        title: t.title,
        link: `https://linux.do/t/${t.slug}/${t.id}`,
        pubDate: t.created_at ? new Date(t.created_at).toISOString() : null,
        source: 'LINUX DO',
      }))
      .filter((i) => !i.pubDate || now - new Date(i.pubDate).getTime() <= SEVEN_DAYS)
      .slice(0, 30);
    return { ok: true, count: items.length, items };
  } catch (e) {
    return { ok: false, count: 0, items: [], error: String(e?.message || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeCjx8(browser) {
  const page = await browser.newPage({ userAgent: UA });
  try {
    // cjx8 首页先是一道 WAF：JS 写 waf-token cookie 后刷新，之后才是单页应用。
    // 真浏览器会自动完成这两步，只需等渲染结束再从 DOM 里取链接。
    await page.goto('https://cjx8.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(5000);
    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') || '';
        const title = (a.textContent || '').trim();
        if (!title || title.length < 4 || title.length > 80) continue;
        if (!/^\/[^/]/.test(href) && !href.startsWith('https://cjx8.com/')) continue;
        if (/^\/(tag|category|page|author|search)/.test(href)) continue;
        const link = href.startsWith('http') ? href : 'https://cjx8.com' + href;
        if (seen.has(link)) continue;
        seen.add(link);
        let pubDate = null;
        const timeEl = a.closest('article,li,div')?.querySelector('time[datetime]');
        if (timeEl) pubDate = timeEl.getAttribute('datetime');
        out.push({ title, link, pubDate, source: '超级线报' });
      }
      return out.slice(0, 40);
    });
    return { ok: true, count: items.length, items };
  } catch (e) {
    return { ok: false, count: 0, items: [], error: String(e?.message || e) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAll() {
  log('开始抓取…');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const [linuxdo, cjx8] = await Promise.all([scrapeLinuxDo(browser), scrapeCjx8(browser)]);
    cache = { updatedAt: new Date().toISOString(), sources: { linuxdo, cjx8 } };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    log(`抓取完成：LINUX DO ${linuxdo.ok ? linuxdo.count + ' 条' : '失败(' + linuxdo.error + ')'}` +
      `；超级线报 ${cjx8.ok ? cjx8.count + ' 条' : '失败(' + cjx8.error + ')'}`);
  } catch (e) {
    log('抓取异常：', e?.message || e);
  } finally {
    await browser.close().catch(() => {});
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url === '/health') {
    res.end(JSON.stringify({ ok: true, updatedAt: cache.updatedAt }));
  } else if (req.url === '/feed.json') {
    res.end(JSON.stringify(cache));
  } else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found, use /feed.json or /health' }));
  }
});

server.listen(PORT, async () => {
  log(`中转服务已启动，端口 ${PORT}，每 ${INTERVAL_MS / 1000} 秒抓一次`);
  if (process.argv.includes('--once')) {
    await scrapeAll();
    process.exit(0);
  }
  await scrapeAll();
  setInterval(scrapeAll, INTERVAL_MS);
});
