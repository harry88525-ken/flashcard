#!/usr/bin/env node
/**
 * 美股注意力儀表板資料收集器
 * 抓美股日線 → 算三個窗口的成交金額排行 → 寫 us-volume.json
 *   1d  = 最近一個交易日的成交金額（今天誰在爆量）
 *   7d  = 近 7 個交易日的平均每日成交金額
 *   21d = 近 21 個交易日的平均每日成交金額（約一個月）
 * 另外用 3 個月日線重建「近 30 個交易日的 top-40 排名歷史」，
 * 讓頁面能畫與前一日排名比的 ↑↓ 箭頭，不用 git 考古。
 * 每次執行都整份重建（冪等），首次回填與日常更新走同一條路。
 *
 * 資料源：Yahoo Finance chart v8（免金鑰、免 crumb，只需帶 User-Agent）。
 * 網頁 us.html 只讀這支靜態檔 → 瀏覽器不會被限流。
 */
import { writeFileSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOP_N = 40;        // 每窗口取前 40 名
const HISTORY_DAYS = 30; // 排名歷史保留 30 個交易日

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

// timestamp → 美東交易日 YYYY-MM-DD
const etDate = (t) => new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

async function chart(sym, tries = 4) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=3mo&interval=1d`;
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
        .map((t, k) => ({ date: etDate(t), close: q.close[k], vol: q.volume[k] }))
        .filter((x) => x.close != null && x.vol != null && x.vol > 0);
      // 同一天若出現兩筆（盤中 timestamp），留最後一筆
      const dedup = new Map();
      for (const x of rows) dedup.set(x.date, x);
      return { sym, name: meta.longName || meta.shortName || sym, rows: [...dedup.values()] };
    } catch (e) {
      if (i === tries - 1) { console.error(`skip ${sym}: ${e.message}`); return null; }
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

// 該檔截至 date（含）為止最後 n 個交易日的平均成交金額
function avgDollarVol(rows, uptoIdx, n) {
  const s = rows.slice(Math.max(0, uptoIdx + 1 - n), uptoIdx + 1);
  if (!s.length) return null;
  return s.reduce((a, x) => a + x.close * x.vol, 0) / s.length;
}

async function main() {
  const stocks = [];
  for (const sym of [...new Set(UNIVERSE)]) {
    const d = await chart(sym);
    if (d && d.rows.length >= 7) stocks.push(d);
    await sleep(250); // 禮貌節流
  }
  if (stocks.length < 30) throw new Error(`too few tickers (${stocks.length}) — abort`);

  // 全宇宙交易日 union，取最後 HISTORY_DAYS 天當評估日
  const allDates = [...new Set(stocks.flatMap((s) => s.rows.map((r) => r.date)))].sort();
  const evalDates = allDates.slice(-HISTORY_DAYS);
  const latestDate = evalDates[evalDates.length - 1];

  // 每檔建 date→index 查表
  for (const s of stocks) s.idx = new Map(s.rows.map((r, i) => [r.date, i]));

  // 對每個評估日算三窗口的排名（top-40 symbol 序列）
  const WINDOWS = { '1d': 1, '7d': 7, '21d': 21 };
  const history = {};
  let latestFull = null; // 最新一天的完整資料（含名稱/價格）

  for (const date of evalDates) {
    const day = {};
    const snap = {}; // 該日各檔統計，最新日要用
    for (const s of stocks) {
      const i = s.idx.get(date);
      if (i == null) continue;
      const prevClose = i > 0 ? s.rows[i - 1].close : null;
      snap[s.sym] = {
        sym: s.sym, name: s.name,
        last: +s.rows[i].close.toFixed(2),
        chg: prevClose ? +((s.rows[i].close / prevClose - 1) * 100).toFixed(1) : null, // 當日漲跌%
        dv: {},
      };
      for (const [w, n] of Object.entries(WINDOWS)) snap[s.sym].dv[w] = avgDollarVol(s.rows, i, n);
    }
    for (const w of Object.keys(WINDOWS)) {
      day[w] = Object.values(snap)
        .filter((x) => x.dv[w] != null)
        .sort((a, b) => b.dv[w] - a.dv[w])
        .slice(0, TOP_N)
        .map((x) => x.sym);
    }
    history[date] = day;
    if (date === latestDate) latestFull = snap;
  }

  // 最新一天的三個排行榜（完整欄位）
  const board = {};
  for (const w of Object.keys(WINDOWS)) {
    board[w] = history[latestDate][w].map((sym, i) => {
      const x = latestFull[sym];
      return { rank: i + 1, sym, name: x.name, last: x.last, dollar_vol: Math.round(x.dv[w]), chg: x.chg };
    });
  }

  const data = {
    updated: new Date().toISOString(),
    universe: stocks.length,
    latest_date: latestDate,
    note: '1d=最近交易日成交金額；7d/21d=近7/21個交易日平均每日成交金額；chg=當日漲跌%；history=近30交易日各窗口top-40排名(symbol序=排名)',
    '1d': board['1d'], '7d': board['7d'], '21d': board['21d'],
    history,
  };
  writeFileSync('us-volume.json', JSON.stringify(data));
  console.error(`done: ${stocks.length} tickers | ${latestDate} | 1d top3 ${board['1d'].slice(0, 3).map((x) => x.sym).join(',')} | 7d top3 ${board['7d'].slice(0, 3).map((x) => x.sym).join(',')} | history ${Object.keys(history).length} days`);
}
main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
