#!/usr/bin/env node
/**
 * 伺服器端抓 CoinGecko → 寫 crypto-data.json（給 futures-calc.html 直接讀）
 * ------------------------------------------------------------------
 * 為什麼這樣做：CoinGecko 免費版會對「瀏覽器」狂限流(429 + 無 CORS → Failed to fetch)。
 * 改由 GitHub Actions 在伺服器端定時抓（呼叫間隔拉開、可重試），把結果存成靜態 JSON，
 * 網頁只讀同源的本地檔 → 永遠不會限流、不會 Failed to fetch。同 VCP 的自動化模式。
 *
 * 環境變數（選用）：CG_DEMO_KEY = CoinGecko 免費 demo key（設了更穩，不設也能跑）
 * 輸出：repo 根目錄 crypto-data.json
 */
import { writeFileSync } from 'node:fs';

const KEY = process.env.CG_DEMO_KEY || '';
const BASE = 'https://api.coingecko.com/api/v3';
const PCP = 'price_change_percentage=7d,30d,200d,1y';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, { tries = 5 } = {}) {
  const url = new URL(BASE + path);
  if (KEY) url.searchParams.set('x_cg_demo_api_key', KEY);
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) {
        const wait = 5000 * (i + 1);
        console.error(`429 on ${path} → wait ${wait}ms (try ${i + 1}/${tries})`);
        await sleep(wait);
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
      return await r.json();
    } catch (e) {
      console.error(`err on ${path}: ${e.message} (try ${i + 1}/${tries})`);
      if (i === tries - 1) throw e;
      await sleep(4000 * (i + 1));
    }
  }
  throw new Error(`exhausted retries: ${path}`);
}

// 只留網頁要用的欄位，縮小檔案
const slim = (c) => ({
  id: c.id,
  symbol: c.symbol,
  market_cap: c.market_cap,
  fully_diluted_valuation: c.fully_diluted_valuation,
  total_volume: c.total_volume,
  price_change_percentage_24h: c.price_change_percentage_24h,
  price_change_percentage_7d_in_currency: c.price_change_percentage_7d_in_currency,
  price_change_percentage_30d_in_currency: c.price_change_percentage_30d_in_currency,
  price_change_percentage_200d_in_currency: c.price_change_percentage_200d_in_currency,
  price_change_percentage_1y_in_currency: c.price_change_percentage_1y_in_currency,
});

// 圖鑑(modal)會用到的 slug，補抓不在前 500 名的小幣
const GUIDE_SLUGS = [
  'ondo-finance','centrifuge','syrup','polymesh','plume','bittensor','render-token','fetch-ai',
  'virtual-protocol','near','monero','zcash','aleo','dash','decred','ethena','plasma','sky',
  'frax-share','usual','hyperliquid','aster-2','dydx-chain','gmx','jupiter-exchange-solana',
  'uma','gnosis','augur','azuro-protocol','helium','filecoin','akash-network','grass','uniswap',
  'aave','pendle','lido-dao','curve-dao-token','dogecoin','shiba-inu','pepe','dogwifcoin','bonk',
  'decentraland','the-sandbox','axie-infinity','immutable-x','gala','chainlink','pyth-network',
  'band-protocol','api3','tellor','binancecoin','okb','crypto-com-chain','bitget-token','leo-token',
  'cosmos','polkadot','kusama','thorchain','axelar','worldcoin-wld','ethereum-name-service','civic',
  'ordinals','sats-ordinals','blockstack','ripple','litecoin','bitcoin-cash','coti','metal',
  'bitcoin','ethereum','solana','avalanche-2',
];

async function main() {
  console.error(`fetch start${KEY ? ' (with demo key)' : ' (keyless)'}`);

  const global = await get('/global');
  await sleep(2500);

  const categories = await get('/coins/categories?order=market_cap_change_24h_desc');
  await sleep(2500);

  const page1 = await get(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&${PCP}`);
  await sleep(2500);

  const page2 = await get(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&${PCP}`);
  await sleep(2500);

  const guide = await get(`/coins/markets?vs_currency=usd&ids=${GUIDE_SLUGS.join(',')}&per_page=250&${PCP}`);

  const markets = [...(page1 || []), ...(page2 || [])].filter(Boolean).map(slim);
  const guideMarkets = (guide || []).filter(Boolean).map(slim);

  const out = {
    updated: new Date().toISOString(),
    global: { data: { market_cap_percentage: { btc: global?.data?.market_cap_percentage?.btc ?? null } } },
    categories: (categories || [])
      .filter((c) => c && c.market_cap > 1e9)
      .map((c) => ({ name: c.name, market_cap: c.market_cap, top_3_coins_id: c.top_3_coins_id || [] })),
    markets,
    guide: guideMarkets,
  };

  if (markets.length < 100) throw new Error(`markets too few (${markets.length}) — abort, keep old json`);

  writeFileSync('crypto-data.json', JSON.stringify(out));
  console.error(`done: ${markets.length} markets, ${out.categories.length} categories, ${guideMarkets.length} guide coins`);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
