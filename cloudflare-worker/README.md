# CoinGecko 反向代理（Cloudflare Worker）部署指南

目的：讓 `futures-calc.html` 的加密貨幣資料**永久不再「Failed to fetch」**。
免費、約 10 分鐘、不用裝任何東西、key 不外洩。

---

## 一次設定（約 10 分鐘）

### 步驟 1：拿一把免費的 CoinGecko Demo API key
1. 去 https://www.coingecko.com/en/api/pricing → 選 **Demo（免費）** → 註冊/登入
2. 進 **Developer Dashboard** → **Create new API key** → 複製那串 key（像 `CG-xxxxxxxx`）
   - 免費額度：30 次/分鐘、每月 1 萬次。配上 Worker 的 5 分鐘快取，綽綽有餘。

### 步驟 2：建立 Cloudflare Worker
1. 去 https://dash.cloudflare.com → 註冊/登入（免費帳號即可）
2. 左側 **Workers & Pages** → **Create** → **Create Worker**
3. 取個名字，例如 `crypto-cg` → **Deploy**（先部署一個預設的）
4. 點 **Edit code** → 把整個編輯器內容**刪光**，貼上本資料夾 `worker.js` 的全部內容 → **Deploy**

### 步驟 3：把 Demo key 設成環境變數（key 留在 server 端，不進網頁）
1. 在這個 Worker 頁面 → **Settings** → **Variables and Secrets**
2. **Add** → 類型選 **Secret**（或 Text 也行）→
   - Name：`CG_DEMO_KEY`
   - Value：貼上步驟 1 的 key
3. **Save / Deploy**

### 步驟 4：拿到 Worker 網址，填進網頁
1. Worker 頁面上方會有網址，像 `https://crypto-cg.你的帳號.workers.dev`
2. 開 `futures-calc.html`，找到這一行（檔案上方 script 內）：
   ```js
   var CG_PROXY='';
   ```
   改成（**結尾要加 `/v3`**）：
   ```js
   var CG_PROXY='https://crypto-cg.你的帳號.workers.dev/v3';
   ```
3. 存檔，推上 GitHub（`my-ai-skills` + `flashcard` 兩個 repo 都要推，live 頁面在 flashcard）。
   - 或把網址貼給 Claude，說「填進去」，由 Claude 改＋推。

完成。之後不用再管，CoinGecko 永遠不會限流。

---

## 驗證有沒有成功
- 部署後直接在瀏覽器開：
  `https://crypto-cg.你的帳號.workers.dev/v3/global`
  → 看到一坨 JSON（`{"data":{...}}`）就對了。
- 回 `futures-calc.html`，硬刷新（Ctrl+Shift+R），選幣篩子應穩定載入。
- 開瀏覽器 DevTools → Network，點任一請求看 response header `X-Proxy-Cache: HIT/MIT`
  → 證明快取生效。

## 運作原理（一句話）
網頁 → 你的 Worker（5 分鐘 edge 快取 + 自動補 key + 補 CORS）→ CoinGecko。
不論多少人開頁面，CoinGecko 每個端點每 5 分鐘只被打 1 次 → 永不觸發限流。

## 沒設 key 會怎樣？
Worker 照跑，只是退回 keyless（會限流）。快取仍在，比直連好，但建議還是設 key。
