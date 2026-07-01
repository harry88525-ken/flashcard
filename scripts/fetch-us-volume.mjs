#!/usr/bin/env node
/**
 * 抓美股日線 → 算近7天/近30天平均日成交額(美元) → 排名 → 寫 us-volume.json
 * 資料源：Yahoo Finance chart v8（免金鑰、免 crumb，只需帶 User-Agent）。
 * 網頁 us.html 只讀這支靜態檔 → 瀏覽器不會被限流。
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 高流動性美股宇宙(大型股 + 熱門 + 主要 ETF)。成交額榜本來就由這些主導,先這樣、之後可擴。
const UNIVERSE = [
  'AAPL','MSFT','NVDA','GOOGL','GOOG','AMZN','META','TSLA','AVGO','ORCL','AMD','NFLX','ADBE','CRM','INTC',
  'CSCO','QCOM','TXN','AMAT','MU','INTU','NOW','PLTR','SMCI','ARM','MRVL','LRCX','KLAC','ON','MCHP','ANET',
  'DELL','TSM','ASML','WMT','COST','HD','MCD','NKE','SBUX','DIS','KO','PEP','PG','JPM','BAC','WFC','GS','MS',
  'C','BRK-B','V','MA','AXP','PYPL','SCHW','LLY','UNH','JNJ','PFE','MRK','ABBV','TMO','ISRG','XOM','CVX','COP',
  'OXY','SLB','BA','CAT','GE','HON','UPS','T','VZ','CMCSA','F','GM','RIVN','LCID','NIO','BABA','NU','GRAB',
  'GME','AMC','COIN','HOOD','SOFI','MARA','RIOT','MSTR','SNAP','UBER','ABNB','SHOP','ROKU','PLUG','CCL','AAL',
  'DAL','NCLH','PBR','VALE','ITUB','UAL','WBD','LYFT','DKNG','AFRM','CVNA','DASH','ZM','PINS','CRWD','PANW',
  'SNOW','NET','DDOG','XYZ','SPY','QQQ','IWM','DIA','VOO','VTI','ARKK','XLK','XLF','XLE','SMH','SOXL',
  'TQQQ','SQQQ','TSLL','NVDL','TLT','GLD','SLV','USO',
];

async function chart(sym, tries = 4) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2mo&interval=1d`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, accept: 'application/json' } });
      if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res || !res.timestamp) throw new Error('no data');
      const q = res.indicators.quote[0];
      const meta = res.meta;
      const rows = res.timestamp
        .map((t, k) => ({ close: q.close[k], vol: q.volume[k] }))
        .filter((x) => x.close != null && x.vol != null && x.vol > 0);
      return { sym, name: meta.longName || meta.shortName || sym, rows };
    } catch (e) {
      if (i === tries - 1) { console.error(`skip ${sym}: ${e.message}`); return null; }
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

function avgDollarVol(rows, n) {
  const s = rows.slice(-n);
  if (!s.length) return null;
  const sum = s.reduce((a, x) => a + x.close * x.vol, 0);
  return sum / s.length;
}
function pctChange(rows, n) {
  const s = rows.slice(-n);
  if (s.length < 2) return null;
  return (s[s.length - 1].close / s[0].close - 1) * 100;
}

async function main() {
  const out = [];
  for (const sym of [...new Set(UNIVERSE)]) {
    const d = await chart(sym);
    if (d && d.rows.length >= 7) {
      out.push({
        sym: d.sym,
        name: d.name,
        last: +d.rows[d.rows.length - 1].close.toFixed(2),
        dv7: avgDollarVol(d.rows, 7),
        dv30: avgDollarVol(d.rows, 21),
        chg7: pctChange(d.rows, 7),
        chg30: pctChange(d.rows, 21),
      });
    }
    await sleep(180);
  }
  if (out.length < 30) throw new Error(`too few tickers (${out.length}) — abort`);
  const top = (key, chgKey, n = 40) =>
    out
      .filter((x) => x[key] != null)
      .sort((a, b) => b[key] - a[key])
      .slice(0, n)
      .map((x, i) => ({ rank: i + 1, sym: x.sym, name: x.name, last: x.last, dollar_vol: Math.round(x[key]), chg: x[chgKey] == null ? null : +x[chgKey].toFixed(1) }));

  const data = { updated: new Date().toISOString(), universe: out.length, '7d': top('dv7', 'chg7'), '30d': top('dv30', 'chg30') };
  writeFileSync('us-volume.json', JSON.stringify(data));
  console.error(`done: ${out.length} tickers | 7d top1 ${data['7d'][0].sym} | 30d top1 ${data['30d'][0].sym}`);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
