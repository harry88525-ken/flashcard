/**
 * CoinGecko 反向代理 — Cloudflare Worker
 * ------------------------------------------------------------------
 * 為什麼存在：CoinGecko 免費 keyless API 每分鐘約 1-2 次就回 429，
 * 而且 429 回應不帶 CORS header → 瀏覽器只能丟「Failed to fetch」。
 *
 * 這支 Worker 解三件事：
 *   1) 把免費 demo API key 藏在 server 端（不寫進公開網頁，符合 no-key-in-public）
 *   2) edge 快取 5 分鐘 → 不論多少使用者，CoinGecko 每個端點每 5 分鐘只被打 1 次，永不限流
 *   3) 所有回應（含錯誤）都補上 CORS header → 不再出現假的「Failed to fetch」
 *
 * 路由：  https://<worker>/v3/<任何 CoinGecko 路徑>
 *   例：  /v3/coins/categories?order=market_cap_change_24h_desc
 *         → https://api.coingecko.com/api/v3/coins/categories?...（自動補 key）
 *
 * 設定：Cloudflare 後台 → Settings → Variables → 加一個 CG_DEMO_KEY（你的免費 demo key）
 *       沒設也能跑（退回 keyless，但會限流）。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== 'GET') {
      return new Response('Only GET', { status: 405, headers: CORS });
    }

    const url = new URL(request.url);
    // /v3/...  →  /api/v3/...   （只放行 /v3 開頭，避免被當開放代理濫用）
    if (!url.pathname.startsWith('/v3/')) {
      return new Response('Not found. Use /v3/<coingecko-path>', { status: 404, headers: CORS });
    }
    const target = new URL('https://api.coingecko.com/api' + url.pathname + url.search);
    if (env.CG_DEMO_KEY) target.searchParams.set('x_cg_demo_api_key', env.CG_DEMO_KEY);

    // edge 快取：以「不含 key 的網址」當 key，避免 key 進快取索引
    const cacheUrl = new URL(target);
    cacheUrl.searchParams.delete('x_cg_demo_api_key');
    const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
    const cache = caches.default;

    let cached = await cache.match(cacheKey);
    if (cached) {
      const r = new Response(cached.body, cached);
      Object.entries(CORS).forEach(([k, v]) => r.headers.set(k, v));
      r.headers.set('X-Proxy-Cache', 'HIT');
      return r;
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), { headers: { accept: 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'upstream fetch failed', detail: String(e) }),
        { status: 502, headers: { ...CORS, 'content-type': 'application/json' } });
    }

    const res = new Response(upstream.body, upstream);
    Object.entries(CORS).forEach(([k, v]) => res.headers.set(k, v));
    res.headers.set('X-Proxy-Cache', 'MISS');

    if (upstream.ok) {
      res.headers.set('Cache-Control', 'public, max-age=300'); // 5 分鐘 edge 快取
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
    } else {
      // 429 等錯誤不快取，但已帶 CORS，前端能讀到狀態碼自行退避
      res.headers.set('Cache-Control', 'no-store');
    }
    return res;
  },
};
